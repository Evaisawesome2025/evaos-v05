# Coordinated cloud release checkpoint — 2026-10-06

**No production deployment or main update occurred.** Frontend publication is on hold for a separately reviewed phone-readability patch. Backend authentication, exact current-source capture, helper review and tests pass, but the first pre-deploy public health probe returned HTTP 403, so release writes stopped before any version upload or activation. No rollback is needed.

## Corrected authentication and current production evidence

The existing Cloudflare credential is account-owned. At 03:09:24 UTC, one request to `GET /accounts/{account_id}/tokens/verify` returned HTTP 200/active and the existing Worker settings read returned HTTP 200. The earlier `/user/tokens/verify` 401 was not diagnostic for this token type. No credential or access setting changed. See the [official account-token endpoint](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/verify/) and `docs/release-evidence/cloud-20261006/account-token-preflight.json`.

Fresh capture at 03:09:52 UTC confirmed:

- Existing Worker version `514bf8c7-30cb-4f8f-bc9e-2c08882a45e8`, serving 100%, deployment `ca28b3af-6bcb-4b77-97e4-679c1f4bc29d`.
- Current `index.js` exactly equals preserved source SHA-256 `7976a5690e588c36f220b7b9e2fad588b57f9180da26cbfa823dfbe9497ab84f`.
- Full settings fingerprint `59e2c602b2ff276c6c5844faa2117d6f1c353bc6e35fdb1305bd738962faca13` and script-settings fingerprint `d13e83ebe9194fdbde48d1d4a9e2f1fd0b9c653ced072a1aa27fb746062c0e80`.
- All six existing binding names/types retained in the sanitized receipt. Concurrent capture checks were stable. No raw settings or credential values were persisted.

## Reviewed recovery integration

Backend integration commit `3e68fd919d08b302499546c7d3ea0b5c86283e78` changes the deployment helper and its tests/docs, with product runtime unchanged from candidate `c23ce45671e9d8bc9d153d65b277caae2f1513a2`. The helper stages via `POST /versions`, inherits every binding explicitly from the captured version, verifies staged bindings/runtime and unchanged production, then activates the exact returned version using `POST /deployments`. Default invocation remains read-only.

Rollback selects the actual captured version while the exact owned deployment and just-observed state remain current, then checks original module and both settings fingerprints. No whole-script PUT, script-settings PATCH, provider force, new credential, or external-resource mutation is allowed. Script-setting drift is concurrent/unknown and stops writes instead of guessing how to restore null values. This closes the original PUT/settings-reset gap by excluding script settings from the mutation set. See backend `worker/RELEASE.md` and [independent implementation review](docs/release-evidence/cloud-20261006/independent-review/ROLLBACK-REVIEW.md).

The revised helper SHA-256 is `278f734ac203e50d26582cacdb2b745a11efdc1dc04d75679f626ab2ab59ff27`. Its 11 test methods cover 21 mocked main executions plus four forbidden-write cases. Independent review and coordinator reruns pass. A read-only live helper preflight also passed; `--publish` was never invoked.

## Public verification and remaining holds

At 02:55:31 UTC, ordinary unauthenticated curl GETs to `https://joinermill.com/` and the Worker `/health` each returned origin HTTP 200 and CONNECT 200, without redirects/errors. Later, the first pre-deploy smoke request—Python urllib GET `/health`, explicitly setting `Origin: https://joinermill.com`, without authentication or redirects—returned HTTP 403. The smoke harness stopped before all other probes and before any stateless POST. No retry or alternate proxy was used.

The failed harness did not retain response body, CONNECT metadata, or an exact request timestamp; its sanitized failure receipt was recorded at 03:18:55 UTC. The denial source is unclassified. Do not label it an origin failure, infer global loss of connectivity, or treat the earlier successful curl result as proof this different request passed. The receipt is [predeploy-public-probe-failure.json](docs/release-evidence/cloud-20261006/predeploy-public-probe-failure.json).

The parent separately holds frontend publication pending its reviewed phone-readability patch. Do not publish the current frontend candidate or independently develop a competing readability change. Product source tested so far is frontend `ad0af760bae86702526bd935ff6fc5fc17a172f9`, containing all requested ancestors, and backend `c23ce45671e9d8bc9d153d65b277caae2f1513a2`, whose changes after `d39936927821ce80087194eec948c7d94857037b` are documentation only.

Fresh candidate results: 25 frontend units, 70 backend tests, 64 browser groups, 36 axe scans, zero violations/page errors, shared-model byte equality. Desktop/mobile synthetic screenshots inspected. The new phone-readability patch is not included in those results. Backend 70 tests pass again after helper integration. Browser Worker requests were intercepted and fulfilled by the real local handler; these are not live release checks.

## Resume and references

Resolve the public-probe discrepancy through a supported, explicitly scoped check before release; do not blindly repeat denied requests. Refresh production/module/settings fingerprints and remote refs before any write. Once all checks pass, deploy and verify the additive backend, then incorporate the parent's reviewed readability patch, rerun affected frontend checks and publish using existing Pages configuration. No approval-review rejection occurred in this task.

Existing frontend main/production reference is `4123538bf18c4eb322c20247e23656625df40169`. GitHub Pages uses legacy `main:/` and custom `joinermill.com`; the checked-in workflow is disabled and the dynamic Pages workflow is active. [Existing successful run 37367233537](https://github.com/Evaisawesome2025/joinermill/actions/runs/37367233537). Backend repository main `c15db296c5a7dbf2cb5df40ba8fbe9443e578570` is not a production rollback source. Preserve held PR15/32, Pulse, customer data and private archives.

See [CLOUD_RELEASE_STATUS.json](CLOUD_RELEASE_STATUS.json) for machine-readable facts and [evidence](docs/release-evidence/cloud-20261006/) for logs, independent reviews and hashes. Both release branches preserve sanitized handoffs; no main merge or deployment is implied by their pushes.
