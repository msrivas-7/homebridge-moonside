import assert from 'node:assert/strict';
import { test } from 'node:test';
import hap from 'hap-nodejs';
import { IdentifierCache } from 'hap-nodejs/dist/lib/model/IdentifierCache.js';
import { ThemeSwitchAccessory } from '../dist/themeSwitchAccessory.js';
import { MoonsideApiClient } from '../dist/moonsideApi.js';
import { MoonsideCloudPlatform } from '../dist/platform.js';

const { Accessory, Service, Characteristic, uuid } = hap;
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const device = { deviceId: 'synthetic-lamp', name: 'Test Lamp' };
const themes = [
  { id: 'ocean', name: 'Ocean', controlData: 'THEME.THEME1.1,' },
  { id: 'sunset', name: 'Sunset', controlData: 'THEME.GRADIENT1.2,' },
];
function outlets(accessory) {
  return accessory.services.filter(service => service.UUID === Service.Outlet.UUID);
}
function ids(accessory, cache) {
  // Model the real bridge's ID expiry pass without publishing a network service.
  cache.startTrackingUsage();
  accessory._assignIDs(cache);
  cache.stopTrackingUsageAndExpireUnused();
  return outlets(accessory).map(service => [service.subtype, service.iid, service.getCharacteristic(Characteristic.On).iid]);
}

test('cached themes retain service and characteristic IDs across startup, then receive fresh handlers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const commands = [];
  const platform = { Service, Characteristic, api: { hap }, logger,
    apiClient: { async sendControl(...args) {
      commands.push(args); 
    } } };
  let accessory = new Accessory('Lamp Themes', uuid.generate('synthetic-theme-accessory'));
  const cache = new IdentifierCache('00:00:00:00:00:01');
  new ThemeSwitchAccessory(platform, accessory, device, themes);
  const baseline = ids(accessory, cache);
  for (let restart = 0; restart < 3; restart++) {
    accessory = Accessory.deserialize(Accessory.serialize(accessory));
    const restored = new ThemeSwitchAccessory(platform, accessory, device);
    assert.deepEqual(ids(accessory, cache), baseline, 'startup must not expire cached theme IDs');
    await assert.rejects(outlets(accessory)[0].getCharacteristic(Characteristic.On).handleSetRequest(true));
    restored.updateThemes(themes);
    assert.deepEqual(ids(accessory, cache), baseline);
    for (const service of outlets(accessory)) {
      await service.getCharacteristic(Characteristic.On).handleSetRequest(true);
    }
    t.mock.timers.tick(1000);
    assert.ok(outlets(accessory).every(service => service.getCharacteristic(Characteristic.On).value === false));
  }
  assert.deepEqual(commands, Array.from({ length: 3 }, () => themes.map(theme => [device.deviceId, theme.controlData])).flat());
});

test('refreshing a theme updates its command without replacing its service; an explicit empty list removes it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const commands = [];
  const platform = { Service, Characteristic, api: { hap }, logger,
    apiClient: { async sendControl(...args) {
      commands.push(args); 
    } } };
  const accessory = new Accessory('Lamp Themes', uuid.generate('refresh-test'));
  const handler = new ThemeSwitchAccessory(platform, accessory, device, themes);
  const original = outlets(accessory)[0];
  handler.updateThemes([{ ...themes[0], name: 'Renamed Ocean', controlData: 'THEME.THEME1.9,' }]);
  assert.equal(outlets(accessory)[0], original);
  await original.getCharacteristic(Characteristic.On).handleSetRequest(true);
  assert.deepEqual(commands, [[device.deviceId, 'THEME.THEME1.9,']]);
  handler.updateThemes([]);
  assert.equal(outlets(accessory).length, 0);
});

test('a failed catalog fetch preserves cached accessories and a later successful retry resolves them', async () => {
  const platform = new MoonsideCloudPlatform(logger,
    { platform: 'MoonsideCloud', email: 'test@example.invalid', password: 'synthetic', themeSwitches: [' Ocean '] },
    { hap, on() {} });
  let fail = true;
  platform.apiClient = { async fetchThemeLibrary() {
    if (fail) {
      throw new Error('synthetic network failure'); 
    }
    return new Map([['ocean', themes[0]]]);
  } };
  const accessory = new Accessory('Lamp Themes', uuid.generate('network-failure'));
  accessory.context = { isThemeAccessory: true, device };
  new ThemeSwitchAccessory(platform, accessory, device, themes);
  platform.configureAccessory(accessory);
  const before = outlets(accessory);
  const definitions = await platform.resolveThemeDefinitions();
  assert.equal(definitions, undefined);
  await platform.registerOrUpdateThemeAccessory(device.deviceId, device.name, definitions);
  assert.deepEqual(outlets(accessory), before);
  fail = false;
  assert.deepEqual(await platform.resolveThemeDefinitions(), [themes[0]]);
  assert.equal(outlets(accessory).length, 1);
});

function document(id, name, code = 'THEME1') {
  return { document: { name: `projects/test/documents/effects/${id}`, fields: {
    name: { stringValue: name }, themeControlCode: { stringValue: code },
    themeParams: { arrayValue: { values: [{ integerValue: '7' }] } },
  } } };
}

test('catalog normalizes whitespace, retains duplicate titles, avoids generated-name collisions and supports legacy names', async (t) => {
  const payload = [
    document('a', '  Blue   Raspberry  '), document('b', 'Blue Raspberry'), document('c', 'Blue Raspberry', 'GRADIENT1'),
    document('d', 'Blue Raspberry - THEME1'), document('e', '  Ocean  '), {}, document('bad', '   '),
  ];
  t.mock.method(globalThis, 'fetch', async () => new globalThis.Response(JSON.stringify(payload)));
  const client = new MoonsideApiClient(logger, 'test@example.invalid', 'synthetic');
  client.ensureAuthenticated = async () => {};
  const library = await client.fetchThemeLibrary();
  assert.deepEqual(new Set([...library.values()].map(theme => theme.id)), new Set(['a', 'b', 'c', 'd', 'e']));
  assert.equal(library.get('blue raspberry').id, 'c', 'preserve last-record bare-name lookup');
  assert.equal(library.get('blue raspberry - theme1').id, 'd', 'never overwrite an original name');
  assert.equal(library.get('blue raspberry - theme1 (1)').id, 'a');
  assert.equal(library.get('blue raspberry - theme1 (2)').id, 'b');
  assert.equal(library.get('blue raspberry - gradient1').id, 'c');
  assert.equal(library.get('ocean').controlData, 'THEME.THEME1.7,');
  assert.ok([...library.values()].every(theme => theme.name === theme.name.trim() && !/\s{2}/.test(theme.name)));
  payload.reverse();
  const reordered = await client.fetchThemeLibrary();
  for (const [key, definition] of library) {
    if (key !== 'blue raspberry') {
      assert.deepEqual(reordered.get(key), definition); 
    }
  }
});

test('selecting both a bare name and a qualified alias creates only one theme service per document', async () => {
  const platform = new MoonsideCloudPlatform(logger,
    { platform: 'MoonsideCloud', email: 'test@example.invalid', password: 'synthetic',
      themeSwitches: ['  Blue   Raspberry ', 'Blue Raspberry - THEME1'] },
    { hap, on() {} });
  platform.apiClient = { async fetchThemeLibrary() {
    return new Map([['blue raspberry', themes[0]], ['blue raspberry - theme1', themes[0]]]);
  } };
  assert.deepEqual(await platform.resolveThemeDefinitions(), [themes[0]]);
});
