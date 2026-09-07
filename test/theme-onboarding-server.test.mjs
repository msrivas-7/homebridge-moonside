import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

// Exercise the shipped IPC server with the real API parser and fixture-only network responses.
test('settings server discovers, validates, rejects stale saves and never exposes credentials or commands', async () => {
  const directory = await mkdtemp('/tmp/moonside-onboarding-case-');
  await writeFile(join(directory, 'config.json'), JSON.stringify({ platforms: [] }));
  const child = fork(fileURLToPath(new URL('../homebridge-ui/server.js', import.meta.url)), [], {
    silent: true,
    execArgv: ['--import', new URL('./fixtures/network.mjs', import.meta.url).href],
    env: {
      ...process.env,
      UIX_STORAGE_PATH: directory,
      HOMEBRIDGE_STORAGE_PATH: directory,
      HOMEBRIDGE_CONFIG_PATH: join(directory, 'config.json'),
    },
  });
  let logs = '';
  child.stdout.on('data', (data) => {
    logs += data;
  });
  child.stderr.on('data', (data) => {
    logs += data;
  });
  const request = (path, body) =>
    new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const receive = (message) => {
        if (message.payload?.requestId !== requestId) {
          return;
        }
        child.off('message', receive);
        if (!message.payload.success) {
          reject(new Error(message.payload.data.message));
        } else {
          resolve(message.payload.data);
        }
      };
      child.on('message', receive);
      child.send({ action: 'request', requestId, path, body });
    });
  try {
    await once(child, 'message');
    const before = await readFile(join(directory, 'config.json'), 'utf8');
    const data = await request('/discover', { email: 'demo@example.invalid', password: 'demo-only' });
    assert.equal(data.themes.length, 79);
    assert.equal(data.lamps.length, 2);
    assert.equal(JSON.stringify(data).includes('fixture-token'), false);
    assert.equal(JSON.stringify(data).includes('controlData'), false);
    const ids = [data.themes[0].id];
    const input = {
      version: 1,
      mode: 'selected',
      selectedIds: ids,
      lamps: data.lamps.map((lamp) => ({ deviceId: lamp.id, ids, expectedRevision: 0, enabled: true })),
    };
    const setup = await request('/prepare', input);
    assert.equal(setup.selectedIds.length, 1);
    assert.equal(await readFile(join(directory, 'config.json'), 'utf8'), before);
    await writeFile(
      join(directory, 'config.json'),
      JSON.stringify({ platforms: [{ platform: 'MoonsideCloud', name: 'Changed elsewhere' }] }),
    );
    await assert.rejects(request('/prepare', input), /changed/);
    await assert.rejects(request('/control', { deviceId: 'fixture-A', command: 'LEDON' }));
    assert.equal(logs.includes('demo-only'), false);
    assert.equal(logs.includes('fixture-token'), false);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
    await rm(directory, { recursive: true });
  }
});
