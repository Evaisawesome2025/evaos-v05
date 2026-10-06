# Reliability audit and release readiness — 2026-10-06

## Decision and bounded fix

The audit found a reproducible correctness gap, so this increment fixes it instead of adding another feature. On frontend `633d4afd1bf5e2586fbf0deda7dab6ec9f09432d`, start reading a local backup, then open owner acceptance for result A. If the read finishes late, its import dialog opens over the acceptance dialog. Importing result B leaves A's old acceptance confirmation open; confirming it marks B accepted. The owner never opened that confirmation for B.

The fix cancels a pending import before reset, restore or acceptance confirmation opens; only one confirmation stays open. Acceptance is tied to the exact immutable result object reviewed when the dialog opened. Replacing or clearing work closes obsolete dialogs, and closed/stale confirmation events do nothing. A changed result requires fresh review. Cancellation is disclosed, and the owner can select the backup again. No snapshot/schema, owner-decision meaning, shared backend contract or execution capability changes.

A browser regression reproduces failure against the exact prior source (two stacked dialogs), then passes against the corrected source. Tests cover delayed success/failure, confirm/cancel, repeated clicks, stale events, changed result/source/feedback, fresh imports after interruption and desktop/mobile keyboard focus. This is local synthetic evidence, not a live rollout or actual customer outcome.

## Complete path audit

| Path | Audited behavior and evidence | Readiness limit |
|---|---|---|
| Brief entry and navigation | Six actual fields, bounds/errors, separate examples, back/edit invalidates format verification; existing regressions pass. | No AI judgment of whether the proposed work is useful or safe. |
| Optional format validation | Exactly six current brief fields; byte-exact export/hash; local Worker integration plus network/mismatch/cancellation failures. | No live public endpoint verification in this increment. |
| Save, reload, restore and removal | Explicit browser snapshot and explicit restore, blocked/corrupt/quota failure handling, retained saved copy on tab reset. | One origin/profile copy; no autosave, sync, account or guaranteed device recovery. Keep a backup. |
| Readable export and JSON import | Actual fields, source and original target preserved; capped strict schema; literal rendering; confirmation before replacement; no automatic saving/transmission. | Imported decisions/timestamps are unauthenticated claims. A file download request does not prove the user retained the file. |
| Deliverable and owner review | First recording captures the original brief; edits invalidate the appropriate state; changed current brief warns that prior decision applies only to captured target. | One current result, no revision history, authenticated signature or independent verification. |
| Interrupted confirmations | Reproduced the delayed-import/acceptance defect; now cancels superseded import, prevents stacking and binds acceptance to its reviewed result. Reset/restore variants covered too. | Native browser behavior and tested Chromium coverage do not prove every browser/assistive technology. |
| Mobile and keyboard access | Prior 320px reflow, desktop/mobile views and four dialog flows remain in the full regression suite. | Before external use, perform the same real workflow on the intended phone/browser and accessibility setup. |

The full regression also exposed a queued close callback that could steal focus from a newly selected result field and send typing into feedback. The reviewer reproduced it in the prior source. Focus returns are now guarded so a closed dialog cannot override a newer field or dialog selection; a typing regression verifies the result and feedback remain correctly separated.

No unrelated feature or backend change is bundled. Known disclosed limits such as manual saving and one-copy storage remain. This increment is restricted to these confirmation-lifecycle defects and readiness evidence.

## Best current candidate and ancestry

Use the **new confirmation-readiness branches together** for any later reviewed release; the prior result-review frontend contains the reproduced defect. Exact final pushed commit hashes are recorded in the portable handoff STATUS.json and verified remote-ref evidence. Resolve branch refs again before any future mutation, and inspect concurrent work.

| Repository | Unchanged main | Reviewed, undeployed ancestry (oldest to newest) | Current candidate branch |
|---|---|---|---|
| Joinermill | `4123538bf18c4eb322c20247e23656625df40169` | `7f78c54097d70dc46d2d51b45f5e3d513f88fe67` → `a30ccbe885a1fd5523d7450c593638dab8ee2d8c` → `633d4afd1bf5e2586fbf0deda7dab6ec9f09432d` → this increment | `next/confirmation-readiness-20261006` |
| EVAOS | `c15db296c5a7dbf2cb5df40ba8fbe9443e578570` | `d39936927821ce80087194eec948c7d94857037b` → `3f47c08e82191d8fe34b45e3c0950c639e17a9cb` → `70099ca9802e2928075b20c721d07d289fafb794` → this increment | `next/confirmation-readiness-contract-20261006` |

