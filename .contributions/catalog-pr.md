# Preserve catalog themes that share a title

Fixes #4

Different theme documents can share a title or a leaf ID. Indexing by either drops records and makes some themes impossible to select.

Keep records by full document path and give each a qualified name with a stable path hash. Reserve that suffix so another title cannot take over a saved selection. Ordinary bare names keep their previous lookup behavior, and selecting two names for one record creates one service. Root collection service IDs stay unchanged; descendant records use their full path.

Verified: six offline tests pass on Node 20, 22 and 24. They cover duplicate titles and IDs, case differences, catalog reordering and removal, colliding titles, duplicate selections and whitespace. The two new review regressions fail before the fix. Build and lint pass. The existing CI job now runs the tests.

Happy to adjust the approach based on feedback.
