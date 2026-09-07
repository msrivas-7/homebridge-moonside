# Contribution review

Both contributions are published in kylewhirl/homebridge-moonside:

| Change | Issue | PR |
| --- | --- | --- |
| Cached theme recovery | [#2](https://github.com/kylewhirl/homebridge-moonside/issues/2) | [#3](https://github.com/kylewhirl/homebridge-moonside/pull/3) |
| Catalog records | [#4](https://github.com/kylewhirl/homebridge-moonside/issues/4) | [#5](https://github.com/kylewhirl/homebridge-moonside/pull/5) |

## Separate changes

1. [Recovery issue](recovery-issue.md) and [PR](recovery-pr.md). Branch [dev/cached-theme-recovery](https://github.com/msrivas-7/homebridge-moonside/tree/dev/cached-theme-recovery), commit 45ab895.
2. [Catalog issue](catalog-issue.md) and [PR](catalog-pr.md). Branch [dev/theme-catalog-records](https://github.com/msrivas-7/homebridge-moonside/tree/dev/theme-catalog-records), commit 8b460e8.

Both branches start from a658fc4 and work independently. They merge together without conflicts. Shared test script and CI edits are identical. Draft documents are excluded from the proposed PR diffs.

## Submission order

The repository has no CONTRIBUTING.md. Its bug template asks for a description, reproduction, expected behavior, logs, config and environment. The drafts follow that structure without private data. The only existing issue is #1 about cloud controls; it does not describe these bugs. No matching PR was found. Recheck before posting.

The user authorized one issue followed by its linked PR for each bug. Both pairs are now open with separate branches and concise verification details. Each PR invites feedback; neither claims to fix #1.

## Verification

All seven regressions fail on the unmodified upstream source and pass on their respective fixed branches. The recovery branch has three tests; the catalog branch has four. Tests passed on Node 20.20.2, 22.23.2 and 24.20.0. Each branch also passes build and lint.

The HAP identifier tests serialize and restore accessories three times, check service and characteristic IDs, and verify the exact commands sent. Catalog tests cover duplicate titles and selections, record removal, reordered results and whitespace. These tests use synthetic data and no cloud calls.

The first draft lost a configured alias when the catalog shrank. A failing regression led to document ID based labels instead of positional suffixes. The test now passes. Build and test steps are wired into the existing CI workflow on each branch; hosted CI has not been claimed as run.

Existing bare names still resolve to the last matching record. Catalog title changes can still require updating configured names. These changes do not fetch private community themes or fix Wi-Fi pairing. They were not installed on the live lamp. HAP still emits the plugin's existing ConfiguredName warning during tests.

The checks found no further defect in scope. Live hardware and a full Homebridge 1.8 runtime were not retested for these source branches.

Both PRs target main in kylewhirl/homebridge-moonside and match the verified branch commits. Their issue links and file scopes were checked. GitHub reports no merge conflicts. Build and Lint runs report action_required before any jobs execute; hosted CI and maintainer review remain pending.
