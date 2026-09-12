import assert from 'node:assert/strict';
import { test } from 'node:test';
import hap from 'hap-nodejs';
import { IdentifierCache } from 'hap-nodejs/dist/lib/model/IdentifierCache.js';
import { setThemePickerMetadata, THEME_PICKER_UUID } from '../dist/themePickerMetadata.js';

test('opt-in metadata preserves legacy control IDs through restart and rollback', () => {
  let lamp = new hap.Accessory('Lamp', hap.uuid.generate('picker-migration-test'));
  const outlet = lamp.addService(hap.Service.Outlet, 'Ocean', 'theme-id');
  outlet.getCharacteristic(hap.Characteristic.On);
  const cache = new IdentifierCache('CA:00:00:00:00:31');
  function assign() {
    cache.startTrackingUsage();
    lamp._assignIDs(cache);
    cache.stopTrackingUsageAndExpireUnused();
    return lamp.services.flatMap(service => [service.iid, ...service.characteristics
      .filter(characteristic => characteristic.UUID !== THEME_PICKER_UUID).map(characteristic => characteristic.iid)]);
  }
  const before = assign();
  const platform = { api: { hap }, config: { themePicker: true } };
  setThemePickerMetadata(platform, outlet, 'lamp-a', 'theme-id');
  const value = outlet.characteristics.find(item => item.UUID === THEME_PICKER_UUID).value;
  assert.deepEqual(assign(), before);
  lamp = hap.Accessory.deserialize(hap.Accessory.serialize(lamp));
  const restored = lamp.getService(hap.Service.Outlet);
  setThemePickerMetadata(platform, restored, 'lamp-a', 'theme-id');
  assert.equal(restored.characteristics.find(item => item.UUID === THEME_PICKER_UUID).value, value);
  assert.deepEqual(assign(), before);
  platform.config.themePicker = false;
  setThemePickerMetadata(platform, restored, 'lamp-a', 'theme-id');
  assert.ok(!restored.characteristics.some(item => item.UUID === THEME_PICKER_UUID));
  assert.deepEqual(assign(), before);
});

test('source and action metadata join only their lamp and contain no command or device ID', () => {
  const platform = { api: { hap }, config: { themePicker: true } };
  const build = (device, theme) => {
    const service = new hap.Service.Lightbulb('Test');
    setThemePickerMetadata(platform, service, device, theme);
    return JSON.parse(service.characteristics.find(item => item.UUID === THEME_PICKER_UUID).value);
  };
  const source = build('lamp-a');
  const action = build('lamp-a', 'catalog/path');
  assert.equal(source.group, action.group);
  assert.notEqual(source.group, build('lamp-b').group);
  assert.notEqual(action.id, build('lamp-a', 'catalog/other').id);
  assert.equal(action.id, build('lamp-a', 'catalog/path').id);
  assert.ok(JSON.stringify(action).length < 256);
  assert.ok(!JSON.stringify(action).includes('lamp-a'));
});
