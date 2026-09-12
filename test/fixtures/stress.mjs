import assert from 'node:assert/strict';
import { readFile, writeFile, rename } from 'node:fs/promises';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

// This harness can address only the dedicated synthetic bridge, never a discovered bridge.
const directory = '/tmp/moonside-onboarding-e2e';
const base = 'http://127.0.0.1:18801';
const flags = JSON.parse(await readFile(`${directory}/faults.json`));
assert.equal(flags.catalogSize, 500);
assert.equal(flags.stressDevices, 12);
const config = JSON.parse(await readFile(`${directory}/config.json`));
const platform = config.platforms.find((p) => p.platform === 'MoonsideCloud');
assert.equal(platform.email, 'demo@example.invalid');
assert.equal(platform.password, 'demo-only');
const plans = platform.themeSetup.lamps.filter((p) => /^stress-\d{2}$/.test(p.deviceId));
assert.equal(plans.length, 12);
async function setFlags(value) {
  await writeFile(`${directory}/faults.next.json`, JSON.stringify(value));
  await rename(`${directory}/faults.next.json`, `${directory}/faults.json`);
}
const timings = { reads: [], commands: [], favorites: [] };
const started = performance.now();
async function request(path, body, timing) {
  const start = performance.now();
  const response = await globalThis.fetch(base + path, {
    method: body ? 'PUT' : 'GET',
    headers: { authorization: '031-45-154', 'Content-Type': 'application/hap+json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: globalThis.AbortSignal.timeout(10000),
  });
  assert.ok(response.ok, `HAP HTTP ${response.status}`);
  const text = await response.text();
  if (timing) {
    timings[timing].push(performance.now() - start);
  }
  return text ? JSON.parse(text) : {};
}
const decode = (value) => JSON.parse(Buffer.from(value, 'base64').toString());
const char = (a, type) => a.services.flatMap((s) => s.characteristics).find((c) => c.type.toUpperCase() === type);
const initial = await request('/accessories');
await writeFile(`${directory}/stress-initial-hap.json`, JSON.stringify(initial));
const sources = plans.map((plan) => {
  const source = initial.accessories.find((a) => char(a, '30')?.value === plan.deviceId);
  const favorite = initial.accessories.find((a) => char(a, '30')?.value === `${plan.deviceId}-favorites`);
  assert.ok(source && favorite);
  const catalog = decode(char(source, '5B530C0B-C1DF-496C-9151-52EAB77FD424').value).themes;
  const settings = char(source, '3D8F8A5E-06EC-4780-8C83-0DAAC35B7269');
  const saved = decode(settings.value);
  assert.deepEqual(new Set(catalog.map((t) => t.id)), new Set(plan.selectedIds));
  assert.deepEqual(saved.ids, plan.ids);
  assert.equal(favorite.services.filter((s) => s.type === '49').length, plan.ids.length);
  return {
    plan,
    aid: source.aid,
    catalog,
    settings: settings.iid,
    selection: char(source, 'AAEA8272-2EEC-40EC-8C03-0E15FCA30F18').iid,
    power: char(source, '25').iid,
  };
});
const favoriteCount = sources.reduce((n, s) => n + s.plan.ids.length, 0);
assert.ok(favoriteCount >= 700, 'Populate at least 700 favorites before running the stress fixture');
// Repeated full reads include every catalog and switch, rather than a small mocked response.
await Promise.all(
  Array.from({ length: 5 }, async () => {
    for (let i = 0; i < 10; i++) {
      await request('/accessories', undefined, 'reads');
    }
  }),
);
const readState = async (s) => decode((await request(`/characteristics?id=${s.aid}.${s.settings}`)).characteristics[0].value);
const writeState = (s, state) =>
  request(
    '/characteristics',
    { characteristics: [{ aid: s.aid, iid: s.settings, value: Buffer.from(JSON.stringify(state)).toString('base64'), r: true }] },
    'favorites',
  );
// Twenty concurrent writers start from each lamp's same revision: only one may win.
let conflicts = 0;
for (const s of sources) {
  const state = await readState(s);
  const results = await Promise.all(Array.from({ length: 20 }, () => writeState(s, state)));
  const successes = results.filter((r) => r.characteristics[0].status === 0).length;
  assert.equal(successes, 1);
  conflicts += results.length - successes;
  const after = await readState(s);
  assert.equal(after.revision, state.revision + 1);
  assert.deepEqual(after.ids, state.ids);
}
// Rotate favorite membership repeatedly while preserving each device's list size and library subset.
for (let round = 0; round < 25; round++) {
  await Promise.all(
    sources.map(async (s) => {
      const state = await readState(s);
      const candidates = s.catalog.map((t) => t.id).filter((id) => !s.plan.ids.slice(0, -1).includes(id));
      const ids = [...s.plan.ids.slice(0, -1), candidates[round % candidates.length]];
      const result = await writeState(s, { ...state, ids });
      assert.equal(result.characteristics[0].status, 0);
      assert.deepEqual((await readState(s)).ids, ids);
    }),
  );
}
for (const s of sources) {
  const state = await readState(s);
  assert.equal((await writeState(s, { ...state, ids: s.plan.ids })).characteristics[0].status, 0);
}
// Requests address different choices on all lamps; no command may leak to a different identity.
const beforeCommands = (await readFile(`${directory}/commands.jsonl`, 'utf8')).trim().split('\n').filter(Boolean).length;
for (let round = 0; round < 100; round++) {
  const result = await request(
    '/characteristics',
    {
      characteristics: sources.map((s) => ({
        aid: s.aid,
        iid: s.selection,
        value: s.plan.ids[round % s.plan.ids.length],
      })),
    },
    'commands',
  );
  assert.ok(!result.characteristics || result.characteristics.every((c) => c.status === 0));
}
const commands = (await readFile(`${directory}/commands.jsonl`, 'utf8'))
  .trim()
  .split('\n')
  .filter(Boolean)
  .slice(beforeCommands)
  .map(JSON.parse);
assert.equal(commands.length, 1200);
for (const s of sources) {
  const actual = commands.filter((c) => c.deviceId === s.plan.deviceId);
  assert.equal(actual.length, 100);
  // Catalog aliases may change map order. Match fixture identities, not their list position.
  const selected = s.plan.ids[99 % s.plan.ids.length];
  const index = Array.from({ length: flags.catalogSize }, (_, i) => i).find(i =>
    createHash('sha256').update(`projects/example/databases/(default)/documents/app-lighting-effects/theme-${i}`).digest('hex') === selected);
  assert.notEqual(index, undefined);
  assert.equal(actual.at(-1).command, `THEME.FIXTUREtheme-${index}.0,`);
}
const active = await request('/accessories');
for (const s of sources) {
  const accessory = active.accessories.find((a) => char(a, '30')?.value === `${s.plan.deviceId}-favorites`);
  const on = accessory.services
    .filter((service) => service.type === '49')
    .filter((service) => service.characteristics.find((c) => c.type === '25').value);
  assert.equal(on.length, 1);
  const metadata = on[0].characteristics.find((c) => c.type === 'C48B8A28-40D3-4F51-B51C-A5D39D985991');
  assert.equal(JSON.parse(metadata.value).id, s.plan.ids[99 % s.plan.ids.length]);
}
await request('/characteristics', { characteristics: sources.map((s) => ({ aid: s.aid, iid: s.power, value: false })) });
// A slow transport forces the per-device queue to reach its bounded capacity.
await setFlags({ ...flags, controlDelayMs: 100 });
let burstAccepted = 0;
let burstRejected = 0;
try {
  const attempts = await Promise.allSettled(
    Array.from({ length: 32 }, (_, i) =>
      request('/characteristics', {
        characteristics: sources.map((s) => ({ aid: s.aid, iid: s.selection, value: s.plan.ids[i % s.plan.ids.length] })),
      }),
    ),
  );
  assert.ok(
    attempts.every((result) => result.status === 'fulfilled'),
    'All bounded burst requests must complete',
  );
  const burst = attempts.flatMap((result) => result.value.characteristics ?? sources.map(() => ({ status: 0 })));
  for (const result of burst) {
    if (result.status === 0) {
      burstAccepted++;
    } else {
      assert.equal(result.status, -70403);
      burstRejected++;
    }
  }
  assert.ok(burstAccepted >= sources.length && burstRejected > 0);
  await setFlags({ ...flags, controlFailure: true });
  const failed = await request('/characteristics', {
    characteristics: sources.map((s) => ({ aid: s.aid, iid: s.selection, value: s.plan.ids[0] })),
  });
  assert.equal(failed.characteristics.length, 12);
  assert.ok(failed.characteristics.every((c) => c.status === -70402));
} finally {
  await setFlags(flags);
}
const recovered = await request('/characteristics', {
  characteristics: sources.map((s) => ({ aid: s.aid, iid: s.selection, value: s.plan.ids[0] })),
});
assert.ok(!recovered.characteristics || recovered.characteristics.every((c) => c.status === 0));
// Turning on every favorite together is ambiguous. Reject it rather than choosing an arbitrary theme.
const populatedHap = await request('/accessories');
const commandCountBeforeAmbiguous = (await readFile(`${directory}/commands.jsonl`, 'utf8')).trim().split('\n').length;
const ambiguous = await request('/characteristics', {
  characteristics: populatedHap.accessories
    .filter((a) => char(a, '30')?.value?.startsWith('stress-') && char(a, '30')?.value?.endsWith('-favorites'))
    .flatMap((a) =>
      a.services
        .filter((service) => service.type === '49')
        .map((service) => ({
          aid: a.aid,
          iid: service.characteristics.find((c) => c.type === '25').iid,
          value: true,
        })),
    ),
});
assert.equal(ambiguous.characteristics.length, favoriteCount);
assert.ok(ambiguous.characteristics.every((c) => c.status === -70410));
assert.equal((await readFile(`${directory}/commands.jsonl`, 'utf8')).trim().split('\n').length, commandCountBeforeAmbiguous);
await request('/characteristics', { characteristics: sources.map((s) => ({ aid: s.aid, iid: s.power, value: false })) });
const final = await request('/accessories');
const shape = (data) =>
  data.accessories
    .map((a) => [a.aid, a.services.map((s) => [s.iid, s.type, s.characteristics.map((c) => [c.iid, c.type]).sort()]).sort()])
    .sort();
assert.deepEqual(shape(final), shape(initial));
await writeFile(`${directory}/stress-final-hap.json`, JSON.stringify(final));
const percentile = (values, p) => Math.round([...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)] * 100) / 100;
const summary = {
  catalogThemes: 500,
  lamps: 12,
  libraryEntries: 3400,
  favorites: favoriteCount,
  fullReads: 50,
  concurrentFavoriteAttempts: 240,
  expectedConflicts: conflicts,
  successfulMembershipEdits: 312,
  routedThemeCommands: commands.length,
  burstAccepted,
  burstRejected,
  recoveredLamps: 12,
  ambiguousWritesRejected: favoriteCount,
  identitiesPreserved: true,
  elapsedMs: Math.round(performance.now() - started),
  latencyMs: Object.fromEntries(
    Object.entries(timings).map(([name, values]) => [
      name,
      { p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: Math.max(...values) },
    ]),
  ),
};
await writeFile(`${directory}/stress-results.json`, JSON.stringify(summary, null, 2));
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
