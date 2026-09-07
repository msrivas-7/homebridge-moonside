import type { Characteristic, Service } from 'homebridge';
import type { MoonsideCloudPlatform } from './platform.js';
import { ThemeFavoritesStore, type ThemeFavoritesState, validateFavorites } from './themeFavoritesStore.js';

export const THEME_FAVORITES_UUID = '3D8F8A5E-06EC-4780-8C83-0DAAC35B7269';

export function encodeFavorites(state: ThemeFavoritesState): string {
  return Buffer.from(JSON.stringify(state)).toString('base64');
}

export function decodeFavorites(value: unknown): ThemeFavoritesState {
  if (typeof value !== 'string' || value.length > 16384 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error('Invalid theme favorites payload');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    throw new Error('Invalid theme favorites encoding');
  }
  return validateFavorites(JSON.parse(bytes.toString('utf8')));
}

/** Shared per-lamp settings, accessible to compatible Homebridge UIs over HAP. */
export class ThemeFavoritesControl {
  readonly characteristic: Characteristic;
  private configuredIds = new Set<string>();
  private destroyed = false;
  private sequence: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly platform: MoonsideCloudPlatform,
    source: Service,
    private readonly deviceId: string,
    private readonly store: ThemeFavoritesStore,
    private readonly publish: (state: ThemeFavoritesState) => Promise<void>,
  ) {
    const { Characteristic, Formats, Perms } = platform.api.hap;
    this.characteristic = source.characteristics.find(item => item.UUID === THEME_FAVORITES_UUID)
      ?? source.addCharacteristic(new Characteristic('Theme Favorites', THEME_FAVORITES_UUID, {
        format: Formats.DATA,
        perms: [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.NOTIFY, Perms.WRITE_RESPONSE],
        maxDataLen: 16384,
      }));
    this.characteristic.onGet(() => this.run(async () => encodeFavorites(await this.reconcile())));
    this.characteristic.onSet(value => this.run(async () => {
      if (this.destroyed) {
        throw new platform.api.hap.HapStatusError(platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
      }
      let request: ThemeFavoritesState;
      try {
        request = decodeFavorites(value);
      } catch {
        throw new platform.api.hap.HapStatusError(platform.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
      }
      try {
        const saved = await this.store.save(this.deviceId, request, this.configuredIds);
        await this.publish(saved);
        const encoded = encodeFavorites(saved);
        this.characteristic.updateValue(encoded);
        // A write response retains the incremented revision rather than echoing the request's old revision.
        return encoded;
      } catch {
        throw new platform.api.hap.HapStatusError(platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    }));
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const attempt = this.sequence.then(operation);
    this.sequence = attempt.catch(() => {});
    return attempt;
  }

  async updateConfiguredIds(ids: Iterable<string>) {
    return this.run(async () => {
      this.configuredIds = new Set(ids);
      return this.reconcile();
    });
  }

  private async reconcile() {
    if (this.destroyed) {
      throw new Error('Theme favorites control stopped');
    }
    const current = await this.store.read(this.deviceId);
    await this.publish(current);
    this.characteristic.updateValue(encodeFavorites(current));
    return current;
  }

  destroy() {
    this.destroyed = true;
  }
}
