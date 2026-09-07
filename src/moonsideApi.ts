import type { PluginLogger } from './logger.js';

const FIREBASE_API_KEY = 'AIzaSyCC-qQZqcZhxqsbO7GB0nXZShab9gV06Bk';
const FIREBASE_IDENTITY_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword';
const FIREBASE_TOKEN_REFRESH_URL = 'https://securetoken.googleapis.com/v1/token';
const REALTIME_DATABASE_URL = 'https://moonside-501a1.firebaseio.com';
const FIRESTORE_RUNQUERY_URL =
  'https://firestore.googleapis.com/v1/projects/moonside-501a1/databases/(default)/documents:runQuery';

export interface DeviceState {
  on?: boolean;
  brightness?: number;
  controlData?: string;
  deviceName?: string;
  deviceModel?: string;
  colorHEXDecimal?: number;
  [key: string]: unknown;
}

export interface ThemeDefinition {
  id: string;
  name: string;
  controlData: string;
}

type DeviceUpdateCallback = (deviceId: string, update: DeviceState | null) => void;
type StreamErrorCallback = (error: Error) => void;

interface FirebaseStreamPayload {
  path: string;
  data: unknown;
}

interface FirestoreField {
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
  arrayValue?: {
    values?: FirestoreField[];
  };
}

export class MoonsideApiClient {
  private idToken?: string;
  private refreshToken?: string;
  private tokenExpiry = 0;
  private localId?: string;
  private eventSourceRestartTimer?: NodeJS.Timeout;
  private streamAbortController?: AbortController;
  private readonly textDecoder = new TextDecoder();

  constructor(
    private readonly logger: PluginLogger,
    private readonly email: string,
    private readonly password: string,
    private readonly apiKey: string = FIREBASE_API_KEY,
  ) {}

