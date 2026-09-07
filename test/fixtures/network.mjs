import { readFileSync, appendFileSync } from 'node:fs';
import process from 'node:process';
const directory = process.env.UIX_STORAGE_PATH;
if (!directory || (directory !== '/tmp/moonside-onboarding-e2e' && !directory.startsWith('/tmp/moonside-onboarding-case-'))) {
  throw new Error('Fixture refuses any other storage directory');
}
const original = globalThis.fetch;
function flags() {
  try {
    return JSON.parse(readFileSync(`${directory}/faults.json`, 'utf8'));
  } catch {
    return {};
  }
}
function document(id, name) {
  return {
    document: {
      name: `projects/example/databases/(default)/documents/app-lighting-effects/${id}`,
      fields: {
        name: { stringValue: name },
        themeControlCode: { stringValue: `FIXTURE${id}` },
        themeParams: { arrayValue: { values: [{ integerValue: '0' }] } },
      },
    },
  };
}
export function catalog() {
  const f = flags();
  const records = [
    'Dancing Ocean',
    'Ghost Fire',
    'Magic Fire',
    'Rainbow Fire',
    'Blue Raspberry',
    'Blue Raspberry',
    '<img src=x onerror=alert(1)>',
  ];
  const names = [
    ...records,
    ...Array.from({ length: (f.large ? 1001 : 79) - records.length }, (_, i) => `Theme ${String(i + 8).padStart(3, '0')}`),
  ];
  return names.map((name, i) => document(`theme-${i}`, name)).filter((_, i) => !(f.remove ?? []).includes(i));
}
globalThis.fetch = async (input, options = {}) => {
  const url = new globalThis.URL(typeof input === 'string' ? input : (input.url ?? input));
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
    if (![18800, 18801].includes(Number(url.port))) {
      throw new Error('Fixture refuses other local services');
    }
    return original(input, options);
  }
  const f = flags();
  if (f.offline) {
    throw new Error('Simulated network unavailable');
  }
  if (f.slow) {
    await new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(resolve, 20000);
      options.signal?.addEventListener(
        'abort',
        () => {
          globalThis.clearTimeout(timer);
          reject(options.signal.reason);
        },
        { once: true },
      );
    });
  }
  if (url.hostname === 'identitytoolkit.googleapis.com') {
    const body = JSON.parse(options.body);
    if (body.email !== 'demo@example.invalid' || body.password !== 'demo-only') {
      return globalThis.Response.json({ error: 'INVALID_LOGIN_CREDENTIALS' }, { status: 400 });
    }
    return globalThis.Response.json({
      idToken: 'fixture-token',
      refreshToken: 'fixture-refresh',
      localId: 'fixture-user',
      expiresIn: '3600',
    });
  }
  if (url.hostname === 'firestore.googleapis.com' && url.pathname.endsWith(':runQuery')) {
    if (options.headers.Authorization !== 'Bearer fixture-token') {
      throw new Error('Fixture token required');
    }
    return globalThis.Response.json(f.malformed ? {} : f.empty ? [] : catalog());
  }
  if (url.hostname === 'moonside-501a1.firebaseio.com' && url.searchParams.get('auth') === 'fixture-token') {
    if ((options.method ?? 'GET') !== 'GET') {
      throw new Error('Fixture discovery must never send device writes');
    }
    if (url.pathname !== '/userDevices/fixture-user.json') {
      throw new Error('Unexpected device request');
    }
    return globalThis.Response.json(
      f.noLamps
        ? {}
        : Object.fromEntries(Object.entries({
          'fixture-A': { deviceName: 'Demo Halo', deviceModel: 'Halo' },
          'fixture-B': { deviceName: 'Demo Halo', deviceModel: 'Halo' },
          ...(f.mixed
            ? {
              'fixture-C': { deviceName: 'Desk device', deviceModel: 'No theme support reported', deviceType: 'socket' },
              'fixture-D': { deviceName: 'Unknown accessory' },
              'fixture-E': { deviceName: 'Accent lamp', deviceModel: 'Different lighting model' },
            }
            : {}),
          null: {},
        }).filter(([id]) => !(f.missingDevices ?? []).includes(id))),
    );
  }
  appendFileSync(`${directory}/blocked-network.log`, `${url.hostname}\n`);
  throw new Error('External networking is disabled in this fixture');
};
