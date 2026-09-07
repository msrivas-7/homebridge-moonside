import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { ThemeDefinition, DeviceState } from './moonsideApi.js';
import { themeFavoriteId } from './favoriteThemeAccessory.js';
import { isValidDeviceId } from './deviceIdentity.js';
import { MAX_THEME_FAVORITES, type ThemeFavoritesState } from './themeFavoritesStore.js';

export interface ThemeSetup {
  version: 1;
  id: string;
  mode: 'selected' | 'all';
  selectedIds: string[];
  lamps: { deviceId: string; ids: string[]; expectedRevision: number; enabled?: boolean; selectedIds?: string[] }[];
}

function ids(value: unknown, max: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    new Set(value).size === value.length &&
    value.every((id) => typeof id === 'string' && /^[a-f\d]{64}$/.test(id))
  );
}

export function validateThemeSetup(value: unknown): ThemeSetup {
  const setup = value as ThemeSetup | undefined;
  if (
    !setup ||
    setup.version !== 1 ||
    !/^[a-f\d-]{36}$/.test(setup.id) ||
    !['all', 'selected'].includes(setup.mode) ||
    !ids(setup.selectedIds, 1000) ||
    !Array.isArray(setup.lamps) ||
    setup.lamps.length > 100 ||
    new Set(setup.lamps.map((lamp) => lamp?.deviceId)).size !== setup.lamps.length ||
    setup.lamps.some(
      (lamp) =>
        !lamp ||
        !isValidDeviceId(lamp.deviceId) ||
        lamp.deviceId.length > 256 ||
        !ids(lamp.ids, MAX_THEME_FAVORITES) ||
        (lamp.enabled !== undefined && typeof lamp.enabled !== 'boolean') ||
        (lamp.enabled === false && lamp.ids.length > 0) ||
        (lamp.selectedIds !== undefined &&
          (!ids(lamp.selectedIds, 1000) || lamp.ids.some((id) => !lamp.selectedIds!.includes(id)))) ||
        !Number.isSafeInteger(lamp.expectedRevision) ||
        lamp.expectedRevision < 0 ||
        (setup.mode === 'selected' && lamp.ids.some((id) => !(lamp.selectedIds ?? setup.selectedIds).includes(id))),
    )
  ) {
    throw new Error('Invalid theme setup. Reopen settings and review your choices.');
  }
  return structuredClone(setup);
}

/** Catalog maps also contain lookup aliases; deduplicate by identity, never by label or command. */
export function catalogChoices(library: Map<string, ThemeDefinition>) {
  const definitions = new Map<string, ThemeDefinition>();
  for (const theme of library.values()) {
    if (
      typeof theme.id !== 'string' ||
      !theme.id ||
      typeof theme.name !== 'string' ||
      !theme.name.trim() ||
      theme.name.length > 256 ||
      typeof theme.controlData !== 'string' ||
      !theme.controlData.startsWith('THEME.')
    ) {
      throw new Error('The theme catalog contains an invalid entry. Try discovery again later.');
    }
    const id = themeFavoriteId(theme.id);
    const prior = definitions.get(id);
    if (prior && (prior.name !== theme.name || prior.controlData !== theme.controlData)) {
      throw new Error('The theme catalog contains conflicting identities. Try again later.');
    }
    definitions.set(id, theme);
  }
  const counts = new Map<string, number>();
  for (const theme of definitions.values()) {
    counts.set(theme.name, (counts.get(theme.name) ?? 0) + 1);
  }
  const choices = [...definitions]
    .map(([id, theme]) => ({ id, name: counts.get(theme.name)! > 1 ? `${theme.name} · ${id.slice(0, 8)}` : theme.name }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  if (choices.length > 1000 || Buffer.from(JSON.stringify({ version: 1, themes: choices })).toString('base64').length > 131072) {
    throw new Error('The theme catalog exceeds the supported size. Your saved choices have not changed.');
  }
  return choices;
}

export function lampChoices(devices: Map<string, DeviceState>) {
  const lamps = [...devices]
    .filter(
      ([id, state]) => isValidDeviceId(id) && id.length <= 256 && state && typeof state === 'object' && !Array.isArray(state),
    )
    .map(([id, state]) => ({
      id,
      name: typeof state.deviceName === 'string' ? state.deviceName.slice(0, 256) : 'Moonside lamp',
      model: typeof state.deviceModel === 'string' ? state.deviceModel.slice(0, 100) : '',
    }));
  if (lamps.length > 100) {
    throw new Error('This setup supports up to 100 lamps. Your saved configuration has not changed.');
  }
  return lamps.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** A discovery session validates both membership and optimistic favorite revisions before config staging. */
export function prepareThemeSetup(
  value: unknown,
  themes: { id: string }[],
  lamps: { id: string; favorites: ThemeFavoritesState }[],
  preserved: ThemeSetup['lamps'] = [],
  retainedIds: string[] = [],
) {
  const setup = validateThemeSetup({ ...(value as object), id: randomUUID() });
  const allowed = new Set(themes.map((theme) => theme.id));
  const prior = new Set([...retainedIds, ...lamps.flatMap((lamp) => lamp.favorites.ids)]);
  if (
    setup.selectedIds.some((id) => !allowed.has(id) && !prior.has(id)) ||
    setup.lamps.length !== lamps.length + preserved.length
  ) {
    throw new Error('The discovered choices changed. Discover again before saving.');
  }
  for (const plan of setup.lamps) {
    const lamp = lamps.find((item) => item.id === plan.deviceId);
    if (!lamp && preserved.some((item) => isDeepStrictEqual(item, plan))) {
      continue;
    }
    if (
      !lamp ||
      plan.selectedIds?.some((id) => !setup.selectedIds.includes(id)) ||
      lamp.favorites.revision !== plan.expectedRevision ||
      plan.ids.some((id) => !allowed.has(id) && !lamp.favorites.ids.includes(id))
    ) {
      throw new Error('Lamp favorites changed. Discover again before saving.');
    }
  }
  return setup;
}