  async getDeviceState(deviceId: string): Promise<DeviceState> {
    await this.ensureAuthenticated();
    const url = this.buildDeviceUrl(deviceId);
    const path = this.describeDevicePath(deviceId);
    this.logger.debug('GET %s', path);
    const response = await fetch(url);

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Failed to query Moonside cloud: ${response.status} ${response.statusText} - ${details}`);
    }

    const payload = await response.json() as DeviceState;
    this.logger.debug('GET %s -> %s', path, JSON.stringify(payload));
    return payload;
  }

  async sendControl(deviceId: string, controlData: string): Promise<DeviceState> {
    return this.patchDevice(deviceId, { controlData });
  }

  async patchDevice(deviceId: string, payload: Record<string, unknown>): Promise<DeviceState> {
    await this.ensureAuthenticated();
    const url = this.buildDeviceUrl(deviceId);
    const path = this.describeDevicePath(deviceId);
    this.logger.debug('PATCH %s <= %s', path, JSON.stringify(payload));
    const response = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Failed to patch device ${deviceId}: ${response.status} ${response.statusText} - ${details}`);
    }

    const body = await response.json() as DeviceState;
    this.logger.debug('PATCH %s -> %s', path, JSON.stringify(body));
    return body;
  }

  async fetchDevices(): Promise<Map<string, DeviceState>> {
    await this.ensureAuthenticated();
    const url = this.buildDevicesUrl();
    const response = await fetch(url);

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Failed to fetch devices: ${response.status} ${response.statusText} - ${details}`);
    }

    const data = await response.json() as Record<string, DeviceState> | null;
    const entries = Object.entries(data ?? {});
    return new Map(entries);
  }

  async fetchThemeLibrary(): Promise<Map<string, ThemeDefinition>> {
    await this.ensureAuthenticated();
    const body = {
      structuredQuery: {
        from: [
          {
            collectionId: 'app-lighting-effects',
            allDescendants: true,
          },
        ],
      },
    };

    const response = await fetch(`${FIRESTORE_RUNQUERY_URL}?key=${this.apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.idToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Failed to load theme catalog: ${response.status} ${response.statusText} - ${details}`);
    }

    const payload = await response.json() as Array<{ document?: { name: string; fields?: Record<string, FirestoreField> } }>;
    const definitions = new Map<string, ThemeDefinition>();

    for (const entry of payload) {
      const doc = entry.document;
      if (!doc?.fields) {
        continue;
      }

      const nameField = doc.fields.name;
      const commandField = doc.fields.themeControlCode;
      if (!nameField || nameField.stringValue === undefined || !commandField || commandField.stringValue === undefined) {
        continue;
      }

      const params = this.parseFirestoreArray(doc.fields.themeParams);
      const controlData = this.buildThemeCommand(commandField.stringValue, params);
      const id = doc.name?.split('/').pop() ?? nameField.stringValue;

      const name = nameField.stringValue.trim().replace(/\s+/g, ' ');
      if (!id || !name) {
        continue;
      }
      definitions.set(id, { id, name, controlData });
    }

    const groups = new Map<string, ThemeDefinition[]>();
    for (const definition of definitions.values()) {
      const key = definition.name.toLowerCase();
      const group = groups.get(key) ?? [];
      group.push(definition);
      groups.set(key, group);
    }

    const themes = new Map<string, ThemeDefinition>();
    // Preserve existing bare-name lookups, including the last-record rule.
    for (const [key, group] of groups) {
      themes.set(key, group[group.length - 1]);
    }

    // Qualify by document ID, not a position that can change when another
    // record disappears. Keep these aliases even when a title becomes unique.
    const usedNames = new Set(groups.keys());
    for (const definition of [...definitions.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      const command = definition.controlData.split('.')[1];
      let name = `${definition.name} - ${command} (${definition.id})`;
      while (usedNames.has(name.toLowerCase())) {
        name += ` (${definition.id})`;
      }
      usedNames.add(name.toLowerCase());
      themes.set(name.toLowerCase(), { ...definition, name });
    }
    return themes;
  }

  async subscribeToDeviceUpdates(
    onUpdate: DeviceUpdateCallback,
    onError?: StreamErrorCallback,
    onBeforeConnect?: () => Promise<void>,
  ): Promise<() => void> {
    const connect = async () => {
      try {
        await this.ensureAuthenticated();
        await onBeforeConnect?.();
        const url = this.buildDevicesUrl();
        this.streamAbortController?.abort();
        this.streamAbortController = new AbortController();

        this.logger.info('Opening Moonside realtime stream');
        await this.consumeEventStream(url, this.streamAbortController.signal, onUpdate);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        onError?.(error instanceof Error ? error : new Error(String(error)));
      } finally {
        if (!this.streamAbortController?.signal.aborted) {
          this.eventSourceRestartTimer = setTimeout(() => {
            void connect();
          }, 5000);
        }
      }
    };

    void connect();

    return () => {
      this.streamAbortController?.abort();
      if (this.eventSourceRestartTimer) {
        clearTimeout(this.eventSourceRestartTimer);
      }
    };
  }

  private parseFirestoreArray(field?: FirestoreField): number[] {
    if (!field || field.arrayValue?.values === undefined) {
      return [];
    }
    const values = field.arrayValue.values.map(value => {
      if (value.integerValue !== undefined) {
        return Number(value.integerValue);
      }
      if (value.doubleValue !== undefined) {
        return Number(value.doubleValue);
      }
      return 0;
    });
    return values;
  }

  private buildThemeCommand(code: string, params: number[]): string {
    const suffix = params.map(value => `${value},`).join('');
    return `THEME.${code}.${suffix}`;
  }

  private handleStreamPayload(payload: FirebaseStreamPayload, onUpdate: DeviceUpdateCallback) {
    const path = payload.path ?? '/';
    const data = payload.data;

    if (path === '/' && data && typeof data === 'object') {
      const entries = Object.entries(data as Record<string, DeviceState | null>);
      for (const [deviceId, state] of entries) {
        const decodedId = decodeURIComponent(deviceId);
        onUpdate(decodedId, state as DeviceState | null);
      }
      return;
    }

    const trimmed = path.startsWith('/') ? path.slice(1) : path;
    if (!trimmed) {
      return;
    }

    const segments = trimmed.split('/');
    const encodedDeviceId = segments.shift();
    if (!encodedDeviceId) {
      return;
    }
    const deviceId = decodeURIComponent(encodedDeviceId);

    if (data === null) {
      onUpdate(deviceId, null);
      return;
    }

    const inflated = this.inflateNestedData(segments, data);
    onUpdate(deviceId, inflated as DeviceState);
  }

  private inflateNestedData(keys: string[], value: unknown): unknown {
    if (!keys.length) {
      return value;
    }

    return keys.reduceRight((acc, key) => ({ [key]: acc }), value);
  }

  private async consumeEventStream(
    url: string,
    signal: AbortSignal,
    onUpdate: DeviceUpdateCallback,
  ) {
    const response = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
      signal,
    });

    if (!response.ok || !response.body) {
      const details = await response.text();
      throw new Error(`Failed to open realtime stream: ${response.status} ${response.statusText} - ${details}`);
    }

    const reader = response.body.getReader();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += this.textDecoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r/g, '');

      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const rawEvent = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 2);
        this.processSseEvent(rawEvent, onUpdate);
      }
    }
  }

  private processSseEvent(rawEvent: string, onUpdate: DeviceUpdateCallback) {
    if (!rawEvent) {
      return;
    }

    const lines = rawEvent.split('\n');
    let eventType = 'message';
    let dataPayload = '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataPayload += line.slice(5).trim();
      }
    }

    if (!dataPayload || (eventType !== 'put' && eventType !== 'patch')) {
      return;
    }

    if (this.logger.isDebugEnabled()) {
      this.logger.debug('Realtime event (%s): %s', eventType, dataPayload);
    }

    try {
      const payload = JSON.parse(dataPayload) as FirebaseStreamPayload;
      this.handleStreamPayload(payload, onUpdate);
    } catch (error) {
      this.logger.warn('Failed to parse realtime payload: %s', error instanceof Error ? error.message : String(error));
    }
  }

  private buildDeviceUrl(deviceId: string): string {
    if (!this.idToken || !this.localId) {
      throw new Error('Moonside client has not authenticated');
    }

    const encodedDevice = encodeURIComponent(deviceId);
    return `${REALTIME_DATABASE_URL}/userDevices/${this.localId}/${encodedDevice}.json?auth=${this.idToken}`;
  }

  private buildDevicesUrl(): string {
    if (!this.idToken || !this.localId) {
      throw new Error('Moonside client has not authenticated');
    }

    return `${REALTIME_DATABASE_URL}/userDevices/${this.localId}.json?auth=${this.idToken}`;
  }

  private describeDevicePath(deviceId: string): string {
    if (!this.localId) {
      return `userDevices/<unknown>/${deviceId}`;
    }
    return `userDevices/${this.localId}/${deviceId}`;
  }

  private async ensureAuthenticated() {
    const needsAuth = !this.idToken || Date.now() >= this.tokenExpiry;
    if (!needsAuth) {
      return;
    }

    if (!this.refreshToken) {
      await this.login();
      return;
    }

    try {
      await this.refresh();
    } catch (error) {
      this.logger.warn('Token refresh failed, logging in again.');
      await this.login();
    }
  }

  private async login() {
    this.logger.info('Authenticating with Moonside cloud as %s', this.email);
    const url = `${FIREBASE_IDENTITY_URL}?key=${this.apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: this.email,
        password: this.password,
        returnSecureToken: true,
      }),
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Moonside login failed: ${response.status} ${response.statusText} - ${details}`);
    }

    const payload = await response.json() as {
      idToken: string;
      refreshToken: string;
      localId: string;
      expiresIn: string;
    };

    this.idToken = payload.idToken;
    this.refreshToken = payload.refreshToken;
    this.localId = payload.localId;
    this.tokenExpiry = Date.now() + (parseInt(payload.expiresIn, 10) - 120) * 1000;
  }

  private async refresh() {
    if (!this.refreshToken) {
      await this.login();
      return;
    }

    const url = `${FIREBASE_TOKEN_REFRESH_URL}?key=${this.apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
      }),
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Token refresh failed: ${response.status} ${response.statusText} - ${details}`);
    }

    const payload = await response.json() as {
      id_token: string;
      refresh_token: string;
      user_id: string;
      expires_in: string;
    };

    this.idToken = payload.id_token;
    this.refreshToken = payload.refresh_token;
    this.localId = payload.user_id;
    this.tokenExpiry = Date.now() + (parseInt(payload.expires_in, 10) - 120) * 1000;
  }
}
