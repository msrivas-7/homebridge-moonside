import { Buffer } from 'node:buffer';
import { setImmediate } from 'node:timers';
import { THEME_CATALOG_UUID, THEME_SELECTION_UUID } from '../dist/themeCatalogControl.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import hap from 'hap-nodejs';
import { MoonsideCloudPlatform } from '../dist/platform.js';
import { THEME_FAVORITES_UUID, encodeFavorites, decodeFavorites } from '../dist/themeFavoritesControl.js';
import { themeFavoriteId } from '../dist/favoriteThemeAccessory.js';
const themes=[{ id:'a',name:'Ocean',controlData:'TEST.A' },{ id:'b',name:'Fire',controlData:'TEST.B' }];
const log={ info(){},warn(){},debug(){},error(){} };

class SimulatedAccessory extends hap.Accessory {
  context = {};
}

function platform(path, options = {}) {
  const registered=[]; const removed=[]; const commands=[]; const updated=[];
  const api={ hap,user:{ storagePath:()=>path },on(){},platformAccessory:SimulatedAccessory,
    registerPlatformAccessories(_plugin,_platform,items){
      registered.push(...items);
    },
    updatePlatformAccessories(items){
      updated.push(...items);
    },unregisterPlatformAccessories(_plugin,_platform,items){
      removed.push(...items);
    } };
  const app=new MoonsideCloudPlatform(log,{ platform:'MoonsideCloud',themePicker:true, retainLegacyThemeSwitches: true, ...options },api);
  app.apiClient={ async sendControl(deviceId,command){
    commands.push({ deviceId,command });
  } };
  return { app,registered,removed,commands,updated };
}

test('fresh setup exposes only configured favorites and all command paths share selection', async t=>{
  const path=await mkdtemp(join(tmpdir(),'favorite-onboard-'));
  t.after(()=>rm(path,{ recursive:true,force:true }));
  const { app,registered,removed,commands }=platform(path);
  await app.registerOrUpdateAccessory('lamp-a',{ deviceName:'Lamp A',on:true });
  await app.registerOrUpdateThemeAccessory('lamp-a','Lamp A',themes);
  const source=app.accessories.get(hap.uuid.generate('lamp-a')).getService(hap.Service.Lightbulb);
  const settings=source.characteristics.find(c=>c.UUID===THEME_FAVORITES_UUID);
  assert.ok(settings);
  assert.equal(registered.filter(a=>a.context.isFavoriteThemeAccessory).length,0);
  await assert.rejects(settings.handleSetRequest(encodeFavorites({ version:1,revision:0,ids:[themeFavoriteId('not-configured')] })));
  await settings.handleSetRequest(encodeFavorites({ version:1,revision:0,ids:themes.map(t=>themeFavoriteId(t.id)) }));
  const favorite=registered.find(a=>a.context.isFavoriteThemeAccessory);
  const switches=favorite.services.filter(s=>s.UUID===hap.Service.Switch.UUID);
  assert.equal(switches.length,2);
  assert.equal(registered.filter(a=>a.context.isFavoriteThemeAccessory).length,1);
  await switches[0].getCharacteristic(hap.Characteristic.On).handleSetRequest(true);
  assert.deepEqual(commands,[{ deviceId:'lamp-a',command:'TEST.A' }]);
  const legacy=app.accessories.get(hap.uuid.generate('lamp-a:themes'));
  const fire=legacy.services.find(s=>s.subtype==='b');
  await fire.getCharacteristic(hap.Characteristic.On).handleSetRequest(true);
  assert.equal(switches[0].getCharacteristic(hap.Characteristic.On).value,false);
  assert.equal(switches[1].getCharacteristic(hap.Characteristic.On).value,true);
  await settings.handleSetRequest(encodeFavorites({ version:1,revision:1,ids:[] }));
  assert.ok(removed.includes(favorite));
  assert.ok(app.accessories.has(legacy.UUID));
  assert.equal(decodeFavorites(settings.value).revision,2);
});