Backend runtime is still identical to the frozen brief-validation release `d39936927821ce80087194eec948c7d94857037b`; subsequent backend increments are documentation only. Its preservation wrapper/module retain existing deployed routes that older main lacks. Never deploy older backend main as a rollback or use plain wrangler defaults. No Worker binding, secret, auth, CORS or setting is changed by this increment.

## Exact public-verification blocker

Historical direct probes recorded in the 2026-10-05 cloud-only release diagnostic (approximately 22:35–22:37 UTC) were:

- `GET https://joinermill.com/` — HTTPS tunnel HTTP 403 before reaching the origin.
- `GET https://evaos-v05-ask.joinermill-ask.workers.dev/health` — HTTPS tunnel HTTP 403 before reaching the origin.

The reported environment-settings editor failure was “Creating draft” / “Couldn't start editing environment”; the approved public-host policy could not be applied through that UI. The underlying editor failure was not diagnosed. No supported settings-repair action was available to this task. This increment deliberately performs no editor retry, public-host retry, alternate-host bypass, grant or security-setting change, so these are **last observed blocker facts, not new probes or a refreshed claim about live state**.

Prior Worker management preflight and GitHub Pages success were distinct evidence, not substitutes for public end-to-end verification. The historical captured Worker version was `514bf8c7-30cb-4f8f-bc9e-2c08882a45e8`; do not assume it is still current at a future deployment. No new deployment ID exists here.

## First-real-user prerequisites

1. Successfully apply the already authorized public-host policy through supported settings/support, then verify that the existing authorized cloud path reaches the two intended origins and permits the harmless checks needed. No new credential, service or broad network grant is proposed here.
2. Refresh current remote commits and safe Worker version/settings baseline. Preserve every deployed binding/setting, including METERING_KV, OBJECTIVE and any BOUNDARY-related binding, through the reviewed helper. Stop on concurrent drift; never save raw secrets/settings to the handoff.
3. In a later authorized release session, deploy the backward-compatible backend first; verify harmless synthetic validation, health and protected-route refusals. Publish the exact frontend candidate through existing Pages, monitor terminal deployment status, then verify live assets, browser CORS and the complete synthetic workflow. Local tests or a branch push do not satisfy this gate.
4. Before asking a real user to rely on the new flow, try one non-sensitive real task on their intended desktop/phone browser. Check that they can prepare the brief, retain/reimport a backup, recover after reload, compare the actual result with its captured target and explain what owner acceptance means. Observe confusion and loss-of-work risks manually; no analytics service or customer record collection is added.
5. Explain manual local saving, shared-browser access, the distinction between draft/current/captured brief, one-result/no-history limits, unauthenticated imported claims and browser-clock timestamps. Keep a downloaded backup before clearing the browser or switching devices.

Missing today is a verified live release and a first observed real-user workflow, not another placeholder feature. No production reliability or commercial success is asserted from these synthetic checks.

## Pulse and scope boundary

Pulse is part of EVAOS. This task neither reads nor changes its controller paths/branches; a separate task owns that code and current assessment. The last prior handoff called Pulse an isolated UNSCORED prototype; that historical label is not a fresh assessment of the separate task's work.

No Pulse interface is introduced or tested. Local `accepted` is an owner assertion about a captured brief, not a Pulse score, proof of execution or independently verified result. Any future integration must preserve that distinction and receive its own scoped review; it must not assume the undeployed brief endpoint or local snapshots are an execution API.

Both mains, prior release/command-center/result-review branches and held Joinermill PR15/EVAOS PR32 remain outside this increment's writes. Publication stops at the two new feature branches. No deploy, merge, new service/account/credential, paid call, outreach, spend or customer-data access occurs.
