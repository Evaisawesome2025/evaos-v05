# Follow-up: current production capture and version-only release

This supersedes the authentication/provenance blockers in the earlier REVIEW.md checkpoint. The earlier code and test results remain evidence for the exact original candidates; they are not evidence for an unreviewed helper change.

The coordinator's sanitized `account-token-preflight.json` records account-owned token verification HTTP 200/active and Worker settings HTTP 200 at 03:09:24 UTC. The earlier `/user/tokens/verify` HTTP 401 used the wrong endpoint for this account-owned token; it does not diagnose a credential failure.

The coordinator's sanitized `worker-baseline.json`, captured at 03:09:52 UTC, records stable 100% production version `514bf8c7-30cb-4f8f-bc9e-2c08882a45e8`, exact module `index.js` SHA-256 `7976a5690e588c36f220b7b9e2fad588b57f9180da26cbfa823dfbe9497ab84f`, full-settings fingerprint `59e2c602b2ff276c6c5844faa2117d6f1c353bc6e35fdb1305bd738962faca13`, and script-settings fingerprint `d13e83ebe9194fdbde48d1d4a9e2f1fd0b9c653ced072a1aa27fb746062c0e80`. The independent reviewer inspected these sanitized receipts without making production API requests.

## Supported API behavior

Cloudflare versions capture code, bindings, and compatibility configuration; deployments choose which version serves traffic. Associated storage contents are not part of a version. [Versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)

The upload-version API documents binding inheritance from an explicit version using `name`, `type: "inherit"`, and `version_id`. Specifying the captured version avoids the implicit latest-version source. It returns a version identity and resources that can be checked before activation. [Upload Version](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/)

A deployment selects an explicit version at 100% using `strategy: "percentage"` and a one-element `versions` array. Omit `force`; it can bypass provider safeguards such as secret-change rollback restrictions. [Create Worker Deployment](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/)

Script settings have a separate API. Its documented mutable fields include logpush, observability, tags, and tail consumers. The schema does not establish that null restores an absent setting. [Patch Worker Script Settings](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/settings/methods/edit/)

## Approved design for implementation review

Use only `POST /versions` followed by `POST /deployments`; do not use the old whole-script PUT, and do not write `/script-settings`. The coordinator's safe type inspection found nullable script-setting values. There is no need to invent null reset behavior when script settings are outside the mutation set.

1. Verify the captured active version, module hashes, full-settings fingerprint, and script-settings fingerprint. Read baseline version resources; keep raw settings/resources only in process memory.
2. Build version metadata from the supported version fields, exclude all script-level fields, and inherit every existing binding explicitly from the captured version.
3. Upload a version without activating it. Require the returned version ID, then read and compare its bindings/runtime resources against the captured baseline before activating. On refusal, missing identity, or mismatch, stop; no retry, fallback, or automatic deletion.
4. Immediately before activation, recheck active version and all captured fingerprints/module hashes. Activate only the exact uploaded version, at 100%, with no force. An ambiguous response is not proof of activation or permission to overwrite anything.
5. Verify exact active version, deployed module hashes, and both settings families. Any known code/version problem can roll back only while the exact owned version/deployment remains current. Rollback selects the actual captured old version, never the older repository main or a reconstructed historical upload.
6. Treat script-setting drift as concurrent/unknown: stop rather than overwrite it. Recheck both settings families and module hashes after any rollback. Do not claim complete restoration unless those checks match the actual captured baseline.

This removes the original PUT/settings-reset risk without adding script-setting writes, credential changes, secret changes, customer-data changes, or forced operations. It is a design-level approval within the already-authorized release scope. Final helper approval requires review of the implemented code and stateful mocked success/failure/concurrency checks. Provider reads and writes remain the coordinator's responsibility; the reviewer makes none.

## Implementation review completed

The version-only helper implementation passed independent review and 11 regression test methods: 21 mocked main execution scenarios and four forbidden-write cases. The reviewer added only `worker/test/deploy_preserving_test.py`. The exact reviewed helper/test hashes, parent commit, command, and limitations are in `VERSION-HELPER-RECEIPT.json`; the execution log is `version-helper-tests.log`.

No blocking implementation finding remains. Recommendation: proceed within the authorized version-only release scope using the helper's live preflight/postflight gates. This is not a claim that deployment occurred. Script-level drift, unknown deployment ownership, ambiguous provider outcomes, or failed restoration verification still require stopping. The reviewer made no production requests.
