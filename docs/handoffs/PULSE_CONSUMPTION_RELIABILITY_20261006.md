# Pulse response-consumption reliability — 2026-10-06

**UNSCORED synthetic local reliability evidence. No unattended or provider execution proof.**

Base: `9647b675d953bf24e7d32538fc8de83e6dace7b1` on the preserved `feature/pulse-durable-exchange-20261005` branch. This increment changes only the sandbox exchange, regression coverage and documentation. The seven `pulse/` modules and planner protocol remain byte-identical. No main merge, held-PR change, website modification, production deployment, external schedule or paid API call is included.

## Concrete gap and bounded fix

The earlier adapter wrote its exchange outcome after the controller returned. Forced process death in that window following either an invalid ACTION (`expected_effects=SEND`) or premature COMPLETE left the request labeled `RESPONSE_READY`. A subsequent tick submitted the same rejected response again: the principal rejection count increased from one to two. Neither case started a worker or incorrectly completed the objective. Author and independent reviewer reproduced this actual baseline gap.

The exchange now commits an immutable consumption record before returning a response to the controller. The record binds the request, packet digest, input hash, exact output hash, launch identity, state identity and controller/adapter/protocol hashes. An atomic exchange transaction permits at most one consumption. Record schema and bindings are rechecked even after a known outcome exists.

If acknowledgment is lost, the status is `CONSUMPTION_RECORDED_OUTCOME_UNKNOWN`. A current unresolved consumption with no lease or pending recovery rejects before another principal mutation. It does not fabricate the missing rejection or treat uncertainty as success. Committed verified receipts and WAIT/BLOCK decisions can still reconcile without resubmission. Existing lease fencing/recovery handles hard death; ambiguous started work remains blocked. Recovery may invalidate an old request and permit a new planning request, but never makes the old response consumable again.

Independent review also identified a valid concurrency race in the first candidate: a stale exchange snapshot could be compared with a newly committed principal receipt and falsely report an unbound receipt. Reading principal evidence before exchange records fixes that race: the consumption record causally precedes any resulting principal evidence. A deterministic interleaving regression preserves the finding and verifies the fix.

## Validation and review

- Regression criteria were frozen before the first baseline test. SHA-256: `fa409ca66bad6e30abc7b98120b5d301f4036cfc213a13428a96db2570e1cfbf`.
- Final command: `python -B -m unittest -v test_continuation test_consumption` — **26 tests passed**, including the 20 retained regressions and six new test methods. Repeated fixture checks are regression coverage, not additional autonomy evidence.
- Independent review: **eight adversarial probe groups passed**, plus the deterministic reconciliation race and three additional cross-record fault cases. Across the probes, 27 record/schema fault cases rejected without principal mutation. Coverage includes concurrent subprocess bursts, lost acknowledgments, graceful failure before submission, hard death after claim/start, receipt/control reconciliation and unchanged-byte redelivery.
- No remaining material finding was identified within the tested local scope. The separate review describes the findings and exact tested hashes.
- Final adapter SHA-256: `e83f2e0bd4c581e8acfcebae73613a50c1457bcd3154b3a531d3aca2a9acdb1a`.
- Source-manifest SHA-256: `7039cbf3b67dbb88cecf663859365c4fbaae685a2f0da31957189011c950a3a1`.

See `experiments/pulse-continuation/SOURCE_MANIFEST.json`, `RELIABILITY_CRITERIA_20261006.json`, `RELIABILITY_EVIDENCE_20261006.json`, `RELIABILITY_REVIEW_20261006.md`, and the executable regression tests. Earlier acceptance/evidence records remain historical records and are not rewritten as evidence for this increment.

## Compatibility, limits and next prerequisite

Existing exchange databases are bound to the old adapter hash and reject this revised code. Preserve those states with their original source; initialize a new synthetic state for this revision. No automatic migration or consumption reset is supplied. A process that dies immediately after recording consumption may require review even if the controller never received the response. This conservative behavior is intentional.

No new planner model was invoked for this increment. All new execution evidence is deterministic synthetic testing or fault injection. Prior manually orchestrated model runs remain historical; nothing here establishes unattended scheduling, full platform input/tool isolation, provider-side exactly-once execution or the stronger Atlas R3/Gage R2 acceptance boundary. The previous six-scheduled-wake criterion remains unproven. Local shared-filesystem checksums are not agent-inaccessible authority, a trusted seal or an off-box anchor. Owner-hidden criteria/fault data, the S1–S6 setup and independent Gage/Sentry built-boundary co-sign remain outside this proof.

The README contains a provider-neutral finite-launcher contract and status table. The next integration requires owner decisions about the scheduler host and bounded cadence/budget, durable provider job IDs with idempotency/status reconciliation, credentials/access boundaries, audit retention and any API cost. Unknown dispatch must reconcile the same job rather than blindly relaunch. No provider, scheduler, credentials, account, security/network setting or service was activated.

All three earlier evidence ZIPs remain hash-identical. The new local evidence bundle preserves baseline failures, the review finding, final results and source. Library upload remains blocked by the previously observed supported-helper network failure; no retry or bypass was attempted, and no new Library file ID is claimed.
