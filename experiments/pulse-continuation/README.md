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
python -B -m unittest -v test_continuation test_consumption
```

These tests use deterministic synthetic proposals and prove local adapter mechanics only. The amended repair stages remain A PASS, B PASS, C evidence FAIL, repair PASS, synthesis COMPLETE, then SLEEP. The asynchronous test takes **11 actual ticks**, including five explicit waiting ticks. It does not establish the exact six scheduled wakes of the Atlas R3/Gage R2 scored standard; that criterion remains only partially demonstrated.

Model integration, when recorded, uses existing fresh task models with manual launch/relay. No such result proves autonomous scheduling, complete platform input/tool-history isolation, an owner-hidden fault, or independent authority. The reviewed `pulse/` modules and their original trust limits are unchanged. Only the new exchange and its tests are additions.

The October 6 reliability revision uses fault-injected synthetic tests only; it launches no new model and makes no new autonomy claim. The earlier six-stage fixture remains regression coverage, not additional scored evidence.

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
