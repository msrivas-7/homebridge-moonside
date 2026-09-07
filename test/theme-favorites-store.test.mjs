import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ThemeFavoritesStore, validateFavorites } from '../dist/themeFavoritesStore.js';
const a = 'a'.repeat(64), b = 'b'.repeat(64);

test('durable favorites remain per lamp and reject stale concurrent updates', async t => {
  const path = await mkdtemp(join(tmpdir(), 'theme-store-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const store = new ThemeFavoritesStore(path);
  const empty = await store.read('lamp-a');
  const results = await Promise.allSettled([
    store.save('lamp-a', { ...empty, ids: [a] }, new Set([a,b])),
    store.save('lamp-a', { ...empty, ids: [b] }, new Set([a,b])),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.deepEqual(await new ThemeFavoritesStore(path).read('lamp-a'), { version: 1, revision: 1, ids: [a] });
  assert.deepEqual(await store.read('lamp-b'), empty);
  assert.ok((await readdir(path)).every(name => !name.includes('lamp-a') && !name.endsWith('.tmp')));
  const file = join(path, (await readdir(path))[0]);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const bytes = await readFile(file);
  await assert.rejects(store.save('lamp-a', { version: 1, revision: 1, ids: [b] }, new Set()), /configured/);
  assert.deepEqual(await readFile(file), bytes);
  await store.save('lamp-a', { version: 1, revision: 1, ids: [a] }, new Set());
  await store.save('lamp-a', { version: 1, revision: 2, ids: [] }, new Set());
  assert.deepEqual((await store.read('lamp-a')).ids, []);
  await writeFile(file, 'corrupt');
  await assert.rejects(store.read('lamp-a'));
});

test('favorite payload validation rejects malformed, duplicate and excessive values', () => {
  for (const value of [null, {}, { version:1,revision:-1,ids:[] }, { version:1,revision:0,ids:[a,a] },
    { version:1,revision:0,ids:['bad'] }, { version:1,revision:0,ids:Array(101).fill(a) }]) {
    assert.throws(() => validateFavorites(value));
  }
});
