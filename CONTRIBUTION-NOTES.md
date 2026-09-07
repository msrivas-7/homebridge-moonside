# Prepared contributions

Branch: `dev/theme-stability`. Based on upstream `main` at `a658fc4`.
No pull request has been opened. No npm release or production installation was performed.

## Preserve cached themes through startup

Restoring an accessory used to apply an empty theme list before cloud discovery.
That removed its cached Outlet services and allowed HomeKit's identifier cache
to expire the IDs. Re-adding themes could then produce apparently duplicate or
unresponsive controls. Existing services also lacked newly bound On setters.

An unavailable catalog is now distinct from an explicitly empty catalog. Cached
services remain in place until discovery resolves; a failed request does not
remove them. Handlers are rebound to retained services and use the latest theme
command. Before definitions are available, commands fail with a HomeKit
communication error instead of reporting success without controlling the lamp.
An explicit empty list still removes services as expected.

## Keep catalog records with duplicate titles

Theme names are trimmed and internal whitespace collapsed. Records are keyed by
Firestore document ID before being grouped by title. Duplicate titles receive
command-qualified labels such as `Blue Raspberry - THEME1`; further collisions
receive deterministic numeric suffixes, including collisions with real catalog
names. Existing bare-name configurations retain the previous last-record lookup.
Selecting both a bare-name alias and its qualified name does not create duplicate
services for the same document. Qualified labels are stable for reordered records;
changes to the catalog membership can still change numeric suffixes.

This does not fetch private community-saved themes or resolve Wi-Fi/cloud pairing
problems. It does not claim to fix upstream issue #1.

## Validation

```sh
npm ci
npm test
npm run lint
```

Tests use Node's built-in runner, synthetic catalog responses and real HAP services
and IdentifierCache objects. They cover three serialized restarts (service and On
characteristic IDs plus delivered commands), refreshing commands without replacing
services, explicit removal, a failed cloud fetch followed by a successful retry,
three same-title catalog records, name collisions, reordered input, whitespace,
legacy aliases and duplicate selection. No real account, cloud call, network
advertisement or home configuration is needed.

Homebridge's development HAP dependency currently warns when ConfiguredName is
added to an Outlet; that existing plugin behavior is unchanged.
