import { THEME_CATALOG_UUID, THEME_SELECTION_UUID } from './themeCatalogControl.js';
import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { MoonsideCloudPlatform, MoonsideDeviceConfig } from './platform.js';
import type { DeviceState } from './moonsideApi.js';
import { THEME_FAVORITES_UUID } from './themeFavoritesControl.js';
import { setThemePickerMetadata } from './themePickerMetadata.js';

interface RgbColor {
  r: number; // 0-1
  g: number;
  b: number;
}

export class MoonsideLampAccessory {
  private readonly service: Service;
  private cachedState: DeviceState = {};
  private stateRevision = 0;
  private currentColor: RgbColor = { r: 1, g: 1, b: 1 };
  private targetHue = 0;
  private targetSaturation = 0;
  private colorUpdatePromise?: Promise<void>;
  private colorUpdateResolve?: () => void;
  private colorUpdateReject?: (reason?: unknown) => void;
  private colorUpdateTimeout?: NodeJS.Timeout;
  private readonly pollTimer?: NodeJS.Timeout;

  constructor(
    private readonly platform: MoonsideCloudPlatform,
    private readonly accessory: PlatformAccessory,
    private device: MoonsideDeviceConfig,
    private readonly initialState?: DeviceState,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Moonside')
      .setCharacteristic(this.platform.Characteristic.Model, this.device.deviceId)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.deviceId);

    this.service = this.accessory.getService(this.platform.Service.Lightbulb)
      || this.accessory.addService(this.platform.Service.Lightbulb);

