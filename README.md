<p align="center">
  <img src="https://github.com/homebridge/branding/raw/latest/logos/homebridge-wordmark-logo-horizontal.png" height="80" alt="Homebridge logo" />
  &nbsp;&nbsp;&nbsp;
  <img src="https://framerusercontent.com/assets/JXT3cocVpPqpPh0snX4kWibOAM.png" height="80" alt="Moonside logo" />
</p>

# Moonside for Homebridge

Control your Moonside lamps entirely through HomeKit.  
This plugin talks directly to Moonside’s official Firebase backend, keeps a realtime websocket open for instant updates, and exposes your favorite effects as stateless theme switches.

## Highlights

- 🔌 **Native HomeKit light accessories** – Power, brightness, color (Hue/Sat) and status updates stay in sync with the Moonside app.
- 🔁 **Realtime cloud stream** – Uses the same Firebase SSE channel as the app, so automations respond immediately.
- ✨ **Theme surge strip** – Provide theme names once and every lamp gains a “Lamp – Themes” accessory whose outlets trigger those effects (e.g., “Dancing Ocean”, “Awesome Theme”) and automatically reset after one second.

## Installation

1. Clone/download this repo and install dependencies:
   ```bash
   cd Homebridge/homebridge-moonside
   npm install
   npm run build
   ```
2. For development, link it to your local Homebridge:
   ```bash
   npm link
   ```
3. Add the platform to your Homebridge `config.json` (or via Config UI X) and restart Homebridge.

## Configuration

```jsonc
{
  "platform": "Moonside",
  "name": "Moonside",
  "email": "you@example.com",
  "password": "super-secret",
  "logLevel": "warning",
  "enablePolling": false,
  "pollingInterval": 60,
  "themeSwitches": [
    "Dancing Ocean",
    "Awesome Theme"
  ]
}
```

### Theme switches

- Each name in `themeSwitches` is looked up in Moonside’s effect catalog. When found, the plugin builds a surge-strip accessory named `<Lamp Name> – Themes` with outlets for every requested effect.
- Bare theme names ignore capitalization and repeated spaces. When titles match, the last catalog record wins, as before. To select a specific record, use its qualified catalog name: `<title> - <command> [theme:<path hash>]`. The suffix is the SHA-256 hash of the full Firestore document path. It stays the same when other records change.
- The `[theme:<64 hex digits>]` suffix is reserved for qualified selections. A title ending in that suffix must be selected by its own qualified name, so it cannot take over another theme's saved selection. Root collection themes keep their existing HomeKit service IDs; descendant collection themes use their full path to distinguish repeated document IDs.
- Flipping an outlet sends the corresponding `THEME.<code>` command and resets to “Off” after one second.
- If a name can’t be found, the plugin logs a warning but keeps running.

## Development

- `npm run watch` compiles TypeScript and restarts the bundled Homebridge test harness.
- Set `"logLevel": "debug"` while testing to dump every Firebase payload.
- The Firebase API key lives inside `src/moonsideApi.ts`; if Moonside rotates it, update the constant and rebuild.

## Roadmap

- [x] Cloud discovery + realtime streaming
- [x] Stateless theme switchboard
- [x] Cloud catalog lookup / accessory cleanup
- [ ] LAN / local protocol support
- [ ] Surface community/shared themes
- [ ] Auto-discover favorite/custom themes from the Moonside account

## Troubleshooting

- **Authentication errors** – Double-check email/password in the config. The plugin logs when it fails to swap refresh tokens.
- **Theme missing** – Use a catalog name or qualified name in `themeSwitches`. Matching ignores capitalization and repeated spaces. A renamed theme requires updating its configured name.
- **Accessory mismatch** – Delete the stale accessory from HomeKit and restart Homebridge; the plugin re-registers everything automatically.

Enjoy your Moonside lights with full HomeKit automation! If you build new features or crack the local protocol, feel free to open a PR.
