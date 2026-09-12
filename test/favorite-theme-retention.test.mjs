import test from 'node:test';
import assert from 'node:assert/strict';
import hap from 'hap-nodejs';
import { FavoriteThemeAccessory, themeFavoriteId } from '../dist/favoriteThemeAccessory.js';

const themes = Array.from({ length: 99 }, (_, i) => ({ id: `memory-${i}`, name: `Theme ${i}`, controlData: `THEME.MEMORY${i}.0,` }));
const platform = { api: { hap }, Service: hap.Service, Characteristic: hap.Characteristic, config: { themePicker: true } };
const device = { deviceId: 'memory-lamp', name: 'Memory Lamp' };
const counts = accessory => accessory.services.map(service => service.optionalCharacteristics.length);

test('repeated favorite refreshes do not accumulate optional characteristics', () => {
  const accessory = new hap.Accessory('Memory Lamp Favorites', hap.uuid.generate('memory-refresh'));
  const handler = new FavoriteThemeAccessory(platform, accessory, device);
  const ids = themes.map(theme => themeFavoriteId(theme.id));
  handler.updateThemes(themes, ids);
  const before = counts(accessory);
  const services = [...accessory.services];
  for (let cycle = 0; cycle < 100; cycle++) {
    handler.updateThemes(themes.map(theme => ({ ...theme, name: `${theme.name} Version ${cycle}` })), ids);
  }
  assert.deepEqual(counts(accessory), before);
  assert.deepEqual(accessory.services, services);
  handler.destroy();
});

test('restoring a cache removes duplicate optional metadata without replacing published characteristics', () => {
  const original = new hap.Accessory('Memory Lamp Favorites', hap.uuid.generate('memory-cache'));
  const handler = new FavoriteThemeAccessory(platform, original, device);
  handler.updateThemes(themes.slice(0, 1), [themeFavoriteId(themes[0].id)]);
  const service = original.getService(hap.Service.Switch);
  for (let i = 0; i < 100; i++) {
    service.addOptionalCharacteristic(hap.Characteristic.ConfiguredName);
  }
  const restored = hap.Accessory.deserialize(hap.Accessory.serialize(original));
  const published = restored.getService(hap.Service.Switch).characteristics.map(c => c.UUID);
  const next = new FavoriteThemeAccessory(platform, restored, device);
  const optional = restored.getService(hap.Service.Switch).optionalCharacteristics;
  assert.equal(optional.filter(c => c.UUID === hap.Characteristic.ConfiguredName.UUID).length, 1);
  assert.deepEqual(restored.getService(hap.Service.Switch).characteristics.map(c => c.UUID), published);
  handler.destroy();
  next.destroy();
});
