# Theme catalog entries with the same title overwrite one another

**Describe The Bug:**

The catalog uses a lowercased title as its key. If two documents share a title, only the last remains available. Extra whitespace can also prevent a configured name from matching.

**To Reproduce:**

1. Return two catalog documents with different IDs and the same title.
2. Fetch the theme library and try to select each document.
3. Repeat with extra whitespace in the title or configured name.

**Expected behavior:**

Keep both documents available through distinct names. A saved selection should still resolve to the same document when another catalog entry disappears.

**Logs:**

Four tests reproduce the failures on upstream a658fc4 using synthetic catalog responses and account values. No live account or device is needed.

**Plugin Config:**

```json
{
  "themeSwitches": ["Ocean"]
}
```

The test catalog contains two different documents named Ocean.

**Screenshots:**

Not applicable. The reproduction checks catalog lookup and selected theme definitions.

**Environment:**

Plugin 0.1.0, Homebridge 2.0.0 beta.55 development dependency, Node 24.20.0, npm 11.19.0, macOS 27.0 on Apple Silicon.

Happy to discuss the naming approach or provide more details.
