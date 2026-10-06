# Pulse durable planner exchange — UNSCORED sandbox adapter

This small adapter adds durable planner request/response storage around the unchanged reviewed local Pulse controller. It contains no model provider client, scheduler, credential handling, network calls, or business-effect adapter. Use synthetic fixtures only.

The earlier manual experiment kept a Python process waiting for a parent-relayed model result. Here a waiting tick saves an immutable request and exits, releasing the principal lease without creating a Turn. A later process can record one launch identity, accept its exact bound response, and resume through the original admission/start/verification path. A committed principal receipt or control-decision event reconciles an interrupted acknowledgment.

## Local interface

Python 3.12+, SQLite and `fcntl`; no installation is required. Run from this directory with `PYTHONDONTWRITEBYTECODE=1`.

```sh
python continuation.py init /tmp/new-pulse-state --scenario defect_repair
python continuation.py tick /tmp/new-pulse-state
python continuation.py requests /tmp/new-pulse-state
```

The waiting request contains `request_id`, `input_sha256` and exact `input_text`. An authorized launcher must persist a unique launch identifier, record dispatch intent, then start a fresh model using that text and submit the single unchanged JSON result:

```sh
python continuation.py record-launch STATE REQUEST_ID INPUT_SHA256 LAUNCH_ID
python continuation.py deliver STATE REQUEST_ID INPUT_SHA256 LAUNCH_ID < model-output.json
python continuation.py tick STATE
```

These are manual interface examples, not an installed launcher. `record-launch` records local dispatch intent. If the launcher crashes before or after the actual model call, the exchange cannot distinguish those cases: `DISPATCH_RECORDED_RESULT_UNKNOWN` stays pending and no replacement launch is permitted automatically. Provider-side idempotency/reconciliation or owner review is still required.

Each response binds the state identity, reviewed controller hash, adapter/protocol hashes, canonical packet, full input and launch ID. Identical redelivery is idempotent; conflicting bytes, wrong bindings, stale state, ambiguous JSON and malformed proposal schemas reject. Immutable SQLite rows and checksums detect inconsistent records; they are not protection against an administrator who can rewrite the code and database.

Before returning a response to the controller, the adapter now commits one immutable consumption record bound to that request, packet, input, exact output, launch and code/state identity. This closes an acknowledgment-loss gap: previously, a rejected ACTION or premature COMPLETE could be submitted again after process death between controller return and exchange acknowledgment. A missing acknowledgment now reports `CONSUMPTION_RECORDED_OUTCOME_UNKNOWN`. A current unresolved consumption with no held lease or pending recovery raises `CONSUMPTION_REQUIRES_REVIEW` before a new principal mutation. It is not evidence that execution succeeded or even began. Matching committed receipts and WAIT/BLOCK decisions still reconcile without replay.

This deliberately trades automatic retry for restraint. A crash immediately after consumption commits may require review even if the response never reached the controller. Existing lease expiry/recovery may make that packet stale and permit a new planning request; it never makes the old response consumable again. The adapter does not infer a rejected outcome from an unbound journal rejection. No reset/retry bypass is provided.

Existing exchange databases are bound to their adapter hash and will reject this changed code. Preserve earlier states with their original code; use a new synthetic state for this revision. There is no automatic state migration.

Hard process death while the original principal lease is held uses its existing expiry/recovery rules. A crash after start without a verified outcome remains ambiguous and becomes BLOCKED without replay. A completed receipt is recovered without repeating work. Recovery may invalidate an old unconsumed response; this is a deliberate stale-plan rejection, not automatic success.

## Validation and limits

```sh
python -B -m unittest -v test_continuation test_consumption test_coordinator
```

These tests use deterministic synthetic proposals and prove local adapter mechanics only. The amended repair stages remain A PASS, B PASS, C evidence FAIL, repair PASS, synthesis COMPLETE, then SLEEP. The asynchronous test takes **11 actual ticks**, including five explicit waiting ticks. It does not establish the exact six scheduled wakes of the Atlas R3/Gage R2 scored standard; that criterion remains only partially demonstrated.

Model integration, when recorded, uses existing fresh task models with manual launch/relay. No such result proves autonomous scheduling, complete platform input/tool-history isolation, an owner-hidden fault, or independent authority. The reviewed `pulse/` modules and their original trust limits are unchanged. Only the new exchange and its tests are additions.

The October 6 reliability revision uses fault-injected synthetic tests only; it launches no new model and makes no new autonomy claim. The earlier six-stage fixture remains regression coverage, not additional scored evidence.

## Finite-run coordinator (sandbox, manually stepped)

`coordinator.py` adds one finite run around the existing exchange. It contains no timer loop, scheduler installation, provider client or model launcher. Each `step` is an explicit invocation that may admit at most one existing adapter tick. Use a fresh synthetic directory:

```sh
python -B coordinator.py init /tmp/new-finite-pulse --max-wakes 12 --duration-seconds 3600 --scenario defect_repair
python -B coordinator.py step /tmp/new-finite-pulse
python -B coordinator.py show /tmp/new-finite-pulse
python -B continuation.py requests /tmp/new-finite-pulse
```

After preparation, the existing exchange can accept an authorized launch intent and exact response through `record-launch` / `deliver`. The coordinator performs neither operation. A later manual `step` may consume that response. Within a coordinator-owned run, **all tick calls must go through `coordinator.py step`**; do not call `continuation.py tick`, mutate principal state or create additional requests separately.

