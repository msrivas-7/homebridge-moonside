import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { catalogChoices, lampChoices, prepareThemeSetup, validateThemeSetup } from '../dist/themeOnboarding.js';
import { SetupDraft } from '../homebridge-ui/public/model.js';
import { ThemeFavoritesStore } from '../dist/themeFavoritesStore.js';
import { themeFavoriteId } from '../dist/favoriteThemeAccessory.js';
import { MoonsideCloudPlatform } from '../dist/platform.js';
import hap from 'hap-nodejs';
const logger = { info() {}, warn() {}, debug() {}, error() {} };
const definitions = Array.from({ length: 100 }, (_, i) => ({
  id: `id-${i}`,
  name: i < 2 ? 'Same name' : `Theme ${i}`,
  controlData: `THEME.FIXTURE${i}.0,`,
}));
const themes = catalogChoices(new Map(definitions.map((t, i) => [String(i), t])));
const lamps = ['a', 'b'].map((id) => ({ id, name: 'Same lamp', favorites: { version: 1, revision: 0, ids: [] } }));
const setup = () => ({
  version: 1,
  id: randomUUID(),
  mode: 'selected',
  selectedIds: [themes[0].id],
  lamps: lamps.map((l) => ({ deviceId: l.id, ids: [], expectedRevision: 0 })),
});

test('discovery deduplicates aliases, retains same titles and commands, and rejects ambiguous/oversized data', () => {
  const map = new Map([
    ['a', definitions[0]],
    ['alias', definitions[0]],
    ['b', definitions[1]],
  ]);
  assert.equal(catalogChoices(map).length, 2);
  map.set('bad', { ...definitions[0], controlData: 'THEME.DIFFERENT' });
  assert.throws(() => catalogChoices(map), /conflicting/);
  assert.throws(() => catalogChoices(new Map([['bad', { id: '', name: 'x', controlData: 'x' }]])), /invalid/);
  assert.throws(
    () => catalogChoices(new Map(Array.from({ length: 1001 }, (_, i) => [i, { id: `${i}`, name: 'x', controlData: 'THEME.x' }]))),
    /size/,
  );
  assert.deepEqual(catalogChoices(new Map()), []);
  assert.equal(
    lampChoices(
      new Map([
        ['a', { deviceName: 'Same' }],
        ['b', { deviceName: 'Same' }],
        ['null', {}],
        ['invalid', []],
      ]),
    ).length,
    2,
  );
});

test('library selections and per-lamp favorites are independent; filtered select all is truly all', () => {
  const draft = new SetupDraft({}, { themes, lamps });
  assert.equal(draft.selected.size, 0);
  draft.enabled.set('a', true);
  draft.selectAll();
  assert.equal(draft.selected.size, 100);
  draft.enabled.set('a', true);
  draft.favorite('a', themes[0].id, true);
  assert.equal(draft.favorites.get('b').size, 0);
  draft.select(themes[0].id, false);
  assert.equal(draft.favorites.get('a').size, 0);
  assert.throws(() => draft.favorite('a', themes[0].id, true), /first/);
  draft.selectAll();
  for (const t of themes.slice(0, 99)) {
    draft.favorite('a', t.id, true);
  }
  assert.throws(() => draft.favorite('a', themes[99].id, true), /99/);
  draft.clear();
  assert.equal(draft.selected.size, 0);
  assert.equal(draft.favorites.get('a').size, 0);
  assert.equal(lamps[0].favorites.ids.length, 0, 'draft never mutates discovery');
});

test('existing lists and temporarily missing favorite IDs survive discovery without selecting everything', () => {
  const missing = themeFavoriteId('missing');
  const draft = new SetupDraft(
    { themeSwitches: ['Same name'] },
    {
      themes,
      configuredIds: themes.filter((t) => t.name.startsWith('Same name')).map((t) => t.id),
      lamps: [{ ...lamps[0], favorites: { version: 1, revision: 4, ids: [missing] } }],
    },
  );
  assert.equal(draft.selected.size, 3);
  assert.ok(draft.selected.has(missing));
  assert.deepEqual(draft.payload().lamps[0].ids, [missing]);
});

test('prepare rejects injected devices, theme IDs, revision conflicts and invalid shapes', () => {
  const valid = setup();
  assert.equal(prepareThemeSetup(valid, themes, lamps).lamps.length, 2);
  assert.throws(() => prepareThemeSetup({ ...valid, selectedIds: [themeFavoriteId('invented')] }, themes, lamps));
  assert.throws(() => prepareThemeSetup({ ...valid, lamps: [] }, themes, lamps));
  assert.throws(() =>
    prepareThemeSetup({ ...valid, lamps: [{ deviceId: 'other', ids: [], expectedRevision: 0 }, valid.lamps[1]] }, themes, lamps),
  );
  assert.throws(() =>
    prepareThemeSetup(valid, themes, [{ ...lamps[0], favorites: { version: 1, revision: 1, ids: [] } }, lamps[1]]),
  );
  for (const value of [null, {}, { ...valid, lamps: [null] }, { ...valid, selectedIds: [themes[0].id, themes[0].id] }]) {
    assert.throws(() => validateThemeSetup(value));
  }
});

