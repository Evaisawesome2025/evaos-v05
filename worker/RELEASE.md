# Coordinated cloud release integration — 2026-10-06

This authorized release uses the reviewed runtime from `d39936927821ce80087194eec948c7d94857037b`, retained through `c23ce45671e9d8bc9d153d65b277caae2f1513a2`, plus the deployment-helper correction described here. Historical branch-only checkpoints below are retained as records. See `../CLOUD_RELEASE_STATUS.json` for the current deployment outcome.

The existing Cloudflare credential is account-owned. Verify it using `GET /accounts/{account_id}/tokens/verify`; the user-token endpoint is not diagnostic for it. On 2026-10-06 at 03:09:24 UTC the correct endpoint returned 200/active and the existing Worker settings read returned 200. The prior `/user/tokens/verify` 401 is superseded by these checks. No credentials or access settings were changed.

## Version-only deployment and actual-production rollback

The helper defaults to read-only preflight. Capture current deployment/version, exact downloaded module hashes, full settings SHA-256, and separate script-settings SHA-256 first. Fingerprints use Python `json.dumps(value, sort_keys=True, separators=(',', ':')).encode()`. Persist only sanitized evidence and authorized source capture; raw settings and credentials remain in memory. The fresh baseline must include `deployments`, `current_module_hashes`, `settings_sha256`, and `script_settings_sha256`.

`python3 -B tools/deploy-preserving.py --baseline /path/worker-baseline.json --output /path/preflight.json` verifies current deployment, settings, script settings, and exact preserved source before any write. `--publish` stages the four reviewed modules with `POST /versions`, explicitly inherits each binding from the captured version, checks staged binding/runtime resources against that version, rechecks current production, then selects the exact uploaded version with `POST /deployments`. No whole-script PUT or settings PATCH is allowed. No provider force flag is supplied.

Script-level logpush, observability, tags and tail-consumer configuration are outside the write set. Their fingerprint is an invariant before upload, before activation and after activation/rollback. Version rollback restores the actual captured code/bindings/runtime. It does not alter external resources or KV/customer records. This avoids the prior whole-script upload's settings-reset risk; it does not invent support for clearing null script settings.

After activation, the helper verifies owned deployment identity, all module hashes and both settings fingerprints. A code/versioned-settings mismatch rolls back only if the exact owned deployment and just-observed state are still current; it then verifies the captured baseline. A concurrent or unknown deployment/script-level edit stops without overwriting it. An uncertain API write is never blindly repeated. Inspect the saved phase and provider state; preserve all returned IDs.

For a later live-check failure while the confirmed release is still current:

```sh
python3 -B tools/deploy-preserving.py --baseline /path/worker-baseline.json --output /path/rollback.json --rollback --expected-version <exact-release-version> --release-evidence /path/deploy-evidence.json --publish
```

The command requires the exact owned deployment and code from release evidence and unchanged script settings. It selects the actual baseline version and checks full restoration. It never uses older repository main or reuploads the historical file as a guessed rollback. Provider resource/secret refusal must not be forced.

Read the official [account token verification](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/verify/), [version upload](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/), [deployment selection](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/), and [rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) contracts. Run `npm test` and `python3 -B -m unittest discover -s test -p 'deploy_preserving_test.py'` before release. The product runtime and six-field schema are unchanged by this integration.

---

# Reusable instructions compatibility — 2026-10-06

Current backend branch `next/reusable-instructions-contract-20261006` extends `31c003066eb771a21f59836110b433e68dad97c4` with documentation only. Runtime, shared six-field model, bindings/auth/CORS/deployment tools and preserved production module remain unchanged from the reviewed frozen release. Frontend `next/reusable-instructions-20261006` extends `6a03b5da0d3d8103a87c6df3e69e71e227b4be5e`. Owner/blocker/handoff definitions and copied directions stay local and are excluded from optional six-field requests. No schema/runtime extension is needed. See ../REUSABLE_INSTRUCTIONS.md and ../READINESS.md. Publication stops at reviewed feature branches; no deployment.

---

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
