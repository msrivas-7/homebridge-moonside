import assert from 'node:assert/strict';
import test from 'node:test';
import hap from 'hap-nodejs';
import { ThemeCatalogControl, THEME_CATALOG_UUID, THEME_SELECTION_UUID } from '../dist/themeCatalogControl.js';
import { themeFavoriteId } from '../dist/favoriteThemeAccessory.js';

test('catalog size and entry validation preserve the last usable catalog and command map', async () => {
  const commands = [];
  const source = new hap.Service.Lightbulb('Fixture');
  const control = new ThemeCatalogControl({ api: { hap }, async applyTheme(device, theme) {
    commands.push({ device, theme });
  } }, source, 'fixture');
  const theme = { id: 'good', name: 'Océan 火', controlData: 'TEST.GOOD' };
  control.update([theme]);
  const catalog = source.characteristics.find(c => c.UUID === THEME_CATALOG_UUID);
  const selection = source.characteristics.find(c => c.UUID === THEME_SELECTION_UUID);
  const original = catalog.value;
  for (const invalid of [
    [{ ...theme, name: '' }],
    [{ ...theme, name: 'x'.repeat(257) }],
    Array.from({ length: 1001 }, (_, i) => ({ ...theme, id: String(i), name: 'x' })),
    Array.from({ length: 1000 }, (_, i) => ({ ...theme, id: String(i), name: 'x'.repeat(256) })),
  ]) {
    assert.throws(() => control.update(invalid));
    assert.equal(catalog.value, original);
  }
  await selection.handleSetRequest(themeFavoriteId(theme.id));
  assert.deepEqual(commands, [{ device: 'fixture', theme }]);
  control.destroy();
  await assert.rejects(selection.handleSetRequest(themeFavoriteId(theme.id)));
  assert.equal(commands.length, 1);
});
