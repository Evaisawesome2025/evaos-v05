# Independent review: Pulse response-consumption reliability

**Result:** no remaining material finding in the bounded local scope of the reviewed revision. **UNSCORED.** This review author did not edit the implementation. All executed probes used synthetic local state and deterministic fault injection; no model, scheduler, provider, network service, credentials or business effects were involved.

Reviewed adapter SHA-256: `e83f2e0bd4c581e8acfcebae73613a50c1457bcd3154b3a531d3aca2a9acdb1a`.

Frozen regression criteria SHA-256: `fa409ca66bad6e30abc7b98120b5d301f4036cfc213a13428a96db2570e1cfbf`. The criteria were checked before independent baseline tests and remained unchanged through final review.

## Findings and repairs

1. **Baseline interruption gap independently reproduced.** On the earlier reviewed adapter, process death after the controller rejected an ACTION or premature COMPLETE but before the exchange acknowledged it left the same response ready for submission. Restart repeated the identical rejection: journal rejection count increased from one to two, with no worker started. The new immutable consumption record commits before handing the response to the controller. Missing acknowledgments now require evidence reconciliation, existing principal recovery, or review; they do not authorize resubmission.
2. **Candidate concurrent-read race found and corrected during review.** Reconciliation initially read exchange rows before principal evidence. A valid interleaving could complete consumption and verification between those reads, causing a false `UNBOUND_PRINCIPAL_RECEIPT`. The final code reads principal evidence before the append-only exchange rows. The same deterministic interleaving now reconciles cleanly; one worker and one verifier call remain recorded. This was a transient reconciliation failure, not duplicate execution.

## Independent checks

Ten focused probe groups passed on the final adapter:

- Ten concurrent tick subprocesses with forced rejection-acknowledgment loss produced one consumption record and one rejection. Repeated later ticks rejected without changing principal state or journal; exact redelivery remained idempotent and conflicting output was rejected.
- A graceful exception immediately after the planner returned and before proposal submission left a durable consumption record. The lease released; restart required review without starting work.
- Interrupted WAIT and BLOCK acknowledgments reconciled to their committed decisions. Subsequent ticks respected the waiting deadline or blocked state and started no workers.
- An interrupted verified receipt reconciled without repeating its worker or verifier.
- Death after worker start used existing lease recovery and became BLOCKED without replay. Death immediately after consumption invalidated the old request through existing recovery and did not consume it again.
- Twenty-four checksummed claim mutations exercised every binding field, missing/extra fields and wrong container type, both with and without an existing acknowledgment. Every case rejected before principal mutation.
- Three additional cross-record faults—changed exact output with a recomputed response checksum, a removed claim after a receipt, and a removed launch—were detected without principal mutation.
- A mixed burst of five delivery calls and five tick subprocesses produced one consumption, worker, verifier and receipt.
- The deterministic concurrent-read regression passed after the ordering correction.

The implementation author's final log records **26 passing regression tests**. This reviewer inspected that log and its hash and did not rerun the unrelated original fixture suite. The seven `pulse/` Python modules, planner protocol and original continuation tests remain byte-identical to the reviewed baseline. The reviewed final source snapshot matches the implementation source.

## Limits and integration implications

Consumption is an at-most-once submission guard, not an exactly-once execution or success guarantee. A crash between claim commit and controller entry can require review even when no work began. The adapter does not infer a rejection from an unbound rejection event. Existing exchange databases reject the changed adapter hash; preserve them with their original code and use a new synthetic state for this revision. No migration or uncertainty-reset bypass is provided.

Checksums and SQLite immutability checks establish local consistency through the supported interface. They do not establish protection against an administrator who can rewrite code and databases, agent-inaccessible authority, hidden criteria, or independent trust anchors. Record-fault probes deliberately bypassed local triggers only to test consistency checks; they are not security or isolation proof.

The provider-neutral finite-launcher contract is documentation only. A future implementation still needs an approved scheduler and bounded run budget, durable job identity, provider idempotency/status reconciliation, credential/access placement and any pricing approval. Unknown dispatch must not trigger a blind replacement launch. No such service was activated.

The stronger Atlas R3/Gage R2 acceptance boundary remains unmet: unattended execution, full platform input/tool provenance, owner-controlled principal/gate/verifier, sealed hidden criteria, off-box anchoring, the S1–S6 manifest and independent built-boundary co-sign are not demonstrated. Prior manual model runs and the retained multi-stage fixture do not become new autonomy evidence through this change.
