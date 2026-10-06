# Confirmation reliability compatibility — 2026-10-06

**Documentation-only next branch; no merge or deployment.** The frontend's interrupted-confirmation fix changes no six-field request, result/snapshot schema, backend code, authentication/CORS, live setting/binding or deployment helper. Result/owner-review/import state remains browser-only. This branch extends `70099ca9802e2928075b20c721d07d289fafb794` on `next/confirmation-readiness-contract-20261006`.

Read ../READINESS.md for the complete-path audit, best current candidate ancestry, historical tunnel-403 blocker and first-real-user gates. Prior deployment procedures below are retained for a later authorized release, not executed by this increment. Refresh safe remote/Worker evidence first. Pulse is owned by a separate task and is not integrated or touched here.

---

# Local result-review compatibility — 2026-10-06

**Documentation-only next branch; no deployment or main merge.** Actual result text, source/provenance, owner feedback/decisions, original review targets and backup metadata are browser-only. JSON import reads a local file without upload. The explicit stateless format check still sends exactly six current brief fields. No backend runtime, schema, authentication, CORS, configuration, binding, deployment-helper or preserved-source change is needed.

This branch extends `3f47c08e82191d8fe34b45e3c0950c639e17a9cb`. Read ../START_HERE.md and ../RELEASE_STATUS.json for the current checkpoint. Procedures below are retained for a later authorized coordinated release, not an instruction to deploy now. Refresh safe remote/Worker baseline evidence before any such release.

---

# Command-center compatibility checkpoint — 2026-10-05

**Documentation-only feature branch; no deployment or main merge.** The next frontend uses the unchanged six-field `/brief/validate` contract. Next-action/unresolved-input notes and browser-save metadata remain local and must not be sent to this endpoint. This branch introduces no backend runtime, setting, binding, authentication or deployment-helper change. The frozen reviewed backend base is `d39936927821ce80087194eec948c7d94857037b`.

The older release procedure below is retained for a future authorized coordinated publication. It is not an instruction to deploy this branch now. Refresh all remote state and safe baseline evidence before any later release. See ../START_HERE.md and ../RELEASE_STATUS.json for the current checkpoint.

---

# Editable brief release, 2026-10-05

`POST /brief/validate` is a stateless, deterministic structure check and plain-text export. It accepts exactly six string fields: objective, inputs, deliverable, constraints, success (one criterion per line), stopRule. It returns normalized fields, exportText and its SHA-256, with executed:false and validation:structure_only. No AI, judgment, fetch of supplied links, assignment, storage, body logging or business execution occurs.

Limits: 32 KiB streamed body, three-second body deadline, explicit field limits, 1–12 checklist lines, JSON only, allowlisted browser origins, no-store responses, 60 requests/minute/isolate best-effort rate limit (not a global quota). There are no new bindings or services. Unauthenticated access is only to this bounded stateless check; existing route behavior is preserved.

## Production source drift and safe deployment

Remote main at c15db296c5a7dbf2cb5df40ba8fbe9443e578570 lacked already deployed BOUNDARY/disposable route logic. `preserved/deployed-514bf8c7.js` is the exact downloaded module of existing Worker version 514bf8c7-30cb-4f8f-bc9e-2c08882a45e8. It is preserved byte for byte; its pre-existing behaviors are not new release features. `src/release.js` routes only /brief/validate to new code and delegates everything else to that module. The main source also exposes the new route for local regression testing. This deliberately avoids importing held PR32 or deleting deployed behavior. Follow-up source reconciliation requires its own review.

Do **not** deploy using plain `wrangler deploy`: checked-in wrangler.toml does not include all live bindings/settings. Use `tools/deploy-preserving.py` with a sanitized baseline containing current deployment/version IDs and settings fingerprint, and the existing secure HTTPS proxy/credential environment. It targets only the existing Worker. Default is read-only preflight. `--publish` performs the authorized update. It uses all live setting fields in memory and `keep_bindings` for every existing type, retaining BOUNDARY, BOUNDARY_ORIGIN, METERING_KV, OBJECTIVE and both secrets. No settings or secrets are saved. It checks for concurrent version/settings changes again immediately before upload, and compares all settings and downloaded module hashes afterward. The provider API has no atomic compare-and-swap: a small read/write race remains. Stop if a concurrent change is detected; never blindly overwrite it.

Command: `python3 tools/deploy-preserving.py --baseline /path/worker-baseline.json --output /path/deploy-evidence.json --publish`.

Rollback: first inspect current state. Reuse the same command with `--rollback --expected-version <our exact current release version> --publish`. This re-uploads the unchanged captured module while preserving settings; it refuses to overwrite a later concurrent version. Alternatively use the captured prior Cloudflare version with Cloudflare's supported rollback flow. Do not alter any KV/customer records. Frontend rollback uses `git revert <our release commit>` after checking concurrent changes, followed by monitoring the existing Pages deployment.

Tests: `npm test`; includes preserved module hash/delegation, original tests, stateless behavior with throwing bindings, invalid bodies, streaming limits and JSON/export round trip. Frontend shared model must remain byte-identical.
