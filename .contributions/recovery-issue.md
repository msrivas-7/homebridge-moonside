# Cached theme controls are removed before cloud discovery finishes

**Describe The Bug:**

Restoring a theme accessory applies an empty theme list before the catalog loads. This removes cached Outlet services and can expire their HomeKit IDs. Retained services also need their command handlers attached after a restart.

**To Reproduce:**

1. Configure two theme switches and serialize the accessory.
2. Restore it and run HAP identifier assignment before loading the catalog.
3. Load the catalog and trigger each restored switch.
4. Repeat with a failed catalog request followed by a successful retry.

**Expected behavior:**

Keep the services and their IDs while discovery is pending or fails. After discovery succeeds, each switch should send its selected command.

**Logs:**

Three synthetic HAP tests reproduce the failures on upstream a658fc4. No live account or device logs are needed.

**Plugin Config:**

```json
{
  "themeSwitches": ["Ocean", "Sunset"]
}
```

**Screenshots:**

Not applicable. The reproduction checks cached services, identifiers and delivered commands.

**Environment:**

Plugin 0.1.0, Homebridge 2.0.0 beta.55 development dependency, Node 24.20.0, npm 11.19.0, macOS 27.0 on Apple Silicon.

This is separate from the cloud connection problem in #1. Happy to provide more details or adjust the reproduction.
