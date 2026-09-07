import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { SetupDraft } from '../homebridge-ui/public/model.js';
import { catalogChoices, lampChoices, prepareThemeSetup } from '../dist/themeOnboarding.js';

const themes = catalogChoices(
  new Map(
    Array.from({ length: 1000 }, (_, i) => [
      String(i),
      {
        id: `scale-${i}`,
        name: `Theme ${i}`,
        controlData: `THEME.SCALE${i}.0,`,
      },
    ]),
  ),
);
const lamps = Array.from({ length: 100 }, (_, i) => ({
  id: `scale-lamp-${i}`,
  name: 'Same lamp',
  favorites: { version: 1, revision: 0, ids: [] },
}));
function populated() {
  return {
    themeSetup: {
      version: 1,
      id: randomUUID(),
      mode: 'selected',
      selectedIds: themes.map((t) => t.id),
      lamps: lamps.map((lamp, i) => {
        const library = Array.from({ length: 200 }, (_, j) => themes[(i * 7 + j) % themes.length].id);
        return { deviceId: lamp.id, enabled: true, ids: library.slice(0, 99), selectedIds: library, expectedRevision: 0 };
      }),
    },
  };
}

test('100-device draft preserves 1000 themes and 9900 independent favorites', (t) => {
  const expected = populated();
  const started = performance.now();
  const draft = new SetupDraft(expected, { themes, lamps });
  const payload = draft.payload();
  const prepared = prepareThemeSetup(payload, themes, lamps);
  assert.equal(prepared.lamps.length, 100);
  assert.equal(
    prepared.lamps.reduce((count, lamp) => count + lamp.ids.length, 0),
    9900,
  );
  for (const [index, lamp] of prepared.lamps.entries()) {
    assert.deepEqual(lamp.ids, expected.themeSetup.lamps[index].ids);
    assert.ok(lamp.ids.every((id) => lamp.selectedIds.includes(id)));
  }
  const other = [...draft.favorites.get(lamps[1].id)];
  draft.favorite(lamps[0].id, prepared.lamps[0].ids[0], false);
  assert.deepEqual([...draft.favorites.get(lamps[1].id)], other);
  t.diagnostic(`Construct, validate and inspect populated draft: ${Math.round(performance.now() - started)} ms`);
});

test('clearing a large shared library also clears every smaller device library', () => {
  const draft = new SetupDraft(populated(), { themes, lamps });
  draft.clear();
  assert.equal(draft.selected.size, 0);
  for (const lamp of lamps) {
    assert.equal(draft.favorites.get(lamp.id).size, 0);
    assert.equal(draft.libraries.get(lamp.id).size, 0);
  }
  draft.select(themes[999].id, true);
  const result = prepareThemeSetup(draft.payload(), themes, lamps);
  assert.ok(result.lamps.every((lamp) => !lamp.selectedIds.length && !lamp.ids.length));
});

test('large drafts reject a 100th favorite without changing any device', () => {
  const draft = new SetupDraft(populated(), { themes, lamps });
  const before = JSON.stringify(draft.payload());
  for (const lamp of lamps) {
    const candidate = [...draft.libraries.get(lamp.id)].find((id) => !draft.favorites.get(lamp.id).has(id));
    assert.throws(() => draft.favorite(lamp.id, candidate, true), /99/);
  }
  assert.equal(JSON.stringify(draft.payload()), before);
});

test('catalog and account limits fail without truncating data', () => {
  assert.equal(themes.length, 1000);
  assert.throws(
    () =>
      catalogChoices(
        new Map(
          Array.from({ length: 1001 }, (_, i) => [
            i,
            {
              id: String(i),
              name: `Theme ${i}`,
              controlData: 'THEME.FIXTURE.0,',
            },
          ]),
        ),
      ),
    /size/,
  );
  assert.throws(
    () => lampChoices(new Map(Array.from({ length: 101 }, (_, i) => [`device-${i}`, { deviceName: 'Lamp' }]))),
    /100/,
  );
});
