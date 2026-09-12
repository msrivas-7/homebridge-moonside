import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// One of the 100 HAP services is reserved for Accessory Information.
export const MAX_THEME_FAVORITES = 99;

export interface ThemeFavoritesState {
  version: 1;
  revision: number;
  ids: string[];
}

export function validateFavorites(value: unknown): ThemeFavoritesState {
  const state = value as Partial<ThemeFavoritesState> | null;
  if (!state || state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision! < 0
    || !Array.isArray(state.ids) || state.ids.length > MAX_THEME_FAVORITES
    || state.ids.some(id => typeof id !== 'string' || !/^[a-f\d]{64}$/.test(id))
    || new Set(state.ids).size !== state.ids.length) {
    throw new Error('Invalid theme favorites');
  }
  return { version: 1, revision: state.revision!, ids: [...state.ids] };
}

/** One store instance per platform serializes changes without exposing device identifiers in filenames. */
export class ThemeFavoritesStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) {}

  private path(deviceId: string) {
    if (!deviceId || /^(null|undefined)$/i.test(deviceId)) {
      throw new Error('Invalid lamp identity');
    }
    return join(this.directory, `${createHash('sha256').update(deviceId).digest('hex')}.json`);
  }

  async read(deviceId: string): Promise<ThemeFavoritesState> {
    try {
      return validateFavorites(JSON.parse(await readFile(this.path(deviceId), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, revision: 0, ids: [] };
      }
      throw error;
    }
  }

  save(deviceId: string, expected: ThemeFavoritesState, configuredIds: ReadonlySet<string>): Promise<ThemeFavoritesState> {
    const input = validateFavorites(expected);
    const action = this.pending.then(async () => {
      const current = await this.read(deviceId);
      if (input.revision !== current.revision) {
        throw new Error('Favorites changed elsewhere. Reload before editing.');
      }
      // Keep saved IDs that temporarily disappear; reject newly invented or unconfigured IDs.
      if (input.ids.some(id => !configuredIds.has(id) && !current.ids.includes(id))) {
        throw new Error('Only configured themes can be added to favorites');
      }
      if (current.revision === Number.MAX_SAFE_INTEGER) {
        throw new Error('Favorites revision limit reached');
      }
      const next: ThemeFavoritesState = { version: 1, revision: current.revision + 1, ids: [...input.ids] };
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const target = this.path(deviceId);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(`${JSON.stringify(next)}\n`);
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, target);
        const directory = await open(this.directory, 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } finally {
        await unlink(temporary).catch(error => {
          if (error.code !== 'ENOENT') {
            throw error;
          }
        });
      }
      return next;
    });
    this.pending = action.catch(() => {});
    return action;
  }
}
