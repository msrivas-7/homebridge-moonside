# Cached theme controls are removed before cloud discovery finishes

## Describe The Bug

Restoring a theme accessory applies an empty theme list before the catalog loads. This removes its cached Outlet services and can expire their HomeKit IDs. Retained services also need their command handlers attached again after a restart.

## To Reproduce

1. Configure two theme switches and serialize the accessory.
2. Restore it, then run the HAP identifier assignment before loading the catalog.
3. Load the catalog and trigger each restored switch.

The services should keep their IDs and send the selected commands. A catalog request failure should preserve them until a retry succeeds.

## Logs and Plugin Config

The included offline tests reproduce the failures using synthetic themes and HAP services. No real account or device logs are needed. The relevant config is `themeSwitches: ["Ocean", "Sunset"]`.

## Environment

Plugin 0.1.0 at a658fc4. Tests use Homebridge 2.0.0 beta.55 and its HAP dependency. Node 24.20.0, npm 11.19.0, macOS 27.0 on Apple Silicon.

This is separate from the cloud connection problem in issue #1.
