import { catalogChoices, validateThemeSetup, type ThemeSetup } from './themeOnboarding.js';
import { ThemeCatalogControl } from './themeCatalogControl.js';
import { join } from 'node:path';
import { FavoriteThemeAccessory, themeFavoriteId } from './favoriteThemeAccessory.js';
import { ThemeFavoritesControl } from './themeFavoritesControl.js';
import { ThemeFavoritesStore } from './themeFavoritesStore.js';
import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { isValidDeviceId } from './deviceIdentity.js';
import { MoonsideLampAccessory } from './platformAccessory.js';
import { ThemeSwitchAccessory } from './themeSwitchAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { MoonsideApiClient, type DeviceState, type ThemeDefinition } from './moonsideApi.js';
import { PluginLogger, type PluginLogLevel } from './logger.js';

export interface MoonsideDeviceConfig {
  deviceId: string;
  name: string;
}

export interface MoonsidePlatformConfig extends PlatformConfig {
  email: string;
  password: string;
  pollingInterval?: number;
  enablePolling?: boolean;
  firebaseApiKey?: string;
  logLevel?: PluginLogLevel;
  themeSwitches?: string[];
  themePicker?: boolean;
  themeSetup?: ThemeSetup;
  retainLegacyThemeSwitches?: boolean;
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
  private themeSetup?: ThemeSetup;
  private legacyDefinitions: ThemeDefinition[] = [];
  private readonly themeSwitchNames: string[];
  private favoriteAccessories = new Map<string, FavoriteThemeAccessory>();
  private favoriteControls = new Map<string, ThemeFavoritesControl>();
  private configuredThemes = new Map<string, ThemeDefinition[]>();
  private favoriteStore?: ThemeFavoritesStore;
  private catalogs = new Map<string, ThemeCatalogControl>();
  private favoriteSnapshots = new Map<string, string>();
  private controlQueue = new Map<string, Promise<void>>();
  private pendingControls = new Map<string, number>();
  private lastTheme = new Map<string, string>();
  private streamUnsubscribe?: () => void;
  private themeDefinitionsCache?: ThemeDefinition[];

