import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { MoonsideApiClient } from '../dist/moonsideApi.js';

test('a stalled control request times out without retrying', async t => {
  let requests = 0;
  const server = http.createServer(req => {
    requests++;
    req.resume();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const client = new MoonsideApiClient(log, 'fixture@example.invalid', 'unused');
  client.ensureAuthenticated = async () => {};
  client.buildDeviceUrl = () => `http://127.0.0.1:${server.address().port}/control`;
  const started = Date.now();
  await assert.rejects(client.sendControl('fixture', 'TEST'), error => error.name === 'TimeoutError');
  assert.ok(Date.now() - started < 10000);
  assert.equal(requests, 1);
});


test('authentication consumes the same deadline and cannot send a late command', async t => {
  let requests = 0;
  const server = http.createServer(req => {
    requests++; req.resume();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections(); server.close();
  });
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (_url, options) => originalFetch(`http://127.0.0.1:${server.address().port}/auth`, options));
  const client = new MoonsideApiClient({ debug() {}, info() {}, warn() {}, error() {} }, 'fixture@example.invalid', 'unused');
  const started = Date.now();
  await assert.rejects(client.sendControl('fixture', 'TEST', 100), error => error.name === 'TimeoutError');
  assert.ok(Date.now() - started < 1000);
  assert.equal(requests, 1);
});
