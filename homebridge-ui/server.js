import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import { MoonsideApiClient } from '../dist/moonsideApi.js';
import { themeFavoriteId } from '../dist/favoriteThemeAccessory.js';
import { ThemeFavoritesStore } from '../dist/themeFavoritesStore.js';
import { catalogChoices, lampChoices, prepareThemeSetup } from '../dist/themeOnboarding.js';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

export class ThemeSetupServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    let session;
    const configSnapshot = async () => {
      const file = JSON.parse(await readFile(this.homebridgeConfigPath, 'utf8'));
      return JSON.stringify((file.platforms ?? []).filter((platform) => platform.platform === 'MoonsideCloud'));
    };
    let busy = false;
    const store = this.homebridgeStoragePath
      ? new ThemeFavoritesStore(join(this.homebridgeStoragePath, 'moonside-theme-favorites'))
      : undefined;
    const safe = (operation, failureMessage) => async (body) => {
      if (busy) {
        throw new RequestError('Discovery is already running. Please wait.', {});
      }
      busy = true;
      try {
        return await operation(body);
      } catch (error) {
        if (error instanceof RequestError) {
          throw error;
        }
        throw new RequestError(
          failureMessage ??
            'Could not complete discovery. Check your account details and connection, then try again. Saved settings are unchanged.',
          {},
        );
      } finally {
        busy = false;
      }
    };
    this.onRequest(
      '/discover',
      safe(async (body) => {
        session = undefined;
        if (
          !store ||
          typeof body?.email !== 'string' ||
          !body.email.trim() ||
          body.email.length > 320 ||
          typeof body.password !== 'string' ||
          !body.password ||
          body.password.length > 4096
        ) {
          throw new Error('Invalid account');
        }
        const quiet = { info() {}, warn() {}, error() {}, debug() {} };
        const client = new MoonsideApiClient(
          quiet,
          body.email.trim(),
          body.password,
          typeof body.firebaseApiKey === 'string' ? body.firebaseApiKey : undefined,
        );
        const baseline = await configSnapshot();
        const signal = AbortSignal.timeout(15000);
        const devices = lampChoices(await client.fetchDevices(signal));
        const library = await client.fetchThemeLibrary(signal, { qualifiedLabels: false });
        let themes;
        try {
          themes = catalogChoices(library);
        } catch (error) {
          throw new RequestError(error.message, {});
        }
        const names = Array.isArray(body.themeSwitches) ? body.themeSwitches.filter((name) => typeof name === 'string') : [];
        const configuredIds = [
          ...new Set(
            names
              .map((name) => library.get(name.trim().replace(/\s+/g, ' ').toLowerCase()))
              .filter(Boolean)
              .map((theme) => themeFavoriteId(theme.id)),
          ),
        ];
        const lamps = await Promise.all(devices.map(async (lamp) => ({ ...lamp, favorites: await store.read(lamp.id) })));
        session = { themes, lamps, configuredIds, baseline, email: body.email.trim() };
        return { themes, lamps, configuredIds };
      }),
    );
    this.onRequest(
      '/prepare',
      safe(async (body) => {
        if (!session || !store) {
          throw new Error('Discover first');
        }
        if ((await configSnapshot()) !== session.baseline) {
          throw new Error('Configuration changed');
        }
        const baseline = JSON.parse(session.baseline)[0];
        const stored = baseline?.email?.trim() === session.email ? baseline.themeSetup : undefined;
        const preserved = (stored?.lamps ?? [])
          .filter((plan) => !session.lamps.some((lamp) => lamp.id === plan.deviceId))
          .map((plan) => ({ ...plan, selectedIds: plan.selectedIds ?? [...(stored?.selectedIds ?? [])] }));
        const lamps = await Promise.all(session.lamps.map(async (lamp) => ({ ...lamp, favorites: await store.read(lamp.id) })));
        return prepareThemeSetup(body, session.themes, lamps, preserved, stored?.selectedIds ?? []);
      }, 'Setup could not be validated. Settings or favorites may have changed. Discover again before saving.'),
    );
    this.ready();
  }
}
new ThemeSetupServer();
