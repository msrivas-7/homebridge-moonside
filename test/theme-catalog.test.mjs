import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import hap from 'hap-nodejs';
import { MoonsideApiClient } from '../dist/moonsideApi.js';
import { MoonsideCloudPlatform } from '../dist/platform.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const themes = [{ id: 'ocean', name: 'Ocean', controlData: 'THEME.THEME1.1,' }];

function document(id, name, code = 'THEME1') {
  return { document: { name: `projects/moonside-501a1/databases/(default)/documents/app-lighting-effects/${id}`, fields: {
    name: { stringValue: name }, themeControlCode: { stringValue: code },
    themeParams: { arrayValue: { values: [{ integerValue: '7' }] } },
  } } };
}

function alias(id, name, code = 'THEME1') {
  const path = document(id, name).document.name;
  return `${name} - ${code} [theme:${createHash('sha256').update(path).digest('hex')}]`.toLowerCase();
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
  assert.equal(library.get(alias('a', 'Blue Raspberry')).id, 'a');
  assert.equal(library.get(alias('b', 'Blue Raspberry')).id, 'b');
  assert.equal(library.get(alias('c', 'Blue Raspberry', 'GRADIENT1')).id, 'c');
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
      themeSwitches: ['Blue Raspberry', 'Blue Raspberry - THEME1'] },
    { hap, on() {} });
  platform.apiClient = { async fetchThemeLibrary() {
    return new Map([['blue raspberry', themes[0]], ['blue raspberry - theme1', themes[0]]]);
  } };
  assert.deepEqual(await platform.resolveThemeDefinitions(), [themes[0]]);
});

test('removing a same-command catalog record cannot retarget the remaining qualified selection', async (t) => {
  let payload = [document('a', 'Blue Raspberry'), document('b', 'Blue Raspberry')];
  t.mock.method(globalThis, 'fetch', async () => new globalThis.Response(JSON.stringify(payload)));
  const client = new MoonsideApiClient(logger, 'test@example.invalid', 'synthetic');
  client.ensureAuthenticated = async () => {};
  const before = await client.fetchThemeLibrary();
  const selectedNames = [...before].filter(([name]) => name !== 'blue raspberry');
  assert.equal(selectedNames.length, 2);
  payload = [document('b', 'Blue Raspberry')];
  const after = await client.fetchThemeLibrary();
  for (const [name, definition] of selectedNames) {
    if (definition.id === 'b') {
      assert.equal(after.get(name)?.id, 'b', 'a saved qualified selection must still resolve to the same document');
    } else {
      assert.equal(after.get(name), undefined, 'a removed document must not resolve to a different document');
    }
  }
});

test('configured theme names use the same whitespace normalization as catalog names', async () => {
  const platform = new MoonsideCloudPlatform(logger,
    { platform: 'MoonsideCloud', email: 'test@example.invalid', password: 'synthetic', themeSwitches: ['  Blue   Raspberry  '] },
    { hap, on() {} });
  platform.apiClient = { async fetchThemeLibrary() {
    return new Map([['blue raspberry', themes[0]]]);
  } };
  assert.deepEqual(await platform.resolveThemeDefinitions(), [themes[0]]);
});


test('records with the same leaf ID in different collections remain independently selectable', async (t) => {
  const root = document('same', 'Ocean');
  const nested = document('same', 'Ocean', 'GRADIENT1');
  nested.document.name = root.document.name.replace('/app-lighting-effects/', '/users/test/app-lighting-effects/');
  const caseVariant = document('SAME', 'Ocean');
  let payload = [root, nested, caseVariant];
  t.mock.method(globalThis, 'fetch', async () => new globalThis.Response(JSON.stringify(payload)));
  const client = new MoonsideApiClient(logger, 'test@example.invalid', 'synthetic');
  client.ensureAuthenticated = async () => {};
  const before = await client.fetchThemeLibrary();
  assert.equal(new Set([...before.values()].map(theme => theme.id)).size, 3);
  assert.equal(before.get(alias('same', 'Ocean')).id, 'same', 'root records retain existing HomeKit service IDs');
  const selections = [...before].filter(([key]) => key !== 'ocean');
  assert.equal(selections.length, 3);
  const platform = new MoonsideCloudPlatform(logger,
    { platform: 'MoonsideCloud', email: 'test@example.invalid', password: 'synthetic',
      themeSwitches: selections.map(([key]) => key) }, { hap, on() {} });
  platform.apiClient = client;
  assert.equal((await platform.resolveThemeDefinitions()).length, 3);
  payload.reverse();
  const reversed = await client.fetchThemeLibrary();
  for (const [key, value] of selections) {
    assert.deepEqual(reversed.get(key), value);
  }
  payload = [nested];
  const after = await client.fetchThemeLibrary();
  for (const [key, value] of selections) {
    assert.deepEqual(after.get(key), value.id === nested.document.name ? value : undefined);
  }
});

test('qualified selections survive colliding title additions and removals without retargeting', async (t) => {
  const original = document('a', 'Ocean');
  let payload = [original];
  t.mock.method(globalThis, 'fetch', async () => new globalThis.Response(JSON.stringify(payload)));
  const client = new MoonsideApiClient(logger, 'test@example.invalid', 'synthetic');
  client.ensureAuthenticated = async () => {};
  const first = await client.fetchThemeLibrary();
  const [savedName, savedTheme] = [...first].find(([key]) => key !== 'ocean');
  const collision = document('b', savedTheme.name);
  payload = [original, collision];
  const crowded = await client.fetchThemeLibrary();
  assert.deepEqual(crowded.get(savedName), savedTheme);
  const collisionSelection = [...crowded].find(([, value]) => value.id === 'b');
  assert.ok(collisionSelection, 'the colliding title must also have a selectable alias');
  payload = [original];
  assert.deepEqual((await client.fetchThemeLibrary()).get(savedName), savedTheme);
  payload = [collision];
  const remaining = await client.fetchThemeLibrary();
  assert.equal(remaining.get(savedName), undefined, 'a missing theme cannot resolve to a colliding title');
  assert.deepEqual(remaining.get(collisionSelection[0]), collisionSelection[1]);
});