    this.service.setCharacteristic(this.platform.Characteristic.Name, device.name);
    this.removeLegacyThemeSwitches();

    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.handleSetOn.bind(this))
      .onGet(this.handleGetOn.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.Brightness)
      .onSet(this.handleSetBrightness.bind(this))
      .onGet(this.handleGetBrightness.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.Hue)
      .onSet(this.handleSetHue.bind(this))
      .onGet(this.handleGetHue.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.Saturation)
      .onSet(this.handleSetSaturation.bind(this))
      .onGet(this.handleGetSaturation.bind(this));

    setThemePickerMetadata(this.platform, this.service, device.deviceId);
    // Cached custom writes must fail until discovery has validated the catalog.
    for (const characteristic of this.service.characteristics) {
      if ([THEME_FAVORITES_UUID, THEME_SELECTION_UUID].includes(characteristic.UUID)) {
        characteristic.onSet(() => {
          throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        });
      }
    }
    if (!this.platform.config.themePicker) {
      for (const characteristic of [...this.service.characteristics]) {
        if ([THEME_FAVORITES_UUID, THEME_CATALOG_UUID, THEME_SELECTION_UUID].includes(characteristic.UUID)) {
          this.service.removeCharacteristic(characteristic);
        }
      }
    }

    if (this.initialState) {
      this.updateFromCloud(this.initialState);
    } else {
      void this.pollState();
    }

    if (this.platform.enablePolling) {
      this.pollTimer = setInterval(() => this.pollState(), this.platform.pollingInterval);
    }

  }

  public updateFromCloud(update?: DeviceState, selectedThemeId?: string) {
    if (!update) {
      return;
    }

    this.stateRevision++;
    if (typeof update.controlData === 'string') {
      this.platform.observeControl?.(this.device.deviceId, update.controlData, selectedThemeId);
    } else if (update.on === false) {
      this.platform.observeControl?.(this.device.deviceId, 'LEDOFF');
    }
    this.cachedState = { ...this.cachedState, ...update };
    this.applyStateFromCloud(this.cachedState);
  }

  public prepareControl(command: string) {
    this.stateRevision++;
    if (!command.startsWith('COLOR') && this.colorUpdateTimeout) {
      clearTimeout(this.colorUpdateTimeout);
      this.colorUpdateTimeout = undefined;
      this.settleColorPromise(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY));
    }
  }

  public getLastControl(): string | undefined {
    return this.cachedState.controlData;
  }

  public getDeviceName(): string {
    return this.device.name;
  }

  public destroy() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    if (this.colorUpdateTimeout) {
      clearTimeout(this.colorUpdateTimeout);
    }
    this.settleColorPromise();
  }


  private async pollState() {
    if (!this.platform.apiClient) {
      return;
    }

    const revision = this.stateRevision;
    try {
      const state = await this.platform.apiClient.getDeviceState(this.device.deviceId);
      if (revision === this.stateRevision) {
        this.updateFromCloud(state);
      }
    } catch (error) {
      this.platform.logger.warn('Failed to poll %s: %s', this.device.name, error instanceof Error ? error.message : String(error));
    }
  }

  private applyStateFromCloud(data: DeviceState) {
    if (typeof data.deviceName === 'string' && data.deviceName && data.deviceName !== this.device.name) {
      this.device = { ...this.device, name: data.deviceName };
      this.service.setCharacteristic(this.platform.Characteristic.Name, data.deviceName);
    }

    const on = this.parsePowerState(data);
    const brightness = this.parseBrightness(data);

    // Brightness commands replace controlData, so retain the inferred power state.
    this.cachedState.on = on;
    this.service.updateCharacteristic(this.platform.Characteristic.On, on);
    this.service.updateCharacteristic(this.platform.Characteristic.Brightness, brightness);

    const color = this.parseColor(data);
    if (color) {
      this.currentColor = color;
      const { h, s } = this.rgbToHsv(color);
      this.targetHue = h;
      this.targetSaturation = s;
      this.service.updateCharacteristic(this.platform.Characteristic.Hue, h);
      this.service.updateCharacteristic(this.platform.Characteristic.Saturation, s);
    }
  }

  private removeLegacyThemeSwitches() {
    const switchUuid = this.platform.Service.Switch.UUID;
    for (const service of this.accessory.services) {
      if (service.UUID === switchUuid) {
        this.platform.logger.debug('%s removing legacy theme switch "%s"', this.logPrefix(), service.displayName);
        this.accessory.removeService(service);
      }
    }
  }

  private parsePowerState(data: DeviceState): boolean {
    if (typeof data.controlData === 'string') {
      const command = data.controlData.toUpperCase();
      if (command.includes('LEDON')) {
        return true;
      }
      if (command.includes('LEDOFF')) {
        return false;
      }
      if (command.startsWith('THEME') || command.startsWith('COLOR') || command.startsWith('PIXEL')) {
        return true;
      }
    }

    if (typeof data.on === 'boolean') {
      return data.on;
    }

    return this.service.getCharacteristic(this.platform.Characteristic.On).value as boolean ?? false;
  }

  private parseBrightness(data: DeviceState): number {
    if (typeof data.brightness === 'number') {
      return this.normalizeBrightness(data.brightness);
    }

    if (typeof data.controlData === 'string' && data.controlData.toUpperCase().startsWith('BRIGH')) {
      const level = parseInt(data.controlData.slice(5), 10);
      if (!Number.isNaN(level)) {
        return this.normalizeBrightness(level);
      }
    }

    const current = this.service.getCharacteristic(this.platform.Characteristic.Brightness).value as number | undefined;
    return current ?? 100;
  }

  private parseColor(data: DeviceState): RgbColor | undefined {
    if (typeof data.controlData === 'string' && data.controlData.toUpperCase().startsWith('COLOR')) {
      const payload = data.controlData.slice(5).trim();

      if (/^\d{9}$/.test(payload)) {
        const r = parseInt(payload.slice(0, 3), 10) / 255;
        const g = parseInt(payload.slice(3, 6), 10) / 255;
        const b = parseInt(payload.slice(6, 9), 10) / 255;
        if ([r, g, b].every(value => Number.isFinite(value))) {
          return { r: this.clamp01(r), g: this.clamp01(g), b: this.clamp01(b) };
        }
      } else {
        const segments = payload.split(/(?=(?:0|1)(?:\.|$))/).filter(Boolean);
        if (segments.length >= 3) {
          const values = segments.slice(0, 3).map(segment => Number(segment));
          if (values.every(value => Number.isFinite(value))) {
            return {
              r: this.clamp01(values[0]),
              g: this.clamp01(values[1]),
              b: this.clamp01(values[2]),
            };
          }
        }
      }
    }

    if (typeof data.colorHEXDecimal === 'number') {
      const hex = data.colorHEXDecimal.toString(16).padStart(6, '0');
      const r = parseInt(hex.slice(-6, -4), 16) / 255;
      const g = parseInt(hex.slice(-4, -2), 16) / 255;
      const b = parseInt(hex.slice(-2), 16) / 255;
      if ([r, g, b].every(channel => !Number.isNaN(channel))) {
        return { r, g, b };
      }
    }

    return undefined;
  }

  private normalizeBrightness(value: number): number {
    return Math.max(1, Math.min(100, Math.round(value)));
  }

  private clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
  }

  private async handleSetOn(value: CharacteristicValue) {
    if (!this.platform.apiClient) {
      return;
    }

    const command = value ? 'LEDON' : 'LEDOFF';
    this.platform.logger.debug('%s set On -> %s', this.logPrefix(), command);
    try {
      await this.platform.sendControl(this.device.deviceId, command);
      this.platform.observeControl?.(this.device.deviceId, command);
      this.cachedState.on = !!value;
      this.service.updateCharacteristic(this.platform.Characteristic.On, this.cachedState.on);
    } catch (error) {
      this.platform.logger.error('Failed to set power for %s: %s', this.device.name, error instanceof Error ? error.message : String(error));
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private async handleGetOn(): Promise<CharacteristicValue> {
    return this.service.getCharacteristic(this.platform.Characteristic.On).value as boolean ?? false;
  }

  private async handleSetBrightness(value: CharacteristicValue) {
    if (!this.platform.apiClient) {
      return;
    }

    const level = this.normalizeBrightness(value as number);
    this.platform.logger.debug('%s set Brightness -> %d', this.logPrefix(), level);

    try {
      await this.platform.sendControl(this.device.deviceId, `BRIGH${level}`);
      this.cachedState.brightness = level;
      this.service.updateCharacteristic(this.platform.Characteristic.Brightness, level);
    } catch (error) {
      this.platform.logger.error(
        'Failed to set brightness for %s: %s',
        this.device.name,
        error instanceof Error ? error.message : String(error),
      );
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private async handleGetBrightness(): Promise<CharacteristicValue> {
    return this.service.getCharacteristic(this.platform.Characteristic.Brightness).value as number ?? 100;
  }

  private async handleSetHue(value: CharacteristicValue) {
    this.targetHue = value as number;
    this.platform.logger.debug('%s set Hue -> %s', this.logPrefix(), this.targetHue);
    return this.scheduleColorUpdate();
  }

  private async handleGetHue(): Promise<CharacteristicValue> {
    return this.targetHue;
  }

  private async handleSetSaturation(value: CharacteristicValue) {
    this.targetSaturation = value as number;
    this.platform.logger.debug('%s set Saturation -> %s', this.logPrefix(), this.targetSaturation);
    return this.scheduleColorUpdate();
  }

  private async handleGetSaturation(): Promise<CharacteristicValue> {
    return this.targetSaturation;
  }

  private scheduleColorUpdate(): Promise<void> {
    if (!this.colorUpdatePromise) {
      this.colorUpdatePromise = new Promise<void>((resolve, reject) => {
        this.colorUpdateResolve = resolve;
        this.colorUpdateReject = reject;
      });
    }

    if (this.colorUpdateTimeout) {
      clearTimeout(this.colorUpdateTimeout);
    }

    this.colorUpdateTimeout = setTimeout(() => {
      this.colorUpdateTimeout = undefined;
      void this.pushColorUpdate()
        .then(() => this.settleColorPromise())
        .catch(error => this.settleColorPromise(error));
    }, 150);

    return this.colorUpdatePromise;
  }

  private settleColorPromise(error?: unknown) {
    if (error) {
      this.colorUpdateReject?.(error);
    } else {
      this.colorUpdateResolve?.();
    }

    this.colorUpdatePromise = undefined;
    this.colorUpdateResolve = undefined;
    this.colorUpdateReject = undefined;
  }

  private async pushColorUpdate() {
    if (!this.platform.apiClient) {
      return;
    }

    const rgb = this.hsvToRgb(this.targetHue, this.targetSaturation, 1);
    this.platform.logger.debug(
      '%s pushing color (h=%s, s=%s) -> rgb(%s, %s, %s)',
      this.logPrefix(),
      this.targetHue,
      this.targetSaturation,
      rgb.r.toFixed(4),
      rgb.g.toFixed(4),
      rgb.b.toFixed(4),
    );
    try {
      const command = this.buildColorCommand(rgb);
      await this.platform.sendControl(this.device.deviceId, command);
      this.platform.observeControl?.(this.device.deviceId, command);
      this.currentColor = rgb;
    } catch (error) {
      this.platform.logger.error('Failed to set color for %s: %s', this.device.name, error instanceof Error ? error.message : String(error));
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private buildColorCommand(rgb: RgbColor): string {
    const clampByte = (value: number) => Math.max(0, Math.min(255, Math.round(value * 255)));
    const pad = (value: number) => clampByte(value).toString().padStart(3, '0');
    const components = [pad(rgb.r), pad(rgb.g), pad(rgb.b)];
    return `COLOR${components.join('')}`;
  }

  private rgbToHsv(rgb: RgbColor): { h: number; s: number } {
    const r = rgb.r;
    const g = rgb.g;
    const b = rgb.b;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    let hue = 0;

    if (delta !== 0) {
      switch (max) {
      case r:
        hue = ((g - b) / delta) % 6;
        break;
      case g:
        hue = (b - r) / delta + 2;
        break;
      case b:
        hue = (r - g) / delta + 4;
        break;
      }

      hue *= 60;
      if (hue < 0) {
        hue += 360;
      }
    }

    const saturation = max === 0 ? 0 : (delta / max) * 100;
    return {
      h: Math.round(hue * 100) / 100,
      s: Math.round(saturation * 100) / 100,
    };
  }

  private hsvToRgb(hue: number, saturation: number, value: number): RgbColor {
    const h = (hue % 360) / 60;
    const s = this.clamp01(saturation / 100);
    const v = this.clamp01(value);

    const c = v * s;
    const x = c * (1 - Math.abs((h % 2) - 1));
    const m = v - c;

    let r = 0;
    let g = 0;
    let b = 0;

    if (0 <= h && h < 1) {
      r = c; g = x; b = 0;
    } else if (1 <= h && h < 2) {
      r = x; g = c; b = 0;
    } else if (2 <= h && h < 3) {
      r = 0; g = c; b = x;
    } else if (3 <= h && h < 4) {
      r = 0; g = x; b = c;
    } else if (4 <= h && h < 5) {
      r = x; g = 0; b = c;
    } else if (5 <= h && h < 6) {
      r = c; g = 0; b = x;
    }

    return {
      r: this.clamp01(r + m),
      g: this.clamp01(g + m),
      b: this.clamp01(b + m),
    };
  }

  private logPrefix(): string {
    return `[${this.device.name}]`;
  }

}
