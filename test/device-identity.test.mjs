import test from 'node:test';
import assert from 'node:assert/strict';
import hap from 'hap-nodejs';
import { isValidDeviceId } from '../dist/deviceIdentity.js';
import { MoonsideCloudPlatform } from '../dist/platform.js';
const log = { info(){},warn(){},error(){},debug(){} };
function platform() {
  return new MoonsideCloudPlatform(log, { platform:'MoonsideCloud' }, { hap,on(){},unregisterPlatformAccessories(){} });
}

test('invalid identities are rejected without assumptions about real vendor ID format', () => {
  for (const id of [null, undefined, '', ' ', 'null', 'NULL', ' undefined ']) {
    assert.equal(isValidDeviceId(id), false);
  }
  for (const id of ['valid-lamp', 'a-b-c', '0123']) {
    assert.equal(isValidDeviceId(id), true);
  }
});

test('successful discovery removes cached invalid devices without registering them again', async () => {
  const app = platform();
  const stale = new hap.Accessory('Duplicate', hap.uuid.generate('null'));
  stale.context = { device:{ deviceId:'null',name:'Duplicate' } };
  app.configureAccessory(stale);
  const registrations=[];
  app.registerOrUpdateAccessory=async id => {
    registrations.push(id);return 'Lamp';
  };
  app.registerOrUpdateThemeAccessory=async () => {};
  await app.syncDeviceSnapshot(new Map([['null',{ deviceName:'Duplicate' }],['real-id',{ deviceName:'Lamp' }]]), []);
  assert.deepEqual(registrations,['real-id']);
  assert.equal(app.accessories.has(stale.UUID),false);
});

test('realtime updates cannot recreate a literal null accessory', async () => {
  const app=platform();
  let update;
  app.apiClient={ async subscribeToDeviceUpdates(callback){
    update=callback;return ()=>{};
  } };
  app.registerOrUpdateAccessory=async () => {
    throw Error('invalid device registered');
  };
  await app.startRealtimeStream();
  await update('null',{ deviceName:'Duplicate' });
  await update('undefined',{ deviceName:'Duplicate' });
  await update('null',null);
  assert.equal(app.accessories.size,0);
});
