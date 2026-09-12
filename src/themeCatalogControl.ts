import type { Characteristic, Service } from 'homebridge';
import type { MoonsideCloudPlatform } from './platform.js';
import type { ThemeDefinition } from './moonsideApi.js';
import { themeFavoriteId } from './favoriteThemeAccessory.js';

export const THEME_CATALOG_UUID = '5B530C0B-C1DF-496C-9151-52EAB77FD424';
export const THEME_SELECTION_UUID = 'AAEA8272-2EEC-40EC-8C03-0E15FCA30F18';

/** Transport catalog data without publishing one native accessory service per theme. */
export class ThemeCatalogControl {
  private catalog: Characteristic;
  private themes = new Map<string, ThemeDefinition>();
  private stopped = false;

  constructor(private readonly platform: MoonsideCloudPlatform, source: Service, deviceId: string) {
    const { Characteristic, Formats, Perms } = platform.api.hap;
    this.catalog = source.characteristics.find(c => c.UUID === THEME_CATALOG_UUID)
      ?? source.addCharacteristic(new Characteristic('Theme Catalog', THEME_CATALOG_UUID, {
        format: Formats.DATA, perms: [Perms.PAIRED_READ, Perms.NOTIFY], maxDataLen: 131072,
      }));
    const selection = source.characteristics.find(c => c.UUID === THEME_SELECTION_UUID)
      ?? source.addCharacteristic(new Characteristic('Theme Selection', THEME_SELECTION_UUID, {
        format: Formats.STRING, perms: [Perms.PAIRED_READ, Perms.PAIRED_WRITE], maxLen: 64,
      }));
    selection.onGet(() => '');
    selection.onSet(async value => {
      const theme = typeof value === 'string' ? this.themes.get(value) : undefined;
      if (this.stopped || !theme) {
        throw new platform.api.hap.HapStatusError(platform.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
      }
      await platform.applyTheme(deviceId, theme);
    });
  }

  update(themes: ThemeDefinition[]) {
    if (themes.some(theme => typeof theme.id !== 'string' || !theme.id
      || typeof theme.name !== 'string' || !theme.name.trim() || theme.name.length > 256)) {
      throw new Error('Invalid theme catalog entry');
    }
    const next = new Map(themes.map(theme => [themeFavoriteId(theme.id), theme]));
    const payload = Buffer.from(JSON.stringify({ version: 1, themes: [...next].map(([id, theme]) => ({ id, name: theme.name })) })).toString('base64');
    if (next.size > 1000 || payload.length > 131072) {
      throw new Error('Theme catalog exceeds the supported size');
    }
    this.themes = next;
    this.catalog.updateValue(payload);
  }

  destroy() {
    this.stopped = true;
    this.themes.clear();
  }
}
