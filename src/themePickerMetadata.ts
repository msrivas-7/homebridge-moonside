import { createHash } from 'node:crypto';
import type { Service } from 'homebridge';
import type { MoonsideCloudPlatform } from './platform.js';

// Optional versioned UI contract. Apple Home still uses standard light and switch services.
export const THEME_PICKER_UUID = 'C48B8A28-40D3-4F51-B51C-A5D39D985991';

export function setThemePickerMetadata(
  platform: MoonsideCloudPlatform, service: Service, deviceId: string, themeId?: string, role: 'action' | 'favorite' = 'action',
) {
  const existing = service.characteristics.find(item => item.UUID === THEME_PICKER_UUID);
  if (!platform.config?.themePicker || !deviceId || ['null', 'undefined'].includes(deviceId)) {
    if (existing) {
      service.removeCharacteristic(existing);
    }
    return;
  }
  const { Characteristic, Formats, Perms, uuid } = platform.api.hap;
  const metadata = existing ?? service.addCharacteristic(new Characteristic('Theme Picker', THEME_PICKER_UUID, {
    format: Formats.STRING, perms: [Perms.PAIRED_READ], maxLen: 256,
  }));
  metadata.updateValue(JSON.stringify({
    version: 1,
    group: uuid.generate(`theme-picker:${deviceId}`),
    role: themeId === undefined ? 'source' : role,
    ...(themeId === undefined ? {} : { id: createHash('sha256').update(themeId).digest('hex') }),
  }));
}