The immutable run configuration fixes one run ID, a budget of 1–100 wakes, and an absolute deadline computed once from a duration of at most 86,400 seconds. The run journal lives under the synthetic state directory in `finite-run/`. It binds the initial objective, principal state/journal, exchange identity, controller/adapter/protocol hashes and coordinator hash. A reservation commits before every tick and counts against the budget even if the process dies before starting. There is no refund, reset, extension, replay or new-objective command.

Each reservation and acknowledgment records principal objective/version/state/journal evidence and exchange record hashes, request IDs, input/output hashes and launch IDs. Between steps, only launch/response additions for the exact waiting request are allowed; unrelated requests or principal changes stop the run. Existing rows must remain unchanged. Acknowledgments bind the exact reservation and before/after evidence. Hashes establish local consistency, not independent authority.

| Coordinator result | Behavior |
| --- | --- |
| `TICK_RECORDED` | One charged tick returned and its result was recorded. |
| `AWAITING_DISPATCH` | The exact request awaits an external authorized launcher; no tick or budget charge. |
| `PROVIDER_RESULT_UNKNOWN` | A recorded job lacks a bound response; no tick, retry or replacement launch. The exact response may allow a later manual step. |
| `WAIT` | The principal deadline has not arrived; no planner, worker or budget charge. |
| `WAKE_OUTCOME_UNKNOWN` | A charged reservation has no acknowledgment. A concurrent owner may still finish it; a dead owner requires review. No automatic replay or guessed acknowledgment, even if a receipt exists. |
| `STOP_*` | Durable terminal stop: completion, block, exhausted budget/deadline, drift or review requirement. Subsequent steps preserve it. |
| `RUN_REJECTED` | Binding, integrity or clock validation failed during admission or acknowledgment. A tick may already have run; inspect the durable attempt evidence. Rejection does not authorize replay. |

Deadline checks occur at reservation and again immediately before calling the adapter. They govern admission; they do not cancel a tick already in progress. Clock observations are recorded under the run lock, including no-work pauses. A backward observation stops the run. This assumes an ordinary trustworthy local clock; it is not attested time. Tests that advance time or supply provider-like results are explicitly simulations.

The coordinator serializes its own reservations and caps its own admitted ticks across processes. It does **not** lock out a separate process that bypasses the coordinator and calls the old adapter or principal API. It checks for drift before the call and audits unexpected wakes afterward, but cannot prevent an external writer's effects in that interval. Exclusive supported tick ownership and the stronger independent authority boundary remain prerequisites; this is not adversarial isolation.

An unresolved provider job—including a stale job—never authorizes another tick. An out-of-band principal change can stop the run for drift before reporting the job. Interrupted consumption or principal recovery is not repaired automatically by this coordinator. Preserve the evidence for review. Each run starts with fresh databases; existing exchanges retain their adapter-hash checks, and coordinator runs also reject a changed coordinator hash. The existing exchange implementation is unchanged in this increment. No migration of earlier states is provided.

The finite coordinator is a local primitive for completion-aware execution within EVAOS/Pulse. It is not live scheduling or autonomous launch proof. Existing Atlas R3/Gage R2 acceptance remains unchanged; in particular, preparation ticks still count as wakes and this does not establish the six-scheduled-wake criterion. No additional planner-model run is part of this increment.

## Finite launcher contract (not activated)

A future approved launcher must use a finite run budget/deadline, persist a unique job identity before dispatch, and bind that job to the exact request and input hash. Record local launch intent before calling a provider. On process restart, reconcile the same durable job through provider idempotency/status APIs; a local dispatch record alone cannot establish whether a provider ran it. Never invent a replacement launch for an unknown result.

| Exchange status | Permitted next step within an approved run |
| --- | --- |
| `READY_FOR_LAUNCH` | Persist a unique job, record intent, dispatch the exact input once through a provider with reconciliation support. |
| `DISPATCH_RECORDED_RESULT_UNKNOWN` | Reconcile that job; no blind retry or replacement launch. |
| `RESPONSE_READY` | Request a bounded tick; consumption is committed before controller submission. |
| `CONSUMPTION_RECORDED_OUTCOME_UNKNOWN` | Reconcile committed evidence or existing principal recovery; otherwise stop for review. |
| `RESOLVED` | Use the committed disposition; do not replay that response. |
| `STALE_NO_EXECUTION` | Do not launch or consume that request; obtain current principal state. |

The scheduler must also obey principal WAIT deadlines, BLOCK/COMPLETE terminal state, live leases, recovery and the run budget; this status table grants no authority. Return the exact model bytes with their request/input/job bindings; do not edit or steer results. Tests here establish local at-most-once response submission, not provider-side exactly-once execution.

Still requiring owner choice: scheduler host and finite cadence/budget; provider idempotency and job-status primitives; credential placement and access boundaries; retention/audit requirements; any API pricing or spend approval. No implementation or activation of those services is included.

Before unattended execution, an approved finite scheduler must be connected to a durable fresh-model launcher with recovery, provider idempotency/reconciliation and auditable no-steer bindings. Obtain any provider/key/cost decision before implementing or invoking a separately credentialed service. Scored proof still requires the owner-controlled principal/gate/verifier, off-box code anchor, sealed hidden criteria/fault data, S1–S6 manifest, independent observation and Gage/Sentry built-boundary co-sign. No scheduler or production setup is authorized by this package.
