# Independent review: finite-run Pulse sandbox coordinator

**Result:** no remaining material finding within the documented local boundary: the coordinator owns all supported ticks for its fresh synthetic run. **UNSCORED.** This reviewer did not edit implementation source. All probes used local synthetic state, fixture responses, simulated clock changes or explicit fault/interleaving injection. No model, provider, scheduler, credentials, deployment or business effects were activated.

Reviewed coordinator SHA-256: `222a66fe817e9304fa6a122ce1efe74ecd351a7bcd66c19c8b7d452e08bbcad0`.

Frozen criteria SHA-256: `2cf1846bbbf65e460fcb947383f3e726022e9f880b12f58b8a19d37b6fbf0cc2`. The reviewer checked this hash before independent tests and confirmed it remained unchanged at final review. The final 14-file source manifest SHA-256 is `a71cfb1244fc20948f72c2cbef6b4db14af5260b34ee47366e81e62150c6a1e9`.

## Findings resolved during review

1. **Unrelated exchange requests could spend the waiting request's budget.** An early draft prepared a request, then accepted another structurally valid current request with a synthetic response as a reason to admit a second tick. The original request still awaited dispatch; the extra tick consumed budget without progressing it. The coordinator now preserves an exchange checkpoint and allows only launch/response additions for the exact previously waiting request. The same probe stops with `STOP_EXCHANGE_CHANGED`, with one wake charged and no principal mutation.
2. **An isolated checkpoint replacement could bypass that transition check.** The implementation author identified this additional fault, and the reviewer independently reproduced it on the intermediate candidate: replacing only the mutable exchange checkpoint with a rehashed view containing an unrelated request caused another wake to be spent. The final validation binds the checkpoint through the initial exchange, each reservation and each bound result. The same isolated fault now raises `RUN_RECORD_DAMAGED` before principal mutation. This tests local consistency, not resistance to rewriting the entire trusted history.
3. **A rejection label could incorrectly imply no tick had run.** A clock-validation failure during acknowledgment can occur after a tick returned. The reviewer reproduced that case: one reservation remains charged and unacknowledged; restart reports `WAKE_OUTCOME_UNKNOWN` without replay. The README now says that `RUN_REJECTED` may occur during admission or acknowledgment and that durable attempt evidence must be inspected. It no longer promises rejection occurred before work.

The author also reported and corrected a false clock-regression race caused by sampling time before taking the run lock. Independent final concurrency tests confirm that pending observers preserve a live owner's acknowledgment and do not produce that false stop. This reviewer did not independently reproduce the older clock-race candidate.

## Independent final evidence

**16 focused probe groups passed** against the final coordinator:

- Ten invalid configuration cases were rejected without creating state.
- Waiting for dispatch and repeated observations of an unknown provider job consumed no extra wakes. A replacement launch was rejected; the exact bound response allowed the next manual step.
- Ten concurrent step subprocesses stayed within a two-wake budget, with one worker, one verifier and one receipt. Exhaustion remained sticky after restart.
- Death after reservation and death after a worker receipt left the relevant attempt charged and unacknowledged. Later steps neither refunded it nor inferred an acknowledgment from the receipt.
- WAIT preserved the principal state and budget, recorded observed time, and stopped durably after a simulated clock rollback.
- The deadline stopped admission before the first wake and was rechecked after a durable reservation. In the latter case the reservation remained charged and the tick was recorded as not started.
- The unrelated-request regression stopped before another reservation.
- Principal changes after reservation stopped the coordinator before its tick; an injected post-tick mutation was detected and stopped further admission.
- Four isolated configuration, reservation, result and checkpoint faults rejected without principal mutation.
- BLOCK and verified COMPLETE were sticky across later steps without additional planner or worker calls. The four-action completion fixture was used only to test coordinator terminal restraint; it is not new autonomy evidence.
- A stale unknown provider job remained present in the exchange view, and the associated out-of-band principal change stopped admission without another wake.
- An actual change to a copied coordinator source file triggered `RUN_BINDING_CHANGED` before principal mutation.
- Five pending observers left the live owner's single reservation intact; its eventual acknowledgment succeeded without a false clock stop.
- The rehashed-checkpoint regression rejected before principal mutation.
- A post-tick invalid-clock failure remained charged and unknown on restart, without replay.

The implementation author's final log records **46 passing tests: 20 coordinator tests plus 26 retained regressions**. This reviewer inspected that log and its hash; the unrelated original suite was not rerun independently. The 11 earlier code, protocol and test files remain byte-identical to the prior reviewed source. The independent final source snapshot matches all 14 implementation files.

## Scope and remaining prerequisites

The fixed budget caps the coordinator's own admitted ticks across supported processes. A reservation is charged before the tick and is never automatically refunded or repeated. Unknown dispatch, unknown consumption and unknown attempt outcomes do not authorize new work. Deadline checks govern admission, not cancellation of an already admitted tick. Clock observations use an ordinary local clock, not an attested time source.

The coordinator does not provide an atomic exclusion boundary against a process that bypasses it and calls the old adapter or principal API. It checks evidence before its call and audits unexpected wakes afterward, but cannot prevent another writer's effects in that interval. The exclusive supported tick-ownership requirement is material. This review does not establish a system-wide budget against bypassing writers, independent authority, hostile-administrator resistance or a sandbox security boundary.

No timer loop, external schedule, model launcher or provider reconciliation service was implemented or activated. Provider idempotency/status primitives, scheduler hosting, credential/access placement, finite operational cadence and any cost approval still require an owner decision. Fresh runs only are supported; there is no migration, reset, extension or automatic new-objective operation.

Atlas R3/Gage R2 acceptance remains unchanged and unproven, including the six-scheduled-wake requirement, genuine unattended execution, full input/tool provenance, owner-controlled authority, off-box anchoring, sealed hidden criteria, the S1–S6 manifest and independent built-boundary co-sign. Manual invocations, injected faults, synthetic responses and retained fixtures do not satisfy those requirements.
