import assert from 'node:assert/strict';
import { MoonsideApiClient } from '../dist/moonsideApi.js';
const requests = [];
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const doc = (id, name) => ({ document: { name: `projects/example/databases/(default)/documents/app-lighting-effects/${id}`, fields: { name: { stringValue: name }, themeControlCode: { stringValue: 'FIRE1' }, themeParams: { arrayValue: { values: [{ integerValue: '0' }] } } } } });
globalThis.fetch = async (url, options = {}) => {
  requests.push({ operation: options.method ?? 'GET', type: url.includes('signInWithPassword') ? 'login' : url.includes('runQuery') ? 'catalog' : 'devices' });
  if (url.includes('signInWithPassword')) {
    return Response.json({ idToken: 'fixture-token', refreshToken: 'fixture-refresh', localId: 'fixture-user', expiresIn: '3600' });
  }
  if (url.includes('runQuery')) {
    assert.equal(JSON.parse(options.body).structuredQuery.from[0].collectionId, 'app-lighting-effects');
    return Response.json([doc('a','Fire'), doc('b','Fire'), doc('c','Ocean'), {}, doc('invalid','  ')]);
  }
  assert.equal(options.method, undefined, 'research must never write a device');
  assert.ok(url.includes('/userDevices/fixture-user.json'));
  return Response.json({ 'lamp-a': { deviceName:'Same name', deviceModel:'Halo' }, 'lamp-b': { deviceName:'Same name', deviceModel:'Halo' } });
};
const client = new MoonsideApiClient(logger, 'fixture@example.invalid', 'fixture-only');
const devices = await client.fetchDevices();
const catalog = await client.fetchThemeLibrary();
assert.equal(devices.size, 2);
assert.equal(new Set([...catalog.values()].map(x=>x.id)).size,3);
assert.ok(catalog.size > 3, 'catalog aliases must be deduplicated by identity');
console.log(JSON.stringify({ requests, distinctThemes:3, lamps:2, duplicateTitlesPreserved:true, source:'synthetic HTTP responses passed through real client; no network or credentials used' }));
