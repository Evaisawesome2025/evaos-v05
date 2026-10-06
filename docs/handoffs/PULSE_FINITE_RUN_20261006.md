# EVAOS/Pulse finite-run coordinator — 2026-10-06

**UNSCORED sandbox component. Manually invoked steps, simulated provider/time tests, no live scheduling or autonomous model launch.**

Base commit: `e3ae254b30924938daac0cd41a491c26645845a1`. This bounded addition supplies a finite-run primitive for completion-aware EVAOS/Pulse playbooks. Public playbook/workspace UI is separate work. No website, production deployment, main merge, held PR, external schedule, provider, credentials, account or paid API was changed or activated.

## Delivered behavior

`coordinator.py` initializes fresh synthetic principal/exchange/run databases. Its immutable configuration fixes one run ID, a wake budget of 1–100, an absolute deadline from a duration of at most 86,400 seconds, and the initial objective/state/journal/exchange/code bindings. A manually invoked `step` admits at most one existing adapter tick.

A wake reservation commits before the tick and remains charged across process death. Concurrent steps cannot allocate beyond the same run budget. A reservation without acknowledgment blocks further admission; it is never refunded, repeated or automatically declared successful. A concurrently running owner may still finish its original acknowledgment. A dead owner requires review, even when the principal has a receipt.

WAIT before its deadline, an undispatched request and a recorded provider job without a bound response cause no tick or wake-budget charge. Unknown jobs are never launched or retried by the coordinator, including stale jobs. Only launch/response additions for the exact previously waiting request are permitted between steps. An exact valid result may unblock a later manual step; unrelated exchange requests or unexpected principal changes stop admission.

Verified COMPLETE, BLOCK, budget exhaustion, deadline expiry and review-required conditions create durable terminal stops. No run reset, extension, migration or new-objective command exists. Deadline checks occur at reservation and immediately before tick admission, not as cancellation of work already running. Clock observations—including no-work pauses—are persisted under the run lock; detected backward time stops the run.

Every reservation and result links the run, objective/version, principal state/journal evidence, exchange record hashes, request/input/output hashes and launch identities. Checkpoints must follow the allowed transitions from the previous bound result. The README supplies the CLI, status table and future launcher contract.

## Findings fixed during development and review

1. **Unrelated request spent a wake in the draft.** A second structurally valid request/response could make the coordinator tick while the original request still awaited dispatch. Independent reproduction showed wakes increasing from one to two with no worker. Durable exchange checkpoints now reject that unrelated transition before reservation.
2. **Concurrent time observation produced a false rollback stop.** An acknowledgment sampled time before obtaining the run lock, then compared that stale value with a newer pending observer's time. Admission rechecks and acknowledgment now observe time under the run transaction.
3. **A rehashed checkpoint could bypass the draft transition restriction.** Changing only the stored latest checkpoint to an unrelated exchange view let another wake be spent. The final validation reconstructs checkpoint lineage from the initial exchange and bound attempts/results, rejecting this mismatch before principal mutation. Author and independent reviewer preserved before/after reproductions.
4. **Rejection wording overstated certainty.** An invalid clock or binding during acknowledgment may occur after a tick already ran. The corrected documentation tells callers to inspect the durable attempt rather than infer no execution or retry.

## Validation and preservation

- Frozen before implementation/tests: `FINITE_RUN_CRITERIA_20261006.json`, SHA-256 `2cf1846bbbf65e460fcb947383f3e726022e9f880b12f58b8a19d37b6fbf0cc2`.
- Final command: `python -B -m unittest -v test_continuation test_consumption test_coordinator` — **46 passing tests**: 20 coordinator tests plus 26 retained regressions.
- **16 independent adversarial probe groups passed**, covering competing processes, unknown jobs, exact result resumption, crash boundaries, WAIT/terminal restraint, both deadline checks, checkpoint/record faults, stale jobs, changed code and pending-owner acknowledgment ordering. The reviewer found no remaining material issue within the documented supported ownership boundary.
- Coordinator SHA-256: `222a66fe817e9304fa6a122ce1efe74ecd351a7bcd66c19c8b7d452e08bbcad0`.
- Fourteen-file source-manifest SHA-256: `a71cfb1244fc20948f72c2cbef6b4db14af5260b34ee47366e81e62150c6a1e9`.
- The prior exchange, seven controller modules, planner protocol and two earlier test modules are byte-identical. All four earlier evidence ZIPs remain hash-identical. Historical acceptance records remain unchanged.

See `experiments/pulse-continuation/FINITE_RUN_REVIEW_20261006.md`, `FINITE_RUN_EVIDENCE_20261006.json`, `SOURCE_MANIFEST.json` and the executable tests. The new local evidence bundle preserves initial failures, independent probes, final results and tested source. No Library retry or bypass was attempted after the known supported-helper network failure; no new Library ID is claimed.

## Boundary and live-integration decisions

All tick calls within a supported run must go through the coordinator. It does not fence a separate process calling the older adapter/principal API directly. Before/after checks detect observed drift and unexpected wakes, but cannot prevent an external writer's effects between checks. The budget therefore caps coordinator admissions, not arbitrary processes. Shared local files and checksums are not agent-inaccessible authority, trusted seals or attested time.

Use fresh databases. Exchanges retain adapter-hash binding, and runs additionally bind the coordinator hash; no old-state migration is supplied. No new planner model was invoked. Tests using synthetic responses, advanced clocks or killed subprocesses are local simulation/fault evidence. They do not meet the unchanged Atlas R3/Gage R2 boundary, full input/tool provenance, owner-hidden criteria, independent authority, off-box anchoring, S1–S6 setup or built-boundary co-sign. Preparation ticks still count; the previous six-scheduled-wake requirement remains unproven.

Live integration still needs explicit decisions on: (1) the scheduler host, finite cadence/budget/deadline and exclusive tick ownership; (2) a provider with durable job IDs, idempotency and status/result reconciliation; (3) credential placement and least-privilege access for the launcher; (4) retention and audit of exact inputs/results and provider bindings; and (5) API prices/spend approval. Unknown dispatch must reconcile the same job, not blindly replace it. None of these external choices was implemented or activated. Work stops after this coordinator.
