import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import hap from 'hap-nodejs';
import { ThemeFavoritesStore } from '../dist/themeFavoritesStore.js';
import { ThemeFavoritesControl, decodeFavorites, encodeFavorites } from '../dist/themeFavoritesControl.js';
const id = 'a'.repeat(64);

test('HAP favorites persist before publishing and retain the new revision after a write', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'favorite-control-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ThemeFavoritesStore(directory);
  const published = [];
  const control = new ThemeFavoritesControl({ api: { hap } }, new hap.Service.Lightbulb('Lamp'), 'lamp', store, async state => {
    assert.deepEqual(await store.read('lamp'), state);
    published.push(state);
  });
  await control.updateConfiguredIds([id]);
  const request = encodeFavorites({ version: 1, revision: 0, ids: [id] });
  await control.characteristic.handleSetRequest(request);
  const saved = decodeFavorites(control.characteristic.value);
  assert.deepEqual(saved, { version: 1, revision: 1, ids: [id] });
  await assert.rejects(control.characteristic.handleSetRequest(request));
  assert.equal((await store.read('lamp')).revision, 1);
  assert.deepEqual(published.at(-1), saved);
  control.destroy();
  await assert.rejects(control.characteristic.handleSetRequest(encodeFavorites({ ...saved, ids: [] })));
});

test('a committed save with a publication failure is recovered by reading, without another write', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'favorite-reconcile-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ThemeFavoritesStore(directory);
  let reject = false;
  const control = new ThemeFavoritesControl({ api: { hap } }, new hap.Service.Lightbulb('Lamp'), 'lamp', store, async () => {
    if (reject) {
      throw Error('temporary publish failure');
    }
  });
  await control.updateConfiguredIds([id]);
  reject = true;
  await assert.rejects(control.characteristic.handleSetRequest(encodeFavorites({ version: 1, revision: 0, ids: [id] })));
  reject = false;
  assert.deepEqual(decodeFavorites(await control.characteristic.handleGetRequest()), { version: 1, revision: 1, ids: [id] });
});

test('malformed base64 and non-schema payloads are rejected', () => {
  for (const value of ['***', 'ew', 'e30=', 42, null]) {
    assert.throws(() => decodeFavorites(value));
  }
});
