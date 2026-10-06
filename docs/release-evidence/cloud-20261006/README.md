# Fresh cloud release evidence — 2026-10-06

All fixtures are synthetic. Runtime source is frontend `ad0af760bae86702526bd935ff6fc5fc17a172f9` and backend `c23ce45671e9d8bc9d153d65b277caae2f1513a2`. Documentation-only receipt commits are separate from these tested source identities.

The unit logs cover 25 frontend and 70 backend tests. Five browser reports cover 64 groups; 36 axe files contain empty violation arrays. The optional Worker request was intercepted and fulfilled locally. Browser checks do not prove live release correctness.

Read [independent-review/REVIEW.md](independent-review/REVIEW.md) for the independent source review, runnable offline checks, and conditional release recommendation. Those independent scripts require sibling checkouts at the exact source SHAs, not the later receipt commits. Use separate detached worktrees to reproduce them.

[../../../CLOUD_RELEASE_HANDOFF.md](../../../CLOUD_RELEASE_HANDOFF.md) and [../../../CLOUD_RELEASE_STATUS.json](../../../CLOUD_RELEASE_STATUS.json) record the authenticated HTTP 401 blocker and safe continuation. Nothing was deployed. `MANIFEST.json` records SHA-256 and byte length of every evidence file except itself. The frontend repository additionally includes four inspected desktop/mobile screenshots.