test('saved favorites recover on restart and remain independent for multiple lamps',async t=>{
  const path=await mkdtemp(join(tmpdir(),'favorite-restart-'));
  t.after(()=>rm(path,{ recursive:true,force:true }));
  const initial=platform(path);
  for(const id of ['lamp-a','lamp-b']) {
    await initial.app.registerOrUpdateAccessory(id,{ deviceName:id,on:true });
    await initial.app.registerOrUpdateThemeAccessory(id,id,themes);
  }
  const source=initial.app.accessories.get(hap.uuid.generate('lamp-a')).getService(hap.Service.Lightbulb);
  await source.characteristics.find(c=>c.UUID===THEME_FAVORITES_UUID).handleSetRequest(encodeFavorites({ version:1,revision:0,ids:[themeFavoriteId('b')] }));
  const snapshot=[...initial.app.accessories.values()].map(a=>({ accessory:hap.Accessory.serialize(a),context:JSON.parse(JSON.stringify(a.context)) }));
  const restored=platform(path);
  snapshot.forEach(a=>{
    const restoredAccessory=hap.Accessory.deserialize(a.accessory);restoredAccessory.context=a.context;restored.app.configureAccessory(restoredAccessory);
  });
  for(const id of ['lamp-a','lamp-b']) {
    await restored.app.registerOrUpdateAccessory(id,{ deviceName:id,on:true });
    await restored.app.registerOrUpdateThemeAccessory(id,id,themes);
  }
  const favorite=restored.app.accessories.get(hap.uuid.generate('lamp-a:theme-favorites'));
  assert.ok(favorite);
  assert.equal(restored.app.accessories.has(hap.uuid.generate('lamp-b:theme-favorites')),false);
  const service=favorite.services.find(s=>s.UUID===hap.Service.Switch.UUID);
  assert.equal(service.subtype,themeFavoriteId('b'));
  assert.equal(service.getCharacteristic(hap.Characteristic.On).value,false);
  await service.getCharacteristic(hap.Characteristic.On).handleSetRequest(true);
  assert.deepEqual(restored.commands,[{ deviceId:'lamp-a',command:'TEST.B' }]);
});


