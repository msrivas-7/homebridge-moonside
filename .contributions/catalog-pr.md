# Preserve catalog themes that share a title

Different theme documents can have the same title. Indexing by title drops entries and makes some themes impossible to select.

Keep records by document ID, normalize whitespace and add names containing the command and document ID. Keep those names when another record disappears. Existing bare names retain their previous lookup behavior. Selecting two names for one document creates only one service.

Verified: four tests pass on Node 20, 22 and 24 and fail on the original source. They cover duplicate titles, name collisions, reordered responses, catalog removal, duplicate selections and whitespace. Build and lint pass. CI now runs these tests.
