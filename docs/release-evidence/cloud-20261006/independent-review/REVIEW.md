# Independent cloud release review — 2026-10-06

**Recommendation: the reviewed candidate code passes offline checks. Live deployment remains blocked by missing authenticated current production provenance and verified rollback readiness.** No runtime defect requiring candidate changes was found in this review. This is not production-release signoff or a claim that either candidate is live.

## Exact reviewed candidates

| Repository | Candidate HEAD | Fetched origin/main at review |
| --- | --- | --- |
| joinermill | `ad0af760bae86702526bd935ff6fc5fc17a172f9` | `4123538bf18c4eb322c20247e23656625df40169` |
| evaos-v05 | `c23ce45671e9d8bc9d153d65b277caae2f1513a2` | `c15db296c5a7dbf2cb5df40ba8fbe9443e578570` |

The frontend contains `7f78c54097d70dc46d2d51b45f5e3d513f88fe67`, `a30ccbe885a1fd5523d7450c593638dab8ee2d8c`, `633d4afd1bf5e2586fbf0deda7dab6ec9f09432d`, and `6a03b5da0d3d8103a87c6df3e69e71e227b4be5e` as ancestors. The backend contains `d39936927821ce80087194eec948c7d94857037b`; all later changes through its reviewed HEAD are documentation only. Both candidate HEADs descend from their recorded origin/main commits.

The preserved production-module file has SHA-256 `7976a5690e588c36f220b7b9e2fad588b57f9180da26cbfa823dfbe9497ab84f`. This verifies the checked-in historical capture, not its equality with current production.

## Source review findings

- `evaos-v05/worker/src/release.js:5–8` adds only the exact `/brief/validate` path and delegates all other requests, environment bindings, and execution context to the preserved module. This avoids replacing already-deployed routes with the older repository main.
- `evaos-v05/worker/src/brief.js:34–53` implements bounded, deterministic six-field validation. Successful responses explicitly declare `executed:false` and `validation:structure_only`. New validation code neither consumes bindings nor fetches supplied URLs. Existing stream/time/field/rate bounds remain intact.
- `joinermill/preview/preview.js:134–149` sends only the prepared six-field brief after an explicit click, with credentials omitted and no referrer. It checks response shape, exact export, digest, and stale-request ownership before presenting success.
- Local planning, result, owner-decision, reusable-instruction, and backup code keeps user content in local browser state or explicitly chosen saves/downloads. Rendering uses literal text. Confirmation ownership and clean fresh-work state are preserved. Owner decisions remain unauthenticated owner assertions, not evidence of autonomous delivery.
- No new Pulse activation, execution, model calls, server persistence, or unrelated feature changes were found. Legacy frontend paths and roster are unchanged in the candidate diff.

## Independent executable checks

The runnable scripts in this directory fail if checked-out HEADs differ from the reviewed candidate SHAs. They make no production requests. The logs are fresh executions saved during this review.

`check-release.mjs` passed:

- Seven ancestry checks and byte-identical shared frontend/backend schema.
- Exact checked-in preserved-module SHA-256.
- 66 method/path combinations asserting exact request, environment, and context delegation for non-validation routes.
- Four stateless validation cases covering absent Origin and the three public allowlisted origins, with exact returned fields and export digest; all ran with throwing network/binding guards.

`check-helper.py` passed six fully mocked scenarios:

| Scenario | Expected result |
| --- | --- |
| preflight | No upload; unpublished evidence |
| publish | One simulated upload; all synthetic non-binding setting fields retained; all binding types retained; four module hashes verified |
| rollback | One simulated upload; one historical preserved module; settings and module hash verified |
| version-drift | Refuse before upload |
| late-version-drift | Refuse immediately before upload |
| late-settings-drift | Refuse immediately before upload |

Helper mocks verify local request construction and guards. They do not establish provider acceptance of metadata, preservation of real production settings, or supported Cloudflare rollback behavior. All fixture identifiers/settings are synthetic. No credentials or raw environment values are printed or saved; the test uses synthetic account/settings fixtures. A transient import cache from the initial interactive check was removed; the saved script executes source without bytecode caches.

Reproduce from sibling candidate checkouts:

```sh
node /path/to/independent-review/check-release.mjs /path/to/releases
python3 -B /path/to/independent-review/check-helper.py /path/to/releases
```

The release coordinator separately ran 25 frontend unit tests, 70 backend tests, 64 local browser groups, and 36 axe scans with zero reported failures, violations, or page errors. Its browser reports are outside this directory. These are separate coordinator-run checks, not a second independently executed full browser suite. Browser Worker requests were intercepted and handled locally with synthetic input. Live flows remain unverified for the proposed release.

## Conditions blocking live release

1. **Authenticated current capture is unavailable.** The coordinator reports one authenticated read of the Cloudflare token-verification endpoint returned HTTP 401 at `2026-10-06T03:00:20.695043+00:00`; subsequent authenticated requests stopped. The reviewer made no production/API calls. This is an authentication failure, not an approval-review rejection, and does not determine its underlying cause. Public-host reachability alone is insufficient.
2. **Current module/settings/version and rollback provenance must be established.** Capture the actual current production version, module, and sanitized settings fingerprint using the supported existing credential-substitution path. Do not assume historical version `514bf8c7-30cb-4f8f-bc9e-2c08882a45e8` is still current. Compare the module to the historical hash above; stop for unresolved drift. Do not use old repository main as production rollback.
3. **The helper alone cannot restore unexpected settings changes.** `evaos-v05/worker/tools/deploy-preserving.py:45–49` requires the original settings fingerprint even with `--rollback`; lines 69–76 detect post-upload settings changes but do not repair them. Before deployment, establish a supported path restoring the actual captured predeploy version/module/settings if they change unexpectedly. Mocked rollback success assumes settings were unchanged; it does not remove this condition.
4. **Live verification must precede frontend publication.** After the conditions clear, deploy the additive backend first, verify downloaded module hashes, settings/bindings, health, harmless synthetic stateless validation, and existing route preservation. Only then publish the frontend with existing Pages configuration and verify the exact build commit plus live desktop/mobile flows. No writes are authorized by this review itself beyond the already-delegated release scope.

## Documentation handoff check

The prepared `CLOUD_RELEASE_HANDOFF.md`, `CLOUD_RELEASE_STATUS.json`, and `START_HERE.md` pointer were checked in both repositories. The handoff and status files are byte-identical across repositories and correctly state offline success, no deployment, HTTP 401, historical-only baseline provenance, and rollback limitations. Both working branches were `release/cloud-routine-20261006`; tracked edits were limited to the START_HERE pointer, with untracked release documents and evidence. No runtime modifications were observed.

No objection to the coordinator's already-authorized documentation/evidence-only pushes on those isolated branches. This does not authorize advancing main, enabling the disabled Pages workflow, changing access settings, touching held PR15/32 or Pulse, or attempting deployment while the production gates remain unresolved. The coordinator reports current Pages uses legacy `main:/`; preserve that configuration and verify it again before any eventual release.

No source files, remote refs, production settings, customer records, secrets, or private archives were changed by the independent reviewer. Evidence files in this directory are the only persistent deliverables created by this review.
