import { createRequire } from 'node:module';
import process from 'node:process';
if (process.env.UIX_STORAGE_PATH !== '/tmp/moonside-onboarding-e2e') {
  throw new Error('Fixture storage required');
}
const require = createRequire(process.env.THEME_TEST_UI + '/package.json');
const { HapClient } = require('@homebridge/hap-client');
HapClient.prototype.startDiscovery = function () {
  if (!this.instances.length) {
    this.instances = [
      {
        name: 'Onboarding Fixture',
        username: '0E:12:34:56:79:CD',
        ipAddress: '127.0.0.1',
        port: 18801,
        connectionFailedCount: 0,
        services: [],
        configurationNumber: 1,
      },
    ];
  }
};
