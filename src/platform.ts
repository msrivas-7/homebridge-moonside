import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { MoonsideLampAccessory } from './platformAccessory.js';
import { ThemeSwitchAccessory } from './themeSwitchAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { MoonsideApiClient, type DeviceState, type ThemeDefinition } from './moonsideApi.js';
import { PluginLogger, type PluginLogLevel } from './logger.js';

export interface MoonsideDeviceConfig {
  deviceId: string;
  name: string;
}

export interface MoonsideDeviceConfig {
  name: string;
  deviceId: string;
}

export interface MoonsidePlatformConfig extends PlatformConfig {
  email: string;
  password: string;
  pollingInterval?: number;
  enablePolling?: boolean;
  firebaseApiKey?: string;
  logLevel?: PluginLogLevel;
  themeSwitches?: string[];
}

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class MoonsideCloudPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: Map<string, PlatformAccessory> = new Map();

  public readonly apiClient?: MoonsideApiClient;
  public readonly pollingInterval: number;
  public readonly enablePolling: boolean;
  public readonly logger: PluginLogger;
  private readonly configured: boolean;
  private readonly accessoriesByDeviceId: Map<string, MoonsideLampAccessory> = new Map();
  private readonly themeAccessories: Map<string, ThemeSwitchAccessory> = new Map();
  private readonly themeSwitchNames: string[];
  private streamUnsubscribe?: () => void;
  private themeDefinitionsCache?: ThemeDefinition[];

  constructor(
    public readonly log: Logging,
    public readonly config: MoonsidePlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.logger = new PluginLogger(log, this.resolveLogLevel(config.logLevel));

    this.pollingInterval = Math.max(5, config.pollingInterval ?? 60) * 1000;
    this.enablePolling = config.enablePolling ?? false;
    this.themeSwitchNames = (config.themeSwitches ?? []).map(name => name.trim()).filter(name => !!name);
    this.configured = Boolean(config.email && config.password);

    if (!this.configured) {
      this.logger.warn('Moonside Cloud plugin is not configured. Please provide your Moonside email and password.');
    } else {
      this.apiClient = new MoonsideApiClient(
        this.logger,
        config.email,
        config.password,
        config.firebaseApiKey,
      );
    }

    this.logger.debug('Finished initializing platform: %s', this.config.name ?? PLATFORM_NAME);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      this.logger.debug('Executed didFinishLaunching callback');
      void this.discoverDevices();
    });

    this.api.on('shutdown', () => {
      this.streamUnsubscribe?.();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to set up event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.logger.debug('Loading accessory from cache: %s', accessory.displayName);

    if (accessory.context?.isThemeAccessory && accessory.context.device?.deviceId) {
      const device: MoonsideDeviceConfig = {
        deviceId: accessory.context.device.deviceId,
        name: accessory.context.device.name ?? accessory.displayName.replace(/ - Themes$/, ''),
      };
      const handler = new ThemeSwitchAccessory(this, accessory, device);
      this.themeAccessories.set(device.deviceId, handler);
    }

    // add the restored accessory to the accessories cache, so we can track if it has already been registered
    this.accessories.set(accessory.UUID, accessory);
  }

  async discoverDevices() {
    if (!this.configured || !this.apiClient) {
      this.logger.warn('Skipping Moonside discovery because the plugin is not configured.');
      return;
    }

    try {
      const devices = await this.apiClient.fetchDevices();
      const themeDefinitions = await this.resolveThemeDefinitions();
      await this.syncDeviceSnapshot(devices, themeDefinitions);
      await this.startRealtimeStream(true);
    } catch (error) {
      this.logger.error('Failed to discover Moonside lamps: %s', error instanceof Error ? error.message : String(error));
    }
  }

  private async registerOrUpdateAccessory(deviceId: string, state?: DeviceState): Promise<string> {
    const name = state?.deviceName ?? deviceId;
    const uuid = this.api.hap.uuid.generate(deviceId);

    const existingAccessory = this.accessories.get(uuid);

    if (existingAccessory) {
      let handler = this.accessoriesByDeviceId.get(deviceId);
      if (!handler) {
        handler = new MoonsideLampAccessory(this, existingAccessory, { deviceId, name }, state);
        this.accessoriesByDeviceId.set(deviceId, handler);
      } else if (state) {
        handler.updateFromCloud(state);
      }
      existingAccessory.context.device = { deviceId, name };
      this.api.updatePlatformAccessories([existingAccessory]);
    } else {
      this.logger.debug('Adding new accessory: %s', name);
      const accessory = new this.api.platformAccessory(name, uuid);
      accessory.context.device = { deviceId, name };

      const handler = new MoonsideLampAccessory(this, accessory, { deviceId, name }, state);
      this.accessoriesByDeviceId.set(deviceId, handler);

      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(accessory.UUID, accessory);
    }
    return name;
  }

  private removeAccessory(deviceId: string, accessory: PlatformAccessory) {
    this.logger.debug('Removing accessory for device %s', accessory.displayName);
    this.accessoriesByDeviceId.get(deviceId)?.destroy();
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.accessories.delete(accessory.UUID);
    this.accessoriesByDeviceId.delete(deviceId);
    this.removeThemeAccessory(deviceId);
  }

  private async startRealtimeStream(skipInitialRefresh = false) {
    if (!this.apiClient) {
      return;
    }

    let skipRefresh = skipInitialRefresh;

    this.streamUnsubscribe?.();
    this.streamUnsubscribe = await this.apiClient.subscribeToDeviceUpdates(async (deviceId, update) => {
      if (update === null) {
        const uuid = this.api.hap.uuid.generate(deviceId);
        const accessory = this.accessories.get(uuid);
        if (accessory) {
          this.removeAccessory(deviceId, accessory);
        }
        return;
      }

      const handler = this.accessoriesByDeviceId.get(deviceId);
      if (handler) {
        handler.updateFromCloud(update);
        await this.registerOrUpdateThemeAccessory(
          deviceId,
          handler.getDeviceName(),
          this.themeDefinitionsCache,
        );
      } else {
        const deviceName = await this.registerOrUpdateAccessory(deviceId, update);
        await this.registerOrUpdateThemeAccessory(deviceId, deviceName, this.themeDefinitionsCache);
      }
    }, (error) => {
      this.logger.warn('Moonside realtime stream warning: %s', error instanceof Error ? error.message : String(error));
    }, async () => {
      if (skipRefresh) {
        skipRefresh = false;
        return;
      }
      await this.refreshDevicesFromCloud();
    });
  }

  private async syncDeviceSnapshot(devices: Map<string, DeviceState>, themeDefinitions: ThemeDefinition[] | undefined) {
    const seenDeviceIds: string[] = [];

    for (const [deviceId, state] of devices.entries()) {
      if (!state) {
        continue;
      }
      const deviceName = await this.registerOrUpdateAccessory(deviceId, state);
      await this.registerOrUpdateThemeAccessory(deviceId, deviceName, themeDefinitions);
      seenDeviceIds.push(deviceId);
    }

    for (const accessory of this.accessories.values()) {
      const cachedDeviceId = accessory.context.device?.deviceId as string | undefined;
      if (cachedDeviceId && !seenDeviceIds.includes(cachedDeviceId)) {
        this.removeAccessory(cachedDeviceId, accessory);
      }
    }
  }

  private async refreshDevicesFromCloud() {
    if (!this.apiClient) {
      return;
    }
    const devices = await this.apiClient.fetchDevices();
    const themeDefinitions = await this.resolveThemeDefinitions();
    await this.syncDeviceSnapshot(devices, themeDefinitions);
  }

  private async registerOrUpdateThemeAccessory(deviceId: string, deviceName: string, themes: ThemeDefinition[] | undefined) {
    // A failed catalog request is not an empty catalog. Preserve cached services.
    if (themes === undefined) {
      return;
    }
    const uuid = this.api.hap.uuid.generate(`${deviceId}:themes`);
    const existingAccessory = this.accessories.get(uuid);
    const shouldExist = themes.length > 0;

    if (!shouldExist) {
      if (existingAccessory) {
        this.removeThemeAccessory(deviceId);
      }
      return;
    }

    if (existingAccessory) {
      let handler = this.themeAccessories.get(deviceId);
      if (!handler) {
        handler = new ThemeSwitchAccessory(this, existingAccessory, { deviceId, name: deviceName }, themes);
        this.themeAccessories.set(deviceId, handler);
      } else {
        handler.updateDevice({ deviceId, name: deviceName });
        handler.updateThemes(themes);
      }
      existingAccessory.context.device = { deviceId, name: deviceName };
      existingAccessory.context.isThemeAccessory = true;
      this.api.updatePlatformAccessories([existingAccessory]);
      return;
    }

    const accessory = new this.api.platformAccessory(`${deviceName} - Themes`, uuid);
    accessory.context.device = { deviceId, name: deviceName };
    accessory.context.isThemeAccessory = true;

    const handler = new ThemeSwitchAccessory(this, accessory, { deviceId, name: deviceName }, themes);
    this.themeAccessories.set(deviceId, handler);

    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.accessories.set(accessory.UUID, accessory);
  }

  private removeThemeAccessory(deviceId: string) {
    const handler = this.themeAccessories.get(deviceId);
    const uuid = this.api.hap.uuid.generate(`${deviceId}:themes`);
    const accessory = this.accessories.get(uuid);

    handler?.destroy();
    if (accessory) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.delete(uuid);
    }
    this.themeAccessories.delete(deviceId);
  }

  private refreshThemeAccessories(definitions: ThemeDefinition[]) {
    if (!definitions.length) {
      const deviceIds = Array.from(this.themeAccessories.keys());
      for (const id of deviceIds) {
        this.removeThemeAccessory(id);
      }
      return;
    }

    for (const handler of this.themeAccessories.values()) {
      handler.updateThemes(definitions);
    }
  }

  private async resolveThemeDefinitions(): Promise<ThemeDefinition[] | undefined> {
    if (!this.apiClient || !this.themeSwitchNames.length) {
      this.themeDefinitionsCache = [];
      this.refreshThemeAccessories([]);
      return [];
    }

    if (this.themeDefinitionsCache) {
      return this.themeDefinitionsCache;
    }

    try {
      const library = await this.apiClient.fetchThemeLibrary();
      const selected: ThemeDefinition[] = [];

      for (const themeName of this.themeSwitchNames) {
        const def = library.get(themeName.toLowerCase());
        if (def) {
          selected.push(def);
        } else {
          this.logger.warn('Configured theme "%s" was not found in the Moonside catalog.', themeName);
        }
      }

      this.themeDefinitionsCache = selected;
      this.refreshThemeAccessories(selected);
      return selected;
    } catch (error) {
      this.logger.error(
        'Failed to load theme catalog: %s',
        error instanceof Error ? error.message : String(error),
      );
      return undefined;
    }
  }

  private resolveLogLevel(level?: string): PluginLogLevel {
    if (level === 'debug' || level === 'warning' || level === 'none') {
      return level;
    }
    return 'warning';
  }
}
