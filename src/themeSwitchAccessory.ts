import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { MoonsideCloudPlatform, MoonsideDeviceConfig } from './platform.js';
import type { ThemeDefinition } from './moonsideApi.js';

export class ThemeSwitchAccessory {
  private readonly services: Map<string, Service> = new Map();
  private themes: ThemeDefinition[] = [];

  constructor(
    private readonly platform: MoonsideCloudPlatform,
    private readonly accessory: PlatformAccessory,
    private device: MoonsideDeviceConfig,
    initialThemes?: ThemeDefinition[],
  ) {
    this.accessory.category = this.platform.api.hap.Categories.OUTLET;

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Moonside')
      .setCharacteristic(this.platform.Characteristic.Model, `${this.device.deviceId}-themes`)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, `${this.device.deviceId}-themes`);

    this.updateAccessoryName();
    this.rehydrateExistingServiceMap();
    if (initialThemes !== undefined) {
      this.updateThemes(initialThemes);
    }
  }

  updateDevice(device: MoonsideDeviceConfig) {
    this.device = device;
    this.updateAccessoryName();
  }

  private rehydrateExistingServiceMap() {
    const outletUuid = this.platform.Service.Outlet.UUID;
    for (const service of this.accessory.services) {
      if (service.UUID !== outletUuid) {
        continue;
      }
      const subtype = service.subtype;
      if (subtype) {
        this.services.set(subtype, service);
        this.bindThemeService(subtype, service);
        service.updateCharacteristic(this.platform.Characteristic.On, false);
        service.updateCharacteristic(this.platform.Characteristic.OutletInUse, false);
      }
    }
  }

  updateThemes(definitions: ThemeDefinition[]) {
    this.themes = definitions ?? [];
    const desiredIds = new Set(this.themes.map(theme => theme.id));

    for (const [id, service] of this.services.entries()) {
      if (!desiredIds.has(id)) {
        this.accessory.removeService(service);
        this.services.delete(id);
      } else {
        service.updateCharacteristic(this.platform.Characteristic.On, false);
        service.updateCharacteristic(this.platform.Characteristic.OutletInUse, false);
      }
    }

    for (const theme of this.themes) {
      let service = this.services.get(theme.id);
      if (!service) {
        service = this.accessory.addService(this.platform.Service.Outlet, theme.name, theme.id);
        this.services.set(theme.id, service);
      }

      this.bindThemeService(theme.id, service);
      this.applyServiceName(service, theme.name);
      service.updateCharacteristic(this.platform.Characteristic.On, false);
      service.updateCharacteristic(this.platform.Characteristic.OutletInUse, false);
    }
  }

  private bindThemeService(id: string, service: Service) {
    service.getCharacteristic(this.platform.Characteristic.On).onSet(value => {
      const theme = this.themes.find(definition => definition.id === id);
      if (!theme) {
        if (value) {
          throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        return;
      }
      return this.handleThemeSet(theme, service, value);
    });
  }

  public destroy() {
    // nothing to dispose currently
  }

  private updateAccessoryName() {
    const name = `${this.device.name} - Themes`;
    this.accessory.displayName = name;
    const info = this.accessory.getService(this.platform.Service.AccessoryInformation);
    info?.setCharacteristic(this.platform.Characteristic.Name, name);
  }

  private async handleThemeSet(theme: ThemeDefinition, service: Service, value: CharacteristicValue) {
    if (!value) {
      service.updateCharacteristic(this.platform.Characteristic.OutletInUse, false);
      return;
    }

    if (!this.platform.apiClient) {
      this.platform.logger.warn('API client not ready, cannot trigger theme %s', theme.name);
      service.updateCharacteristic(this.platform.Characteristic.On, false);
      service.updateCharacteristic(this.platform.Characteristic.OutletInUse, false);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    try {
      await this.platform.apiClient.sendControl(this.device.deviceId, theme.controlData);
    } catch (error) {
      this.platform.logger.error(
        'Failed to trigger theme %s for %s: %s',
        theme.name,
        this.device.name,
        error instanceof Error ? error.message : String(error),
      );
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    setTimeout(() => {
      service.updateCharacteristic(this.platform.Characteristic.On, false);
      service.updateCharacteristic(this.platform.Characteristic.OutletInUse, false);
    }, 1000);
  }

  private applyServiceName(service: Service, name: string) {
    service.displayName = name;
    service.setCharacteristic(this.platform.Characteristic.Name, name);

    const CharacteristicClass = this.platform.Characteristic;
    const configuredNameCharacteristic =
      (CharacteristicClass as typeof CharacteristicClass & { ConfiguredName?: typeof CharacteristicClass.Name }).ConfiguredName;
    if (configuredNameCharacteristic) {
      try {
        service.updateCharacteristic(configuredNameCharacteristic, name);
      } catch {
        // characteristic not supported on older HomeKit versions
      }
    }
  }
}
