# Start here — EVAOS brief contract checkpoint

## Current state

2026-10-05: **documentation-only next branch; not deployed or merged to main.** Branch `next/command-center-contract-20261005` starts from frozen reviewed backend `d39936927821ce80087194eec948c7d94857037b`. The frozen `release/brief-validation-20261005` branch remains unchanged. This increment makes no runtime, configuration, deployment-helper or preserved-module change.

The matching [Joinermill](https://github.com/Evaisawesome2025/joinermill) branch `next/command-center-20261005` extends frozen `7f78c54097d70dc46d2d51b45f5e3d513f88fe67`. It adds a local work desk, next-action/missing-input notes, explicit browser save/restore/remove, and work-plan export. These notes and save metadata are not backend inputs. The existing six-field brief API covers the only server action, so no additional endpoint or storage is needed.

The first reviewed release in the frozen branch remains undeployed in this work trail. The production Worker version captured before that work is `514bf8c7-30cb-4f8f-bc9e-2c08882a45e8`; this is a historical baseline, not a new claim of current remote state. No live customer records were accessed for this increment.

## Existing contract and deployment continuity

`POST /brief/validate` accepts exactly six strings: objective, inputs, deliverable, constraints, success and stopRule. It normalizes whitespace and returns a canonical plain-text export and SHA-256 with `executed:false` and `validation:structure_only`. It does not judge the plan, verify work, fetch supplied links, call models, schedule agents, log bodies or persist customer content. Inputs arrive only after the frontend's explicit format-check action; infrastructure may retain metadata.

Bounds remain unchanged: 32 KiB streamed body, three-second read deadline, field limits, 1–12 success criteria, JSON errors/no-store responses, allowlisted browser CORS and a best-effort 60-requests/minute/isolate bucket. Existing route authentication and behavior stay unchanged.

The preserved production module contains routes missing from the older repository main. `worker/preserved/deployed-514bf8c7.js` is its exact captured code; `worker/src/release.js` delegates every old route to it. Never deploy older main as a rollback, and never use plain wrangler defaults. [worker/RELEASE.md](worker/RELEASE.md) describes the settings-preserving helper and concurrency/hash guards. No binding, secret, settings or security policy is changed by this documentation increment.

## Successor checklist

1. Read [RELEASE_STATUS.json](RELEASE_STATUS.json), [RELEASE_LOG.md](RELEASE_LOG.md), worker/RELEASE.md and the matching frontend handoff. Fetch remote state before editing and preserve later work.
2. Run `cd worker && npm test` (70 tests). Keep `worker/src/brief-model.js` byte-identical to frontend `preview/brief-model.js`. The frontend has 9 unit tests and 25 browser groups; requests are intercepted and the actual Worker handler runs locally with synthetic input.
3. Review the separate command-center security/privacy review and final exact branch commit hashes supplied with the handoff. Stop at feature-branch publication for this checkpoint; no deployment or main merge is part of it.
4. A future authorized release must refresh the safe Worker baseline, verify existing network access and preserve all live bindings/settings. Backend comes first, then harmless synthetic probes, then the frontend through existing Pages. Confirm live results rather than inferring them from push/upload.

No live rollback is needed now. For branch recovery inspect later changes, then revert only this documentation commit. For a later live release use the guarded code rollback in worker/RELEASE.md; it preserves settings and does not roll back customer/KV data.

## Holds and truthful scope

Held [Joinermill PR15](https://github.com/Evaisawesome2025/joinermill/pull/15) and [EVAOS PR32](https://github.com/Evaisawesome2025/evaos-v05/pull/32) remain untouched and unmerged. Pulse remains a separate completed **UNSCORED** controller prototype, absent from this checkout and not deployed. There are no new services, paid model calls, persistent customer writes, jobs, outreach or autonomy claims. Production-source reconciliation is a separate future reviewed task, not part of this increment.