test('reads do not republish unchanged accessories and cloud controls reconcile selection', async t => {
  const path = await mkdtemp(join(tmpdir(), 'favorite-reconcile-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const { app, updated } = platform(path);
  await app.registerOrUpdateAccessory('lamp-a', { deviceName: 'Lamp A', on: true });
  await app.registerOrUpdateThemeAccessory('lamp-a', 'Lamp A', themes);
  const source = app.accessories.get(hap.uuid.generate('lamp-a')).getService(hap.Service.Lightbulb);
  const settings = source.characteristics.find(c => c.UUID === THEME_FAVORITES_UUID);
  await settings.handleSetRequest(encodeFavorites({ version: 1, revision: 0, ids: themes.map(t => themeFavoriteId(t.id)) }));
  const count = updated.length;
  await settings.handleGetRequest();
  await settings.handleGetRequest();
  assert.equal(updated.length, count);
  const favorites = app.accessories.get(hap.uuid.generate('lamp-a:theme-favorites'));
  const fire = favorites.services.find(s => s.subtype === themeFavoriteId('b')).getCharacteristic(hap.Characteristic.On);
  app.observeControl('lamp-a', 'TEST.B');
  assert.equal(fire.value, true);
  app.observeControl('lamp-a', 'BRIGH50');
  assert.equal(fire.value, true);
  await source.getCharacteristic(hap.Characteristic.On).handleSetRequest(false);
  assert.equal(fire.value, false);
  app.observeControl('lamp-a', 'TEST.B');
  app.observeControl('lamp-a', 'COLOR001002003');
  assert.equal(fire.value, false);
});


test('new picker setups browse the catalog without publishing its legacy services', async t => {
  const path = await mkdtemp(join(tmpdir(), 'favorite-catalog-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const { app, commands } = platform(path, { retainLegacyThemeSwitches: undefined });
  await app.registerOrUpdateAccessory('lamp-a', { deviceName: 'Lamp A', on: true });
  await app.registerOrUpdateThemeAccessory('lamp-a', 'Lamp A', themes);
  assert.equal(app.accessories.size, 1);
  const source = app.accessories.get(hap.uuid.generate('lamp-a')).getService(hap.Service.Lightbulb);
  const catalog = source.characteristics.find(c => c.UUID === THEME_CATALOG_UUID);
  const payload = JSON.parse(Buffer.from(catalog.value, 'base64').toString('utf8'));
  assert.deepEqual(payload.themes, themes.map(t => ({ id: themeFavoriteId(t.id), name: t.name })));
  assert.equal(JSON.stringify(payload).includes('TEST.'), false);
  const selection = source.characteristics.find(c => c.UUID === THEME_SELECTION_UUID);
  await assert.rejects(selection.handleSetRequest('unknown'));
  await selection.handleSetRequest(themeFavoriteId('b'));
  assert.deepEqual(commands, [{ deviceId: 'lamp-a', command: 'TEST.B' }]);
  await app.registerOrUpdateThemeAccessory('lamp-a', 'Lamp A', [themes[0]]);
  await assert.rejects(selection.handleSetRequest(themeFavoriteId('b')));
  assert.equal(commands.length, 1);
});

test('legacy controls are retained by default for existing setups and removed only when requested', async t => {
  const path = await mkdtemp(join(tmpdir(), 'favorite-legacy-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const { app, removed } = platform(path);
  await app.registerOrUpdateAccessory('lamp-a', { deviceName: 'Lamp A', on: true });
  await app.registerOrUpdateThemeAccessory('lamp-a', 'Lamp A', themes);
  const uuid = hap.uuid.generate('lamp-a:themes');
  const legacy = app.accessories.get(uuid);
  app.config.retainLegacyThemeSwitches = undefined;
  await app.registerOrUpdateThemeAccessory('lamp-a', 'Lamp A', themes);
  assert.equal(app.accessories.get(uuid), legacy);
  app.config.retainLegacyThemeSwitches = false;
  await app.registerOrUpdateThemeAccessory('lamp-a', 'Lamp A', themes);
  assert.ok(removed.includes(legacy));
  assert.ok(app.accessories.has(hap.uuid.generate('lamp-a')));
});

test('ambiguous group On and failed commands preserve the previous theme selection', async t => {
  const path = await mkdtemp(join(tmpdir(), 'favorite-group-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const { app, commands } = platform(path, { retainLegacyThemeSwitches: undefined });
  await app.registerOrUpdateAccessory('lamp-a', { deviceName: 'Lamp A', on: true });
  await app.registerOrUpdateThemeAccessory('lamp-a', 'Lamp A', themes);
  const source = app.accessories.get(hap.uuid.generate('lamp-a')).getService(hap.Service.Lightbulb);
  await source.characteristics.find(c => c.UUID === THEME_FAVORITES_UUID)
    .handleSetRequest(encodeFavorites({ version: 1, revision: 0, ids: themes.map(t => themeFavoriteId(t.id)) }));
  const favorite = app.accessories.get(hap.uuid.generate('lamp-a:theme-favorites'));
  const controls = favorite.services.filter(s => s.UUID === hap.Service.Switch.UUID).map(s => s.getCharacteristic(hap.Characteristic.On));
  await controls[0].handleSetRequest(true);
  const results = await Promise.allSettled(controls.map(c => c.handleSetRequest(true)));
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.equal(commands.length, 1);
  assert.deepEqual(await Promise.all(controls.map(c => c.handleGetRequest())), [true, false]);
  app.apiClient.sendControl = async () => {
    throw new Error('Disconnected');
  };
  await assert.rejects(controls[1].handleSetRequest(true));
  assert.deepEqual(await Promise.all(controls.map(c => c.handleGetRequest())), [true, false]);
});


test('turning all favorites off powers down the lamp and remains off after a cloud read', async t => {
  const path = await mkdtemp(join(tmpdir(), 'favorite-stop-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const { app, commands } = platform(path);
  await app.registerOrUpdateAccessory('lamp-a', { deviceName: 'Lamp A', controlData: 'COLOR010020030', brightness: 65 });
  await app.registerOrUpdateThemeAccessory('lamp-a', 'Lamp A', themes);
  const source = app.accessories.get(hap.uuid.generate('lamp-a')).getService(hap.Service.Lightbulb);
  await source.characteristics.find(c => c.UUID === THEME_FAVORITES_UUID)
    .handleSetRequest(encodeFavorites({ version: 1, revision: 0, ids: themes.map(t => themeFavoriteId(t.id)) }));
  const controls = app.accessories.get(hap.uuid.generate('lamp-a:theme-favorites')).services
    .filter(s => s.UUID === hap.Service.Switch.UUID).map(s => s.getCharacteristic(hap.Characteristic.On));
  await controls[0].handleSetRequest(true);
  const deselected = [];
  controls[0].on('change', change => deselected.push(change.newValue));
  // A selection from the catalog must update the same native indicators.
  await source.characteristics.find(c => c.UUID === THEME_SELECTION_UUID).handleSetRequest(themeFavoriteId('b'));
  assert.deepEqual(await Promise.all(controls.map(c => c.handleGetRequest())), [false, true]);
  assert.ok(deselected.includes(false), 'The previously selected switch emits its Off update');
  await Promise.all(controls.map(c => c.handleSetRequest(false)));
  assert.equal(commands.at(-1).command, 'LEDOFF');
  app.accessoriesByDeviceId.get('lamp-a').updateFromCloud({ controlData: commands.at(-1).command });
  assert.deepEqual(await Promise.all(controls.map(c => c.handleGetRequest())), [false, false]);
  assert.equal(source.getCharacteristic(hap.Characteristic.Brightness).value, 65);
  assert.equal(source.getCharacteristic(hap.Characteristic.On).value, false);
  const count = commands.length;
  await controls[0].handleSetRequest(false);
  assert.equal(commands.length, count);
  await controls[1].handleSetRequest(true);
  app.apiClient.sendControl = async () => {
    throw new Error('Disconnected');
  };
  await assert.rejects(controls[1].handleSetRequest(false));
  assert.deepEqual(await Promise.all(controls.map(c => c.handleGetRequest())), [false, true]);
});


test('normal colors override themes, brightness preserves them, and stale polling cannot restore an old selection', async t => {
  const path = await mkdtemp(join(tmpdir(), 'favorite-transitions-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const { app } = platform(path);
  await app.registerOrUpdateAccessory('lamp-a', { deviceName: 'Lamp A', on: true });
  await app.registerOrUpdateThemeAccessory('lamp-a', 'Lamp A', themes);
  const source = app.accessories.get(hap.uuid.generate('lamp-a')).getService(hap.Service.Lightbulb);
  await source.characteristics.find(c => c.UUID === THEME_FAVORITES_UUID)
    .handleSetRequest(encodeFavorites({ version: 1, revision: 0, ids: themes.map(t => themeFavoriteId(t.id)) }));
  const controls = app.accessories.get(hap.uuid.generate('lamp-a:theme-favorites')).services
    .filter(s => s.UUID === hap.Service.Switch.UUID).map(s => s.getCharacteristic(hap.Characteristic.On));
  const read = () => Promise.all(controls.map(c => c.handleGetRequest()));
  await app.applyTheme('lamp-a', themes[0]);
  await source.getCharacteristic(hap.Characteristic.Brightness).handleSetRequest(45);
  assert.deepEqual(await read(), [true, false]);
  await source.getCharacteristic(hap.Characteristic.On).handleSetRequest(false);
  assert.deepEqual(await read(), [false, false]);
  await source.getCharacteristic(hap.Characteristic.On).handleSetRequest(true);
  assert.deepEqual(await read(), [true, false]);
  await source.getCharacteristic(hap.Characteristic.Hue).handleSetRequest(120);
  assert.deepEqual(await read(), [false, false]);
  await source.getCharacteristic(hap.Characteristic.On).handleSetRequest(false);
  await source.getCharacteristic(hap.Characteristic.On).handleSetRequest(true);
  assert.deepEqual(await read(), [false, false]);
  const lamp = app.accessoriesByDeviceId.get('lamp-a');
  let releasePoll;
  app.apiClient.getDeviceState = () => new Promise(resolve => {
    releasePoll = resolve;
  });
  const polling = lamp.pollState();
  await app.applyTheme('lamp-a', themes[1]);
  releasePoll({ controlData: themes[0].controlData });
  await polling;
  assert.deepEqual(await read(), [false, true]);
});

test('new theme intent cancels unsent color changes and rapid commands preserve their order', async t => {
  const path = await mkdtemp(join(tmpdir(), 'favorite-race-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const { app, commands } = platform(path);
  await app.registerOrUpdateAccessory('lamp-a', { deviceName: 'Lamp A', on: true });
  await app.registerOrUpdateThemeAccessory('lamp-a', 'Lamp A', themes);
  const source = app.accessories.get(hap.uuid.generate('lamp-a')).getService(hap.Service.Lightbulb);
  const pendingColor = source.getCharacteristic(hap.Characteristic.Hue).handleSetRequest(90);
  const results = await Promise.allSettled([pendingColor, app.applyTheme('lamp-a', themes[0])]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
  assert.deepEqual(commands, [{ deviceId: 'lamp-a', command: themes[0].controlData }]);
  assert.equal(app.accessoriesByDeviceId.get('lamp-a').colorUpdateTimeout, undefined);
  let release;
  const sent = [];
  app.apiClient.sendControl = async (_device, command, timeoutMs) => {
    sent.push(command);
    assert.ok(timeoutMs > 0 && timeoutMs <= 8000);
    if (sent.length === 1) {
      await new Promise(resolve => {
        release = resolve;
      });
    }
  };
  const inFlight = app.applyTheme('lamp-a', themes[1]);
  await new Promise(resolve => setImmediate(resolve));
  const brightness = source.getCharacteristic(hap.Characteristic.Brightness).handleSetRequest(40);
  const power = source.getCharacteristic(hap.Characteristic.On).handleSetRequest(false);
  assert.deepEqual(sent, [themes[1].controlData]);
  release();
  await Promise.all([inFlight, brightness, power]);
  assert.deepEqual(sent, [themes[1].controlData, 'BRIGH40', 'LEDOFF']);
  assert.equal(source.getCharacteristic(hap.Characteristic.On).value, false);
  assert.equal(app.controlQueue.size, 0);
  assert.equal(app.pendingControls.size, 0);
});


test('a saturated or expired command queue sends no extra commands and recovers', async t => {
  const path = await mkdtemp(join(tmpdir(), 'favorite-queue-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const { app } = platform(path);
  let clock = 0;
  t.mock.method(Date, 'now', () => clock);
  let release;
  const sent = [];
  app.apiClient.sendControl = async (_device, command) => {
    sent.push(command);
    if (sent.length === 1) {
      await new Promise(resolve => {
        release = resolve;
      });
    }
  };
  const first = app.sendControl('lamp-a', 'LEDON');
  await new Promise(resolve => setImmediate(resolve));
  const queued = Array.from({ length: 7 }, (_, i) => app.sendControl('lamp-a', `BRIGH${i + 1}`));
  const settled = Promise.allSettled(queued);
  await assert.rejects(app.sendControl('lamp-a', 'LEDOFF'));
  clock = 8001;
  release();
  await first;
  assert.ok((await settled).every(result => result.status === 'rejected'));
  assert.deepEqual(sent, ['LEDON']);
  assert.equal(app.pendingControls.size, 0);
  await app.sendControl('lamp-a', 'LEDOFF');
  assert.deepEqual(sent, ['LEDON', 'LEDOFF']);
});


test('favorites reconcile a known running theme during startup and when the shortlist changes', async t => {
  const path = await mkdtemp(join(tmpdir(), 'favorite-startup-state-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const { app } = platform(path);
  // Discovery learns the lamp state before the theme catalog is available.
  await app.registerOrUpdateAccessory('lamp-a', { deviceName: 'Lamp A', on: true, controlData: 'TEST.B' });
  await app.registerOrUpdateThemeAccessory('lamp-a', 'Lamp A', themes);
  const source = app.accessories.get(hap.uuid.generate('lamp-a')).getService(hap.Service.Lightbulb);
  const setting = source.characteristics.find(c => c.UUID === THEME_FAVORITES_UUID);
  await setting.handleSetRequest(encodeFavorites({ version: 1, revision: 0, ids: [themeFavoriteId('b')] }));
  const getOn = () => app.accessories.get(hap.uuid.generate('lamp-a:theme-favorites')).services
    .filter(s => s.UUID === hap.Service.Switch.UUID).map(s => Boolean(s.getCharacteristic(hap.Characteristic.On).value));
  assert.deepEqual(getOn(), [true]);
  await source.getCharacteristic(hap.Characteristic.Brightness).handleSetRequest(60);
  await setting.handleSetRequest(encodeFavorites({ version: 1, revision: 1, ids: [] }));
  await setting.handleSetRequest(encodeFavorites({ version: 1, revision: 2, ids: [themeFavoriteId('b')] }));
  assert.deepEqual(getOn(), [true]);
  await app.stopTheme('lamp-a');
  await setting.handleSetRequest(encodeFavorites({ version: 1, revision: 3, ids: themes.map(t => themeFavoriteId(t.id)) }));
  assert.deepEqual(getOn(), [false, false]);
});


test('a plugin-only upgrade keeps the default light and legacy switches without a picker UI', async t => {
  const path = await mkdtemp(join(tmpdir(), 'favorite-compatibility-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const { app, commands } = platform(path, { themePicker: false, retainLegacyThemeSwitches: undefined });
  await app.registerOrUpdateAccessory('lamp-a', { deviceName: 'Lamp A', on: true });
  await app.registerOrUpdateThemeAccessory('lamp-a', 'Lamp A', themes);
  const light = app.accessories.get(hap.uuid.generate('lamp-a')).getService(hap.Service.Lightbulb);
  assert.equal(light.characteristics.some(c => [THEME_FAVORITES_UUID, THEME_CATALOG_UUID, THEME_SELECTION_UUID].includes(c.UUID)), false);
  const legacy = app.accessories.get(hap.uuid.generate('lamp-a:themes'));
  assert.equal(legacy.services.filter(s => s.UUID === hap.Service.Outlet.UUID).length, 2);
  await legacy.services.find(s => s.subtype === 'b').getCharacteristic(hap.Characteristic.On).handleSetRequest(true);
  await light.getCharacteristic(hap.Characteristic.On).handleSetRequest(false);
  assert.deepEqual(commands, [{ deviceId: 'lamp-a', command: 'TEST.B' }, { deviceId: 'lamp-a', command: 'LEDOFF' }]);
  assert.equal(app.accessories.has(hap.uuid.generate('lamp-a:theme-favorites')), false);
});


test('99 favorites fit HAP and a 100th is rejected before storage or accessory mutation', async t => {
  const path = await mkdtemp(join(tmpdir(), 'favorite-capacity-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const { app } = platform(path, { retainLegacyThemeSwitches: false });
  const catalog = Array.from({ length: 100 }, (_, i) => ({ id: `t${i}`, name: `Theme ${i}`, controlData: `TEST.${i}` }));
  await app.registerOrUpdateAccessory('lamp-a', { deviceName: 'Lamp A', on: true });
  await app.registerOrUpdateThemeAccessory('lamp-a', 'Lamp A', catalog);
  const light = app.accessories.get(hap.uuid.generate('lamp-a')).getService(hap.Service.Lightbulb);
  const settings = light.characteristics.find(c => c.UUID === THEME_FAVORITES_UUID);
  const ids = catalog.map(theme => themeFavoriteId(theme.id));
  await settings.handleSetRequest(encodeFavorites({ version: 1, revision: 0, ids: ids.slice(0, 99) }));
  const accessory = app.accessories.get(hap.uuid.generate('lamp-a:theme-favorites'));
  assert.equal(accessory.services.length, 100);
  const before = [...accessory.services];
  await assert.rejects(settings.handleSetRequest(encodeFavorites({ version: 1, revision: 1, ids })));
  assert.deepEqual(decodeFavorites(await settings.handleGetRequest()), { version: 1, revision: 1, ids: ids.slice(0, 99) });
  assert.deepEqual(accessory.services, before);
  await settings.handleSetRequest(encodeFavorites({ version: 1, revision: 1, ids: ids.slice(1) }));
  assert.equal(accessory.services.length, 100);
  assert.ok(accessory.services.includes(before[2]));
});

test('many lamps keep catalogs and commands independent without one service per catalog entry', async t => {
  const path = await mkdtemp(join(tmpdir(), 'favorite-many-lamps-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const { app, commands } = platform(path, { retainLegacyThemeSwitches: false });
  const catalog = Array.from({ length: 500 }, (_, i) => ({ id: `t${i}`, name: `Theme ${i}`, controlData: `TEST.${i}` }));
  await Promise.all(Array.from({ length: 30 }, async (_, i) => {
    const id = `lamp-${i}`;
    await app.registerOrUpdateAccessory(id, { deviceName: 'Same name', on: true });
    await app.registerOrUpdateThemeAccessory(id, 'Same name', catalog);
    const source = app.accessories.get(hap.uuid.generate(id));
    assert.equal(source.services.length, 2);
    const light = source.getService(hap.Service.Lightbulb);
    const selection = light.characteristics.find(c => c.UUID === THEME_SELECTION_UUID);
    await selection.handleSetRequest(themeFavoriteId(`t${i}`));
  }));
  assert.equal(app.accessories.size, 30);
  assert.equal(commands.length, 30);
  for (let i = 0; i < 30; i++) {
    assert.deepEqual(commands.find(command => command.deviceId === `lamp-${i}`), { deviceId: `lamp-${i}`, command: `TEST.${i}` });
  }
});


test('a failed catalog request after restart preserves native favorites until discovery recovers', async t => {
  const path = await mkdtemp(join(tmpdir(), 'favorite-catalog-failure-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const initial = platform(path, { retainLegacyThemeSwitches: false, themeSwitches: ['Ocean', 'Fire'] });
  await initial.app.registerOrUpdateAccessory('lamp-a', { deviceName: 'Lamp A', on: true });
  await initial.app.registerOrUpdateThemeAccessory('lamp-a', 'Lamp A', themes);
  const source = initial.app.accessories.get(hap.uuid.generate('lamp-a')).getService(hap.Service.Lightbulb);
  await source.characteristics.find(c => c.UUID === THEME_FAVORITES_UUID)
    .handleSetRequest(encodeFavorites({ version: 1, revision: 0, ids: [themeFavoriteId('b')] }));
  const restored = platform(path, { retainLegacyThemeSwitches: false, themeSwitches: ['Ocean', 'Fire'] });
  for (const original of initial.app.accessories.values()) {
    const accessory = hap.Accessory.deserialize(hap.Accessory.serialize(original));
    accessory.context = JSON.parse(JSON.stringify(original.context));
    restored.app.configureAccessory(accessory);
  }
  const favorite = restored.app.accessories.get(hap.uuid.generate('lamp-a:theme-favorites'));
  const fire = favorite.services.find(s => s.subtype === themeFavoriteId('b'));
  restored.app.apiClient.fetchThemeLibrary = async () => {
    throw new Error('offline');
  };
  let onUpdate;
  restored.app.apiClient.subscribeToDeviceUpdates = async callback => {
    onUpdate = callback;
    return () => {};
  };
  await restored.app.startRealtimeStream(true);
  const unavailable = await restored.app.resolveThemeDefinitions();
  assert.equal(unavailable, undefined);
  const devices = new Map([['lamp-a', { deviceName: 'Lamp A', on: true, controlData: 'TEST.B' }]]);
  await restored.app.syncDeviceSnapshot(devices, unavailable);
  await onUpdate('lamp-a', { brightness: 42 });
  await onUpdate('lamp-b', { deviceName: 'Lamp B', on: true });
  assert.equal(restored.app.accessories.get(favorite.UUID), favorite);
  assert.ok(favorite.services.includes(fire));
  assert.equal(restored.removed.length, 0);
  await assert.rejects(fire.getCharacteristic(hap.Characteristic.On).handleSetRequest(true));
  restored.app.apiClient.fetchThemeLibrary = async () => new Map(themes.map(theme => [theme.name.toLowerCase(), theme]));
  await restored.app.syncDeviceSnapshot(devices, await restored.app.resolveThemeDefinitions());
  assert.equal(restored.app.accessories.get(favorite.UUID), favorite);
  assert.ok(favorite.services.includes(fire));
  await fire.getCharacteristic(hap.Characteristic.On).handleSetRequest(true);
  assert.deepEqual(restored.commands, [{ deviceId: 'lamp-a', command: 'TEST.B' }]);
});

test('theme and color commands keep inferred power through later brightness changes', async t => {
  const path = await mkdtemp(join(tmpdir(), 'favorite-inferred-power-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const { app } = platform(path, { retainLegacyThemeSwitches: false });
  await app.registerOrUpdateAccessory('lamp-a', { deviceName: 'Lamp A', on: false });
  const light = app.accessories.get(hap.uuid.generate('lamp-a')).getService(hap.Service.Lightbulb);
  const power = light.getCharacteristic(hap.Characteristic.On);
  const brightness = light.getCharacteristic(hap.Characteristic.Brightness);
  for (const command of ['THEME01,', 'COLOR255000000', 'PIXEL01,']) {
    await power.handleSetRequest(false);
    await app.sendControl('lamp-a', command);
    assert.equal(await power.handleGetRequest(), true);
    await brightness.handleSetRequest(45);
    assert.equal(await power.handleGetRequest(), true, `${command} must remain on after brightness`);
  }
  await power.handleSetRequest(false);
  await brightness.handleSetRequest(30);
  assert.equal(await power.handleGetRequest(), false, 'brightness alone must not turn an off lamp on');
  app.apiClient.sendControl = async () => {
    throw new Error('Disconnected');
  };
  await assert.rejects(app.sendControl('lamp-a', 'THEME01,'));
  assert.equal(await power.handleGetRequest(), false, 'failed theme commands must not change power');
});

test('equal theme commands retain the selected ID through every control path and cloud echoes', async t => {
  const path = await mkdtemp(join(tmpdir(), 'favorite-shared-command-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const { app } = platform(path);
  const shared = themes.map(theme => ({ ...theme, controlData: 'THEME01,' }));
  await app.registerOrUpdateAccessory('lamp-a', { deviceName: 'Lamp A', on: false });
  await app.registerOrUpdateThemeAccessory('lamp-a', 'Lamp A', shared);
  const light = app.accessories.get(hap.uuid.generate('lamp-a')).getService(hap.Service.Lightbulb);
  const setting = light.characteristics.find(c => c.UUID === THEME_FAVORITES_UUID);
  await setting.handleSetRequest(encodeFavorites({ version: 1, revision: 0, ids: shared.map(t => themeFavoriteId(t.id)) }));
  const favorite = app.accessories.get(hap.uuid.generate('lamp-a:theme-favorites'));
  const switches = favorite.services.filter(s => s.UUID === hap.Service.Switch.UUID)
    .map(s => s.getCharacteristic(hap.Characteristic.On));
  const read = () => Promise.all(switches.map(c => c.handleGetRequest()));
  const select = light.characteristics.find(c => c.UUID === THEME_SELECTION_UUID);
  await select.handleSetRequest(themeFavoriteId('b'));
  assert.deepEqual(await read(), [false, true]);
  const lamp = app.accessoriesByDeviceId.get('lamp-a');
  lamp.updateFromCloud({ controlData: 'THEME01,' });
  await light.getCharacteristic(hap.Characteristic.Brightness).handleSetRequest(45);
  assert.deepEqual(await read(), [false, true]);
  await switches[0].handleSetRequest(true);
  assert.deepEqual(await read(), [true, false]);
  await switches[1].handleSetRequest(true);
  assert.deepEqual(await read(), [false, true]);
  const legacy = app.accessories.get(hap.uuid.generate('lamp-a:themes'));
  await legacy.services.find(s => s.subtype === 'a').getCharacteristic(hap.Characteristic.On).handleSetRequest(true);
  assert.deepEqual(await read(), [true, false]);
  await setting.handleSetRequest(encodeFavorites({ version: 1, revision: 1, ids: [themeFavoriteId('b')] }));
  await select.handleSetRequest(themeFavoriteId('b'));
  assert.equal(await switches[1].handleGetRequest(), true, 'a later alias works when it is the only favorite');
  await light.getCharacteristic(hap.Characteristic.On).handleSetRequest(false);
  await light.getCharacteristic(hap.Characteristic.On).handleSetRequest(true);
  assert.equal(await switches[1].handleGetRequest(), true);
  app.apiClient.sendControl = async () => {
    throw new Error('Disconnected');
  };
  await assert.rejects(select.handleSetRequest(themeFavoriteId('a')));
  assert.equal(await switches[1].handleGetRequest(), true, 'a failed alias selection preserves the current ID');
});

test('broken favorites for one lamp do not stop discovery, realtime updates or later recovery', async t => {
  for (const failure of ['malformed', 'unreadable']) {
    await t.test(failure, async t => {
      const path = await mkdtemp(join(tmpdir(), 'favorite-damaged-file-'));
      t.after(() => rm(path, { recursive: true, force: true }));
      const options = { retainLegacyThemeSwitches: false, themeSwitches: ['Ocean', 'Fire'] };
      const initial = platform(path, options);
      await initial.app.registerOrUpdateAccessory('lamp-a', { deviceName: 'Lamp A', on: true });
      await initial.app.registerOrUpdateThemeAccessory('lamp-a', 'Lamp A', themes);
      const light = initial.app.accessories.get(hap.uuid.generate('lamp-a')).getService(hap.Service.Lightbulb);
      const setting = light.characteristics.find(c => c.UUID === THEME_FAVORITES_UUID);
      const saved = { version: 1, revision: 1, ids: [themeFavoriteId('b')] };
      await setting.handleSetRequest(encodeFavorites({ ...saved, revision: 0 }));
      const file = join(path, 'moonside-theme-favorites', `${themeFavoriteId('lamp-a')}.json`);
      if (failure === 'malformed') {
        await writeFile(file, '{broken');
      } else {
        await rm(file);
        await mkdir(file);
      }
      const restored = platform(path, { ...options, email: 'fixture@example.invalid', password: 'fixture' });
      for (const original of initial.app.accessories.values()) {
        const accessory = hap.Accessory.deserialize(hap.Accessory.serialize(original));
        accessory.context = JSON.parse(JSON.stringify(original.context));
        restored.app.configureAccessory(accessory);
      }
      const favorite = restored.app.accessories.get(hap.uuid.generate('lamp-a:theme-favorites'));
      const cachedSwitch = favorite.services.find(s => s.subtype === themeFavoriteId('b'));
      let onUpdate;
      restored.app.apiClient.fetchDevices = async () => new Map([
        ['lamp-a', { deviceName: 'Lamp A', on: true }],
        ['lamp-b', { deviceName: 'Lamp B', on: true }],
      ]);
      restored.app.apiClient.fetchThemeLibrary = async () => new Map(themes.map(theme => [theme.name.toLowerCase(), theme]));
      restored.app.apiClient.subscribeToDeviceUpdates = async callback => {
        onUpdate = callback;
        return () => {};
      };
      await restored.app.discoverDevices();
      assert.ok(restored.app.accessories.has(hap.uuid.generate('lamp-b')), 'later lamps must still be discovered');
      assert.equal(typeof onUpdate, 'function', 'discovery must still start realtime updates');
      await onUpdate('lamp-a', { brightness: 42 });
      await onUpdate('lamp-c', { deviceName: 'Lamp C', on: true });
      assert.ok(restored.app.accessories.has(hap.uuid.generate('lamp-c')));
      assert.equal(restored.app.accessories.get(favorite.UUID), favorite, 'cached automation targets must survive');
      const restoredLight = restored.app.accessories.get(hap.uuid.generate('lamp-a')).getService(hap.Service.Lightbulb);
      await restoredLight.getCharacteristic(hap.Characteristic.On).handleSetRequest(false);
      const restoredSetting = restoredLight.characteristics.find(c => c.UUID === THEME_FAVORITES_UUID);
      await assert.rejects(restoredSetting.handleSetRequest(encodeFavorites({ version: 1, revision: 0, ids: [] })));
      if (failure === 'malformed') {
        assert.equal(await readFile(file, 'utf8'), '{broken', 'a failed write must preserve the damaged file');
      } else {
        await rm(file, { recursive: true });
      }
      await writeFile(file, JSON.stringify(saved));
      await onUpdate('lamp-a', { on: true, controlData: 'TEST.B' });
      assert.deepEqual(decodeFavorites(await restoredSetting.handleGetRequest()), saved);
      assert.ok(favorite.services.includes(cachedSwitch));
      await cachedSwitch.getCharacteristic(hap.Characteristic.On).handleSetRequest(true);
      assert.equal(restored.commands.at(-1).command, 'TEST.B');
    });
  }
});