  constructor(
    public readonly log: Logging,
    public readonly config: MoonsidePlatformConfig,
    public readonly api: API,
  ) {
    if (config.themePicker) {
      this.favoriteStore = new ThemeFavoritesStore(join(api.user.storagePath(), 'moonside-theme-favorites'));
    }
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.logger = new PluginLogger(log, this.resolveLogLevel(config.logLevel));

    if (config.themeSetup) {
      try {
        if (!config.themePicker) {
          throw new Error('Theme setup requires the theme picker.');
        }
        this.themeSetup = validateThemeSetup(config.themeSetup);
      } catch (error) {
        this.logger.error('%s', error instanceof Error ? error.message : String(error));
      }
    }

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
      for (const accessory of this.accessories.values()) {
        if (accessory.context?.isFavoriteThemeAccessory
          && !this.themesEnabledFor(accessory.context.device?.deviceId)) {
          this.removeFavoriteAccessory(accessory.context.device.deviceId);
        }
      }
      void this.discoverDevices();
    });

    this.api.on('shutdown', () => {
      this.streamUnsubscribe?.();
      for (const catalog of this.catalogs.values()) {
        catalog.destroy();
      }
      for (const handler of this.favoriteAccessories.values()) {
        handler.destroy();
      }
      for (const control of this.favoriteControls.values()) {
        control.destroy();
      }
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to set up event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.logger.debug('Loading accessory from cache: %s', accessory.displayName);

    if (accessory.context?.isFavoriteThemeAccessory && isValidDeviceId(accessory.context.device?.deviceId)) {
      const device = accessory.context.device as MoonsideDeviceConfig;
      this.favoriteAccessories.set(device.deviceId, new FavoriteThemeAccessory(this, accessory, device));
    }

    if (accessory.context?.isThemeAccessory && isValidDeviceId(accessory.context.device?.deviceId)) {
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
    this.favoriteControls.get(deviceId)?.destroy();
    this.favoriteControls.delete(deviceId);
    this.configuredThemes.delete(deviceId);
    this.lastTheme.delete(deviceId);
    this.catalogs.get(deviceId)?.destroy();
    this.catalogs.delete(deviceId);
    this.removeFavoriteAccessory(deviceId);
  }

  private async startRealtimeStream(skipInitialRefresh = false) {
    if (!this.apiClient) {
      return;
    }

    let skipRefresh = skipInitialRefresh;

    this.streamUnsubscribe?.();
    this.streamUnsubscribe = await this.apiClient.subscribeToDeviceUpdates(async (deviceId, update) => {
      if (!isValidDeviceId(deviceId)) {
        return;
      }
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
      if (!state || !isValidDeviceId(deviceId)) {
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
    // A catalog failure must not delete the saved native favorite controls.
    if (themes === undefined) {
      return;
    }
    try {
      const plan = this.themeSetup?.lamps.find(lamp => lamp.deviceId === deviceId);
      const wanted = this.themeSetup && this.themeSetup.mode !== 'all'
        ? new Set(plan?.selectedIds ?? this.themeSetup.selectedIds)
        : plan?.selectedIds ? new Set(plan.selectedIds) : undefined;
      const deviceThemes = wanted ? themes.filter(theme => wanted.has(themeFavoriteId(theme.id))) : themes;
      await this.syncFavoriteControls(deviceId, deviceName, deviceThemes);
    } catch (error) {
      // Keep ordinary controls, cached favorites and other lamps available while settings recover.
      this.logger.error('Failed to update theme favorites for %s: %s', deviceName,
        error instanceof Error ? error.message : String(error));
    }
    if (this.themeSetup) {
      themes = this.legacyDefinitions;
    }
    const uuid = this.api.hap.uuid.generate(`${deviceId}:themes`);
    const existingAccessory = this.accessories.get(uuid);
    // Existing installations retain legacy automation targets unless explicitly disabled.
    const retainLegacy = this.config.retainLegacyThemeSwitches ?? !!existingAccessory;
    const shouldExist = themes.length > 0 && (!this.config.themePicker || retainLegacy);

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

  public observeControl(deviceId: string, command: string, selectedThemeId?: string) {
    const matches = this.configuredThemes.get(deviceId)?.filter(item => item.controlData === command) ?? [];
    const knownId = selectedThemeId ?? this.lastTheme.get(deviceId);
    // Cloud echoes contain only the command, which can be shared by multiple themes.
    const theme = matches.find(item => themeFavoriteId(item.id) === knownId)
      ?? (matches.length === 1 ? matches[0] : undefined);
    const favorites = this.favoriteAccessories.get(deviceId);
    if (theme) {
      this.lastTheme.set(deviceId, themeFavoriteId(theme.id));
      favorites?.setActiveTheme(themeFavoriteId(theme.id));
    } else if (/^LEDOFF$/i.test(command)) {
      favorites?.setActiveTheme(undefined);
    } else if (/^LEDON$/i.test(command)) {
      favorites?.setActiveTheme(this.lastTheme.get(deviceId));
    } else if (!/^BRIGH/i.test(command)) {
      this.lastTheme.delete(deviceId);
      favorites?.setActiveTheme(undefined);
    }
  }

  public async sendControl(deviceId: string, command: string, selectedThemeId?: string) {
    if (!isValidDeviceId(deviceId) || !this.apiClient) {
      throw new Error('Lamp is unavailable');
    }
    const pending = this.pendingControls.get(deviceId) ?? 0;
    if (pending >= 8) {
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.RESOURCE_BUSY);
    }
    const deadline = Date.now() + 8000;
    const lamp = this.accessoriesByDeviceId.get(deviceId);
    lamp?.prepareControl(command);
    this.pendingControls.set(deviceId, pending + 1);
    const previous = this.controlQueue.get(deviceId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error('Lamp command expired while waiting');
      }
      await this.apiClient!.sendControl(deviceId, command, remaining);
      if (lamp) {
        lamp.updateFromCloud({ controlData: command }, selectedThemeId);
      } else {
        this.observeControl(deviceId, command, selectedThemeId);
      }
    });
    this.controlQueue.set(deviceId, operation);
    try {
      await operation;
    } finally {
      const count = this.pendingControls.get(deviceId)! - 1;
      if (count) {
        this.pendingControls.set(deviceId, count);
      } else {
        this.pendingControls.delete(deviceId);
      }
      if (this.controlQueue.get(deviceId) === operation) {
        this.controlQueue.delete(deviceId);
      }
    }
  }

  public themesEnabledFor(deviceId: string) {
    return !!this.config.themePicker && (!this.themeSetup
      || this.themeSetup.lamps.some(lamp => lamp.deviceId === deviceId && lamp.enabled !== false));
  }

  public async stopTheme(deviceId: string) {
    await this.sendControl(deviceId, 'LEDOFF');
  }

  public async applyTheme(deviceId: string, theme: ThemeDefinition) {
    await this.sendControl(deviceId, theme.controlData, themeFavoriteId(theme.id));
  }

  private async syncFavoriteControls(deviceId: string, deviceName: string, themes: ThemeDefinition[]) {
    if (!this.favoriteStore || !isValidDeviceId(deviceId)) {
      return;
    }
    if (!this.themesEnabledFor(deviceId)) {
      this.removeFavoriteAccessory(deviceId);
      return;
    }
    const source = this.accessories.get(this.api.hap.uuid.generate(deviceId))?.getService(this.Service.Lightbulb);
    if (!source) {
      return;
    }
    let catalog = this.catalogs.get(deviceId);
    if (!catalog) {
      catalog = new ThemeCatalogControl(this, source, deviceId);
      this.catalogs.set(deviceId, catalog);
    }
    catalog.update(themes);
    this.configuredThemes.set(deviceId, themes);
    const plan = this.themeSetup?.lamps.find(lamp => lamp.deviceId === deviceId);
    if (plan && this.themeSetup) {
      try {
        await this.favoriteStore.applySetup(deviceId, this.themeSetup.id, plan.ids, plan.expectedRevision,
          new Set(themes.map(theme => themeFavoriteId(theme.id))));
      } catch (error) {
        this.logger.warn('Could not apply saved setup favorites: %s', error instanceof Error ? error.message : String(error));
      }
    }
    let control = this.favoriteControls.get(deviceId);
    if (!control) {
      control = new ThemeFavoritesControl(this, source, deviceId, this.favoriteStore, async state => {
        const currentName = this.accessoriesByDeviceId.get(deviceId)?.getDeviceName() ?? deviceName;
        const configured = this.configuredThemes.get(deviceId) ?? [];
        const visible = configured.filter(theme => state.ids.includes(themeFavoriteId(theme.id)));
        const snapshot = JSON.stringify([currentName, state.ids, visible]);
        if (this.favoriteSnapshots.get(deviceId) === snapshot) {
          return;
        }
        if (!state.ids.length) {
          this.removeFavoriteAccessory(deviceId);
          this.favoriteSnapshots.set(deviceId, snapshot);
          return;
        }
        let handler = this.favoriteAccessories.get(deviceId);
        if (!handler) {
          const uuid = this.api.hap.uuid.generate(`${deviceId}:theme-favorites`);
          const accessory = this.accessories.get(uuid)
            ?? new this.api.platformAccessory(`${currentName} - Favorites`, uuid);
          accessory.context.device = { deviceId, name: currentName };
          accessory.context.isFavoriteThemeAccessory = true;
          handler = new FavoriteThemeAccessory(this, accessory, { deviceId, name: currentName });
          handler.updateThemes(configured, state.ids);
          this.favoriteAccessories.set(deviceId, handler);
          if (!this.accessories.has(uuid)) {
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            this.accessories.set(uuid, accessory);
          }
        } else {
          handler.updateThemes(configured, state.ids);
        }
        const command = this.accessoriesByDeviceId.get(deviceId)?.getLastControl();
        if (command) {
          this.observeControl(deviceId, command);
        }
        handler.setActiveTheme(source.getCharacteristic(this.Characteristic.On).value
          ? this.lastTheme.get(deviceId) : undefined);
        this.api.updatePlatformAccessories([handler.accessory]);
        this.favoriteSnapshots.set(deviceId, snapshot);
      });
      this.favoriteControls.set(deviceId, control);
    }
    this.favoriteAccessories.get(deviceId)?.updateDevice({ deviceId, name: deviceName });
    await control.updateConfiguredIds(themes.map(theme => themeFavoriteId(theme.id)));
  }

  private removeFavoriteAccessory(deviceId: string) {
    const handler = this.favoriteAccessories.get(deviceId);
    const uuid = this.api.hap.uuid.generate(`${deviceId}:theme-favorites`);
    const accessory = this.accessories.get(uuid);
    handler?.destroy();
    if (accessory) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.delete(uuid);
    }
    this.favoriteAccessories.delete(deviceId);
    this.favoriteSnapshots.delete(deviceId);
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
    if (!this.apiClient || (!this.themeSwitchNames.length && !this.themeSetup)) {
      this.themeDefinitionsCache = [];
      this.refreshThemeAccessories([]);
      return [];
    }

    if (this.themeDefinitionsCache) {
      return this.themeDefinitionsCache;
    }

    try {
      const library = await this.apiClient.fetchThemeLibrary(undefined, { qualifiedLabels: !this.themeSetup });
      const selected: ThemeDefinition[] = [];

      for (const themeName of this.themeSwitchNames) {
        const def = library.get(themeName.trim().replace(/\s+/g, ' ').toLowerCase());
        if (def) {
          if (!selected.some(theme => theme.id === def.id)) {
            selected.push(def);
          }
        } else {
          this.logger.warn('Configured theme "%s" was not found in the Moonside catalog.', themeName);
        }
      }

      this.legacyDefinitions = selected;
      if (this.themeSetup) {
        const choices = catalogChoices(library);
        const wanted = new Set(this.themeSetup.mode === 'all' ? choices.map(theme => theme.id) : this.themeSetup.selectedIds);
        for (const plan of this.themeSetup.lamps) {
          if (plan.enabled !== false) {
            plan.selectedIds?.forEach(id => wanted.add(id));
          }
        }
        const unique = new Map([...library.values()].map(theme => [themeFavoriteId(theme.id), theme]));
        this.themeDefinitionsCache = [...unique].filter(([id]) => wanted.has(id)).map(([, theme]) => theme);
      } else {
        this.themeDefinitionsCache = selected;
      }
      this.refreshThemeAccessories(selected);
      return this.themeDefinitionsCache;
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
