# Keep cached theme controls through startup and catalog failures

Fixes #2

Startup currently removes cached theme services before discovery, which can expire their HomeKit IDs. Restored services also need fresh command handlers.

Treat an unavailable catalog separately from an empty list. Keep cached services until discovery succeeds, attach handlers to retained services, and use the latest theme command. Commands fail with a communication error while definitions are unavailable. An explicit empty list still removes themes.

Verified: three tests pass on Node 20, 22 and 24 and fail on the original source. They cover three serialized restarts, stable IDs, delivered commands, command updates, removal and a failed request followed by recovery. Build and lint pass. Update the existing CI job to run these tests.

Happy to adjust the approach based on feedback.