test('onboarding seeds once; runtime edits persist and stale onboarding cannot overwrite them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'theme-onboarding-store-'));
  try {
    const store = new ThemeFavoritesStore(directory);
    const id = randomUUID();
    const allowed = new Set(themes.map((t) => t.id));
    const first = await store.applySetup('a', id, [themes[0].id], 0, allowed);
    assert.equal(first.revision, 1);
    assert.equal((await store.applySetup('a', id, [themes[0].id], 0, allowed)).revision, 1);
    await store.save('a', { ...first, ids: [] }, allowed);
    assert.deepEqual((await store.applySetup('a', id, [themes[0].id], 0, allowed)).ids, []);
    await assert.rejects(store.applySetup('a', randomUUID(), [themes[0].id], 0, allowed), /changed/);
    assert.deepEqual((await store.read('b')).ids, []);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('runtime discovery preserves explicit legacy lists and selects by ID through renames', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'theme-onboarding-platform-'));
  try {
    const config = setup();
    config.selectedIds = [themeFavoriteId(definitions[0].id)];
    const platform = new MoonsideCloudPlatform(
      logger,
      {
        platform: 'MoonsideCloud',
        email: 'fixture@example.invalid',
        password: 'fixture',
        themePicker: true,
        themeSetup: config,
        themeSwitches: [definitions[2].name],
      },
      { hap, on() {}, user: { storagePath: () => directory } },
    );
    platform.apiClient = {
      async fetchThemeLibrary() {
        return new Map(
          definitions.map((t) => [t.name.toLowerCase(), t]).concat([['renamed', { ...definitions[0], name: 'Renamed' }]]),
        );
      },
    };
    assert.equal((await platform.resolveThemeDefinitions())[0].name, 'Renamed');
    assert.equal(platform.legacyDefinitions.length, 1);
    assert.equal(platform.legacyDefinitions[0].id, definitions[2].id);
    platform.themeDefinitionsCache = undefined;
    platform.themeSetup.mode = 'all';
    assert.equal((await platform.resolveThemeDefinitions()).length, 100);
    platform.themeDefinitionsCache = undefined;
    platform.apiClient.fetchThemeLibrary = async () => {
      throw new Error('Offline');
    };
    assert.equal(await platform.resolveThemeDefinitions(), undefined);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('mixed device participation is explicit and smaller libraries constrain favorites', () => {
  const discovery = {
    themes,
    lamps: [...lamps, { id: 'socket', name: 'Desk device', favorites: { version: 1, revision: 0, ids: [] } }],
  };
  const draft = new SetupDraft({}, discovery);
  assert.ok([...draft.enabled.values()].every((value) => value === false));
  draft.selectAll();
  draft.enabled.set('a', true);
  draft.enabled.set('b', true);
  draft.libraries.set('a', new Set([themes[0].id]));
  draft.libraries.set('b', new Set([themes[1].id, themes[2].id]));
  draft.favorite('a', themes[0].id, true);
  draft.favorite('b', themes[1].id, true);
  assert.throws(() => draft.favorite('a', themes[1].id, true));
  assert.throws(() => draft.favorite('socket', themes[0].id, true));
  const payload = prepareThemeSetup(draft.payload(), themes, discovery.lamps);
  assert.equal(payload.lamps[2].enabled, false);
  assert.deepEqual(payload.lamps[2].ids, []);
  assert.deepEqual(payload.lamps[0].selectedIds, [themes[0].id]);
  const restored = new SetupDraft({ themeSetup: payload }, discovery);
  assert.deepEqual(restored.libraries.get('b'), new Set([themes[1].id, themes[2].id]));
  assert.equal(restored.enabled.get('socket'), false);
});

test('theme-enabled devices use only their own library; unknown devices receive no picker metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'theme-mixed-platform-'));
  try {
    const config = setup();
    config.selectedIds = themes.slice(0, 3).map((t) => t.id);
    config.lamps = [
      { deviceId: 'a', ids: [themes[0].id], expectedRevision: 0, enabled: true, selectedIds: [themes[0].id] },
      { deviceId: 'b', ids: [themes[1].id], expectedRevision: 0, enabled: true, selectedIds: [themes[1].id, themes[2].id] },
      { deviceId: 'socket', ids: [], expectedRevision: 1, enabled: false },
    ];
    class Accessory extends hap.Accessory {
      context = {};
    }
    const platform = new MoonsideCloudPlatform(
      logger,
      { platform: 'MoonsideCloud', themePicker: true, themeSetup: config },
      {
        hap,
        on() {},
        user: { storagePath: () => directory },
        platformAccessory: Accessory,
        registerPlatformAccessories() {},
        unregisterPlatformAccessories() {},
        updatePlatformAccessories() {},
      },
    );
    const previousSocketFavorite = themes[0].id;
    await platform.favoriteStore.save(
      'socket',
      { version: 1, revision: 0, ids: [previousSocketFavorite] },
      new Set([previousSocketFavorite]),
    );
    for (const id of ['a', 'b', 'socket', 'new-device']) {
      await platform.registerOrUpdateAccessory(id, { deviceName: 'Same name', on: false });
      await platform.registerOrUpdateThemeAccessory(id, 'Same name', definitions);
    }
    assert.equal(platform.configuredThemes.get('a').length, 1);
    assert.equal(platform.configuredThemes.get('b').length, 2);
    for (const id of ['socket', 'new-device']) {
      assert.equal(platform.favoriteAccessories.has(id), false);
      const lamp = platform.accessories.get(hap.uuid.generate(id)).getService(hap.Service.Lightbulb);
      assert.equal(
        lamp.characteristics.some((c) => c.UUID === 'C48B8A28-40D3-4F51-B51C-A5D39D985991'),
        false,
      );
    }
    assert.deepEqual((await platform.favoriteStore.read('socket')).ids, []);
    // Missing catalog entries retain existing automation services, but no stale command can be sent.
    const favorite = platform.favoriteAccessories.get('a');
    const before = favorite.accessory.services.filter((s) => s.UUID === hap.Service.Switch.UUID).map((s) => s.subtype);
    await platform.registerOrUpdateThemeAccessory('a', 'Same name', []);
    assert.deepEqual(
      favorite.accessory.services.filter((s) => s.UUID === hap.Service.Switch.UUID).map((s) => s.subtype),
      before,
    );
    await assert.rejects(
      favorite.accessory
        .getServiceById(hap.Service.Switch, themes[0].id)
        .getCharacteristic(hap.Characteristic.On)
        .handleSetRequest(true),
    );
    await platform.registerOrUpdateThemeAccessory('a', 'Same name', definitions);
    assert.deepEqual(
      favorite.accessory.services.filter((s) => s.UUID === hap.Service.Switch.UUID).map((s) => s.subtype),
      before,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('reopening before restart keeps pending favorites; later runtime edits take precedence', () => {
  const config = setup();
  config.lamps[0].ids = [themes[0].id];
  let draft = new SetupDraft({ themeSetup: config }, { themes, lamps });
  assert.deepEqual([...draft.favorites.get('a')], [themes[0].id]);
  draft = new SetupDraft(
    { themeSetup: config },
    { themes, lamps: [{ ...lamps[0], favorites: { version: 1, revision: 2, ids: [], setupId: config.id } }, lamps[1]] },
  );
  assert.deepEqual([...draft.favorites.get('a')], []);
});

test('catalog discovery shares a bounded abort signal with authentication and never sends a control', async (t) => {
  const { MoonsideApiClient } = await import('../dist/moonsideApi.js');
  let observed;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    observed = options;
    await new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  });
  const controller = new globalThis.AbortController();
  const client = new MoonsideApiClient(logger, 'fixture@example.invalid', 'fixture-only');
  const operation = client.fetchThemeLibrary(controller.signal);
  controller.abort();
  await assert.rejects(operation);
  assert.equal(observed.signal, controller.signal);
  assert.equal(observed.method, 'POST');
  assert.equal(JSON.parse(observed.body).returnSecureToken, true);
});

test('absent devices retain their library and favorites without accepting invented profiles', () => {
  const config = setup();
  config.lamps[1].ids = [themes[0].id];
  const present = [lamps[0]];
  const draft = new SetupDraft({ themeSetup: config }, { themes, lamps: present });
  draft.clear();
  draft.select(themes[1].id, true);
  const preserved = [{ ...config.lamps[1], selectedIds: [themes[0].id] }];
  const result = prepareThemeSetup(draft.payload(), themes, present, preserved);
  assert.deepEqual(result.lamps[1], preserved[0]);
  assert.deepEqual(result.selectedIds, [themes[1].id]);
  result.lamps[1].deviceId = 'invented';
  assert.throws(() => prepareThemeSetup(result, themes, present, preserved));
  const returned = new SetupDraft({ themeSetup: result }, { themes, lamps });
  assert.equal(returned.enabled.get('b'), false);
});


test('a disappearing selected theme may be retained but cannot become a new favorite', () => {
  const missing = themes[0].id;
  const input = setup();
  const remaining = themes.slice(1);
  assert.throws(() => prepareThemeSetup(input, remaining, lamps));
  assert.deepEqual(prepareThemeSetup(input, remaining, lamps, [], [missing]).selectedIds, [missing]);
  input.lamps[0].ids = [missing];
  assert.throws(() => prepareThemeSetup(input, remaining, lamps, [], [missing]));
});
