# Start here — EVAOS stateless brief validation

## Release state

2026-10-05: implementation reviewed and tests passing; **publication pending verification**. This document does not claim a live deployment. Source baseline: `c15db296c5a7dbf2cb5df40ba8fbe9443e578570`. Coordinated frontend: [Joinermill](https://github.com/Evaisawesome2025/joinermill), prior verified release `4123538bf18c4eb322c20247e23656625df40169`.

## What changed

`POST /brief/validate` validates six strings, normalizes whitespace, produces an exact plain-text work brief and returns its SHA-256. It is deterministic structure validation only: no AI judgment, model calls, research, job execution, user-content storage or body logging. Checklist items stay unverified. Input is explicitly sent by a frontend button with a processing disclosure. There are no new services or bindings.

The request is bounded to 32 KiB, a three-second body-read deadline, per-field limits and 1–12 checklist items. Responses use JSON and no-store, with allowlisted browser CORS origins. A fixed-size in-memory per-isolate bucket limits the new route to 60 requests/minute; this is best-effort, not a global traffic guarantee.

## Critical production continuity

The deployed Worker contains existing routes that were absent from repository main. `worker/preserved/deployed-514bf8c7.js` preserves the exact captured production module. `worker/src/release.js` delegates every existing route to it and handles only `/brief/validate` itself. This preserves existing behavior; it does not introduce the captured routes as new features. Main source also exposes the new route for regression testing.

**Do not publish with plain wrangler defaults:** checked-in configuration lacks part of the live setup. Read [worker/RELEASE.md](worker/RELEASE.md). The dedicated deployment helper retains all live binding types/settings in memory, checks current version/settings immediately before upload, and checks downloaded module hashes afterward. The provider API lacks atomic compare-and-swap, so a small concurrency race remains; coordinate publication and stop on mismatch. Use only existing authorized deployment access; never place credentials or raw settings in files or logs.

## Resume, test and roll back

1. Read [RELEASE_LOG.md](RELEASE_LOG.md), worker/RELEASE.md and current remote state before editing. Preserve concurrent changes.
2. `cd worker && npm test` — 70/70 tests passed at the implementation checkpoint, including the original 62. Tests use synthetic inputs/stores, check old-route delegation, unchanged captured-module hash, export fidelity, request limits, CORS and absence of binding/outbound accesses by the new route.
3. Keep `worker/src/brief-model.js` byte-identical to Joinermill's `preview/brief-model.js`. The frontend has 2 unit tests plus 13 browser regression groups and desktop/mobile accessibility checks.
4. Deploy backend first with the reviewed helper, then make harmless synthetic requests to `/brief/validate`, `/health` and protected-route refusals. Do not access live customer records for release tests. Publish frontend only after these pass.

The captured prior Worker version is `514bf8c7-30cb-4f8f-bc9e-2c08882a45e8`; its module is retained for safe code rollback. The helper's `--rollback --expected-version <our exact current release version>` guard restores that module while retaining settings. Inspect concurrent changes first. No KV/customer data rollback is part of this release. Never deploy the main baseline alone as a production rollback because it omits existing live routes.

## Holds, limitations and next steps

[Joinermill PR15](https://github.com/Evaisawesome2025/joinermill/pull/15) and [EVAOS PR32](https://github.com/Evaisawesome2025/evaos-v05/pull/32) remain held, unmerged and untouched. Existing frozen experiments are preserved. Pulse is an isolated controller prototype reported as completed but **UNSCORED**; its artifacts are not in this checkout, and this release does not deploy it or claim autonomy.

Next: reconcile the captured production source with maintainable source modules in a separate reviewed change, without activating held work. The brief service itself cannot judge whether a plan is good or verify work completion. Persistence, agent execution and new infrastructure require a separate scope decision.
