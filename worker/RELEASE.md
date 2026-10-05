# Editable brief release, 2026-10-05

`POST /brief/validate` is a stateless, deterministic structure check and plain-text export. It accepts exactly six string fields: objective, inputs, deliverable, constraints, success (one criterion per line), stopRule. It returns normalized fields, exportText and its SHA-256, with executed:false and validation:structure_only. No AI, judgment, fetch of supplied links, assignment, storage, body logging or business execution occurs.

Limits: 32 KiB streamed body, three-second body deadline, explicit field limits, 1–12 checklist lines, JSON only, allowlisted browser origins, no-store responses, 60 requests/minute/isolate best-effort rate limit (not a global quota). There are no new bindings or services. Unauthenticated access is only to this bounded stateless check; existing route behavior is preserved.

## Production source drift and safe deployment

Remote main at c15db296c5a7dbf2cb5df40ba8fbe9443e578570 lacked already deployed BOUNDARY/disposable route logic. `preserved/deployed-514bf8c7.js` is the exact downloaded module of existing Worker version 514bf8c7-30cb-4f8f-bc9e-2c08882a45e8. It is preserved byte for byte; its pre-existing behaviors are not new release features. `src/release.js` routes only /brief/validate to new code and delegates everything else to that module. The main source also exposes the new route for local regression testing. This deliberately avoids importing held PR32 or deleting deployed behavior. Follow-up source reconciliation requires its own review.

Do **not** deploy using plain `wrangler deploy`: checked-in wrangler.toml does not include all live bindings/settings. Use `tools/deploy-preserving.py` with a sanitized baseline containing current deployment/version IDs and settings fingerprint, and the existing secure HTTPS proxy/credential environment. It targets only the existing Worker. Default is read-only preflight. `--publish` performs the authorized update. It uses all live setting fields in memory and `keep_bindings` for every existing type, retaining BOUNDARY, BOUNDARY_ORIGIN, METERING_KV, OBJECTIVE and both secrets. No settings or secrets are saved. It checks for concurrent version/settings changes again immediately before upload, and compares all settings and downloaded module hashes afterward. The provider API has no atomic compare-and-swap: a small read/write race remains. Stop if a concurrent change is detected; never blindly overwrite it.

Command: `python3 tools/deploy-preserving.py --baseline /path/worker-baseline.json --output /path/deploy-evidence.json --publish`.

Rollback: first inspect current state. Reuse the same command with `--rollback --expected-version <our exact current release version> --publish`. This re-uploads the unchanged captured module while preserving settings; it refuses to overwrite a later concurrent version. Alternatively use the captured prior Cloudflare version with Cloudflare's supported rollback flow. Do not alter any KV/customer records. Frontend rollback uses `git revert <our release commit>` after checking concurrent changes, followed by monitoring the existing Pages deployment.

Tests: `npm test`; includes preserved module hash/delegation, original tests, stateless behavior with throwing bindings, invalid bodies, streaming limits and JSON/export round trip. Frontend shared model must remain byte-identical.
