import './network.mjs';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';
import { MoonsideCloudPlatform } from '../../dist/platform.js';
const require = createRequire(import.meta.url);
const hap = require('hap-nodejs');
const { CiaoAdvertiser } = require('hap-nodejs/dist/lib/Advertiser.js');
const directory = '/tmp/moonside-onboarding-e2e';
mkdirSync(`${directory}/hap`, { recursive: true });
hap.HAPStorage.setCustomStoragePath(`${directory}/hap`);
CiaoAdvertiser.prototype.startAdvertising = async () => {};
CiaoAdvertiser.prototype.updateAdvertisement = () => {};
const listen = hap.HAPServer.prototype.listen;
hap.HAPServer.prototype.listen = function (port) {
  return listen.call(this, port, '127.0.0.1');
};
const bridge = new hap.Bridge('Onboarding Fixture', hap.uuid.generate('onboarding-fixture-v1'));
bridge.disableUnusedIDPurge();
class Accessory extends hap.Accessory {
  context = {};
}
const config = JSON.parse(readFileSync(`${directory}/config.json`)).platforms.find((p) => p.platform === 'MoonsideCloud') ?? {
  platform: 'MoonsideCloud',
  email: 'demo@example.invalid',
  password: 'demo-only',
};
const events = new Map();
const logger = {
  info() {},
  debug() {},
  warn(...args) {
    appendFileSync(`${directory}/runtime.log`, JSON.stringify(args) + '\n');
  },
  error(...args) {
    appendFileSync(`${directory}/runtime.log`, JSON.stringify(args) + '\n');
  },
};
const platform = new MoonsideCloudPlatform(logger, config, {
  hap,
  platformAccessory: Accessory,
  on(e, callback) {
    events.set(e, callback);
  },
  user: { storagePath: () => directory },
  registerPlatformAccessories(_p, _n, accessories) {
    bridge.addBridgedAccessories(accessories);
  },
  unregisterPlatformAccessories(_p, _n, accessories) {
    accessories.forEach((a) => bridge.removeBridgedAccessory(a));
  },
  updatePlatformAccessories() {},
});
platform.apiClient.sendControl = async (deviceId, command) => {
  if (!['fixture-A', 'fixture-B', 'fixture-E'].includes(deviceId)) {
    throw new Error('Not a simulated lamp');
  }
  appendFileSync(`${directory}/commands.jsonl`, JSON.stringify({ deviceId, command }) + '\n');
  return { controlData: command };
};
let cached = [];
try {
  cached = JSON.parse(readFileSync(`${directory}/cached.json`));
} catch { /* First run has no cached accessories. */ }
for (const item of cached) {
  const accessory = hap.Accessory.deserialize(item);
  accessory.context = item.context ?? {};
  platform.configureAccessory(accessory);
  bridge.addBridgedAccessory(accessory);
}
const themes = await platform.resolveThemeDefinitions();
const devices = await platform.apiClient.fetchDevices();
for (const [id, state] of devices) {
  if (id === 'null') {
    continue;
  }
  await platform.registerOrUpdateAccessory(id, { ...state, on: false, brightness: 65 });
  await platform.registerOrUpdateThemeAccessory(id, state.deviceName ?? 'Unknown accessory', themes);
}
await bridge.publish({ username: '0E:12:34:56:79:CD', pincode: '031-45-154', port: 18801, bind: '127.0.0.1' }, true);
function save() {
  writeFileSync(
    `${directory}/cached.json`,
    JSON.stringify([...platform.accessories.values()].map((a) => ({ ...hap.Accessory.serialize(a), context: a.context }))),
  );
}
save();
process.on('SIGTERM', async () => {
  save();
  events.get('shutdown')?.();
  await bridge.unpublish();
  process.exit(0);
});
process.stdout.write('Simulated onboarding bridge: 127.0.0.1:18801\n');
