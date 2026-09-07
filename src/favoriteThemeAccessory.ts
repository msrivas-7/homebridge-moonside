import { MAX_THEME_FAVORITES } from './themeFavoritesStore.js';
import { setThemePickerMetadata } from './themePickerMetadata.js';
import { createHash } from 'node:crypto';
import type { PlatformAccessory, Service } from 'homebridge';
import type { MoonsideCloudPlatform, MoonsideDeviceConfig } from './platform.js';
import type { ThemeDefinition } from './moonsideApi.js';

export function themeFavoriteId(id: string): string {
  return createHash('sha256').update(id).digest('hex');
}

interface PendingSelection {
  id: string;
  value: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class FavoriteThemeAccessory {
  private services = new Map<string, Service>();
  private themes = new Map<string, ThemeDefinition>();
  private active?: string;
  private pending: PendingSelection[] = [];
  private timer?: NodeJS.Timeout;
  private sending = false;
  private stopped = false;

  constructor(
    private readonly platform: MoonsideCloudPlatform,
    public readonly accessory: PlatformAccessory,
    private device: MoonsideDeviceConfig,
  ) {
    accessory.category = platform.api.hap.Categories.SWITCH;
    accessory.getService(platform.Service.AccessoryInformation)!
      .setCharacteristic(platform.Characteristic.Manufacturer, 'Moonside')
      .setCharacteristic(platform.Characteristic.Model, 'Theme Favorites')
      .setCharacteristic(platform.Characteristic.SerialNumber, `${device.deviceId}-favorites`);
    for (const service of accessory.services) {
      if (service.UUID === platform.Service.Switch.UUID && service.subtype) {
        this.services.set(service.subtype, service);
        this.bind(service.subtype, service);
      }
    }
    this.updateDevice(device);
    this.setActiveTheme(undefined);
  }

  updateDevice(device: MoonsideDeviceConfig) {
    this.device = device;
    this.accessory.displayName = `${device.name} - Favorites`;
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Name, this.accessory.displayName);
  }

  updateThemes(definitions: ThemeDefinition[], favoriteIds: string[]) {
    const favorites = new Set(favoriteIds);
    const next = new Map(definitions.filter(theme => favorites.has(themeFavoriteId(theme.id)))
      .map(theme => [themeFavoriteId(theme.id), theme]));
    if (next.size > MAX_THEME_FAVORITES) {
      throw new Error(`At most ${MAX_THEME_FAVORITES} favorite themes are supported per lamp`);
    }
    this.themes = next;
    for (const [id, service] of this.services) {
      if (!next.has(id)) {
        this.accessory.removeService(service);
        this.services.delete(id);
      }
    }
    for (const [id, theme] of next) {
      let service = this.services.get(id);
      if (!service) {
        service = this.accessory.addService(this.platform.Service.Switch, theme.name, id);
        this.services.set(id, service);
        this.bind(id, service);
      }
      setThemePickerMetadata(this.platform, service, this.device.deviceId, theme.id, 'favorite');
      service.displayName = theme.name;
      service.setCharacteristic(this.platform.Characteristic.Name, theme.name);
      service.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
      service.setCharacteristic(this.platform.Characteristic.ConfiguredName, theme.name);
    }
    this.setActiveTheme(this.active && next.has(this.active) ? this.active : undefined);
  }

  setActiveTheme(id: string | undefined) {
    this.active = id;
    for (const [key, service] of this.services) {
      service.updateCharacteristic(this.platform.Characteristic.On, key === id);
    }
  }

  private bind(id: string, service: Service) {
    service.getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.active === id)
      .onSet(value => {
        if (this.stopped || !this.themes.has(id)) {
          throw this.error('SERVICE_COMMUNICATION_FAILURE');
        }
        if (this.sending) {
          throw this.error('RESOURCE_BUSY');
        }
        return new Promise<void>((resolve, reject) => {
          this.pending.push({ id, value: !!value, resolve, reject });
          this.timer ??= setTimeout(() => void this.flush(), 50);
        });
      });
  }

  private error(status: 'SERVICE_COMMUNICATION_FAILURE' | 'RESOURCE_BUSY' | 'INVALID_VALUE_IN_REQUEST') {
    const codes = {
      SERVICE_COMMUNICATION_FAILURE: this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      RESOURCE_BUSY: this.platform.api.hap.HAPStatus.RESOURCE_BUSY,
      INVALID_VALUE_IN_REQUEST: this.platform.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST,
    };
    return new this.platform.api.hap.HapStatusError(codes[status]);
  }

  private async flush() {
    this.timer = undefined;
    const batch = this.pending;
    this.pending = [];
    const choices = [...new Set(batch.filter(write => write.value).map(write => write.id))];
    // A burst of multiple On writes does not identify a single intended theme.
    if (choices.length > 1 || batch.some(write => !this.themes.has(write.id))) {
      batch.forEach(write => write.reject(this.error('INVALID_VALUE_IN_REQUEST')));
      return;
    }
    this.sending = true;
    try {
      if (choices.length) {
        const theme = this.themes.get(choices[0])!;
        await this.platform.applyTheme(this.device.deviceId, theme);
      } else if (batch.some(write => write.id === this.active)) {
        await this.platform.stopTheme(this.device.deviceId);
      }
      batch.forEach(write => write.resolve());
    } catch {
      batch.forEach(write => write.reject(this.error('SERVICE_COMMUNICATION_FAILURE')));
    } finally {
      this.sending = false;
    }
  }

  destroy() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.pending.splice(0).forEach(write => write.reject(this.error('SERVICE_COMMUNICATION_FAILURE')));
  }
}
