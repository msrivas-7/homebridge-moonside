# Theme catalog entries with the same title overwrite one another

## Describe The Bug

The catalog uses a lowercased title as its key. If two documents share a title, only the last is available. Extra whitespace can also prevent a configured name from matching.

## To Reproduce

1. Return two catalog documents with different IDs and the same title.
2. Fetch the theme library and try to select each document.
3. Repeat with extra whitespace in the title or configured name.

Each document should remain available, with a distinct name where needed. A saved selection must not change to another document when a neighboring entry disappears.

## Logs and Plugin Config

The tests stub the catalog response and use synthetic account values. No live account is needed. The relevant config is the themeSwitches list.

## Environment

Plugin 0.1.0 at a658fc4. Homebridge 2.0.0 beta.55 development dependency. Node 24.20.0, npm 11.19.0, macOS 27.0 on Apple Silicon.
