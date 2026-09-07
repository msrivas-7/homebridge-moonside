# Theme onboarding research and acceptance

Scope: local development and synthetic end-to-end verification only. No personal credentials, live Homebridge changes, real lamp commands, issues or PRs. Publish verified work only to the user's fork. Use dark mode throughout; check light mode at the end and return to dark.

## Observed API contract

The existing authenticated client reads `userDevices/<account>` and queries `app-lighting-effects`. The latter is a shared catalog, not a verified per-device compatibility list. The API contract probe uses synthetic HTTP responses through the real client, including authentication, to prove request shapes without contacting personal devices. Aliases must be deduplicated by identity. Canonical labels must be requested separately from legacy qualified lookup labels.

Sources: https://github.com/kylewhirl/homebridge-moonside#roadmap and https://developer.moonside.design/. The vendor's public developer page describes Bluetooth commands. It does not establish an account-custom-theme API or universal compatibility for Halo and other products. No private collection probing is authorized by this work.

Homebridge supports custom plugin settings through `homebridge-ui`, an IPC server and the existing configuration API. Follow host styling and Bootstrap conventions: https://github.com/homebridge/plugin-ui-utils. The custom server has only discovery and setup-preparation handlers, no device-control endpoints. It bounds network discovery and sanitizes errors before displaying them.

## User journey

Discover account devices and the general catalog. Select a shared theme library or select all. Choose which devices use themes, optionally narrow a device's library, and choose favorites only from that device's selected themes. Review, save and restart explicitly. Preserve manual theme switches and unrelated configuration.

Do not infer theme support from a device name or assume every account entry is a lamp. Treat absent compatibility metadata as unknown. Make theme participation explicit per device, preserve existing opted-in choices, and keep devices with themes disabled free of theme controls. Configured device subsets are user choices, not vendor compatibility claims. A new or unknown device must not inherit favorites from another device.

## Verification gates

* Isolated UI on 18800 and HAP on 18801, separate storage, suppressed advertisement and a network guard. No real-device calls.
* Discover, search, select all while filtered, clear, keyboard navigation, back/forward, favorites per device, save and reopen.
* Multiple same-named lamps; non-lighting/unknown devices; disabled themes; different per-device libraries; shared themes with different favorites; new/missing/returning devices; no devices and empty catalog.
* Alias records, duplicate titles, shared commands, hostile labels, malformed and oversized results, timeout/offline recovery, corrupt saved data, stale settings/favorites and lost save acknowledgements.
* Persistence and HomeKit identities through restart and theme disappearance/return. No command during discovery, browsing or save. Test actual command routing only on synthetic lamps.
* Desktop/mobile dark screenshots and browser journeys; light mode last. Build, lint, full regressions, clean packaging and fork-only push. Evidence screenshots stay outside product code.

Current baseline commit: 89f643e combines prior tested local work. The discovery/onboarding commits will remain distinct from this integration baseline. Upstream prerequisites remain unmerged; no claim of an independent PR against current upstream main.

## Results

Build, lint and 55 automated tests pass. The shipped custom UI server was exercised over IPC with the real API parser and synthetic responses. The discovery fixture accepts only test credentials, rejects device writes and blocks unrelated external requests. Runtime command routing was tested separately against a simulated lamp.

The browser journey covered a new account, invalid credentials, search, select all while filtered, clearing choices, per-device libraries and favorites, advanced setting preservation, review, save, reopen and restart. The mixed account contained two identically named lamps, a different lighting model, a device marked as not supporting themes and an unknown accessory. Their resulting libraries had two, four, one, zero and zero themes respectively, with separate favorites for the three enabled lamps.

Empty, malformed, oversized, offline and timed-out discovery produced recoverable errors. Editing the saved config after discovery rejected a stale save. Making the fixture config directory read-only produced a save error without changing the config; restoring access allowed a retry. This proves a rejected write, not every possible lost-response timing.

Temporarily removing a lamp preserved its setup profile. Removing and restoring a theme across fixture restarts retained accessory, service and characteristic identities. The unavailable switch returned HAP status -70402 without a command. Discovery, browsing and saving produced no device commands. One intentional command was routed to a simulated lamp during picker testing.

Screenshots and browser notes are held outside this package. The mobile form had equal client and scroll widths of 342 pixels at a 390 pixel viewport. Longer forms require ordinary vertical scrolling. UI screenshots use synthetic devices only.

Limits: this does not establish real API compatibility for arbitrary models, retrieve account custom/community themes, or add non-lighting accessory support. No real device was contacted or live installation changed. The fixture retains cached devices to exercise identity recovery; it does not prove how every real account deletion event behaves. The shared catalog API and authentication behavior remain vendor dependencies.

Dark mode was used throughout the main browser matrix. The final light-mode pass covered discovery, library selection, the disabled-device view and review on desktop and mobile. Dark mode and normal viewport sizing were restored afterward.
