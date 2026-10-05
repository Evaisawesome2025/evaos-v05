# Pulse durable planner exchange — 2026-10-05 handoff

**Reviewed UNSCORED local upgrade. Partial frozen acceptance; not unattended execution, scored Pulse approval, or production readiness.** This follows the [manual model-planner experiment](PULSE_MANUAL_MODEL_TEST_20261005.md). The prior prototype, evidence and frozen criteria remain unchanged.

## Implemented

Tested source is in [`experiments/pulse-continuation`](../../experiments/pulse-continuation/README.md). The new adapter wraps the unchanged reviewed controller with an immutable SQLite planner exchange. A pending request survives process exit without holding a principal lease or creating a Turn. A later process accepts an exact bound response and resumes through the original admission, start and verification path.

Requests bind state identity, canonical packet, full model input, protocol and code hashes. Responses bind request, input and recorded launch identifiers. Identical response bytes redeliver idempotently; conflicting bytes, stale state, ambiguous JSON and invalid proposal schemas reject. Committed receipts and control-decision events reconcile interrupted acknowledgments. A crash around authorized/running work retains the original conservative expiry/recovery behavior and blocks ambiguous work without replay.

A recorded launch is local dispatch intent only. If its external result is unknown, the adapter stays unresolved and does not blindly launch again. There is no scheduler or model-provider client in this change.

## Evidence and review

- **20 targeted tests passed.** They cover durable waiting/response recovery, exact-byte redelivery, stale and conflicting input, concurrent ticks, code/protocol changes, and crash boundaries.
- **11 independent probe groups passed**, including 12 malformed-schema cases, a mixed 10-process delivery/tick burst, and crashes before start, after receipt commit but before release, and after a control-decision commit. Additional checks confirmed rejected inconsistent records leave both principal state and journal unchanged.
- Review found and corrected inconsistent inner launch/response identifiers, malformed proposal schemas causing repeated exceptions, and an empty persisted response being mistaken for a missing response. Earlier findings and reproductions remain in private evidence.
- **Two new no-history task-model launches** were manually fed current bound inputs. They selected A, then B; each unchanged response survived durable delivery and was consumed once by a new process. Duplicate delivery produced no extra work. Independent audit matched platform-observed final strings, 33 journal events and two PASS receipts. Five principal packet builds occurred; those are not five model calls.
- The two-action integration intentionally stopped OPEN at generation/version 2, with no lease, active Turn or unresolved launch. It did not demonstrate objective completion or a new model-driven repair sequence.

Independent review found no remaining material correctness issue within this stated local scope. No original 35-test fixture rerun is represented as new autonomy evidence.

| Integrity item | SHA256 |
| --- | --- |
| Final adapter `continuation.py` | `ca3bc710788a33b3ade7bdac24eb1a318cebb0a93ec693b97163758b520ab255` |
| Tested source manifest | `280f52e004f03643b9b98c09eda88d896966a536e53520c2bb3e34d16b37bc97` |
| Unchanged reviewed controller code hash | `8066428b71c0200c0a85f24dad4626fdc52eb05ac96441e09f56ed9077abe71c` |
| Pre-test upgrade criteria | `21018ca034090ab8372586fe058e1c23cd7dd41a29eee2fe1b5e8dff47892dc2` |
| Private `Pulse_durable_exchange_UNSCORED_20261005.zip` | `d122b5eef02d4ad7b2bcc817d46ac458545569f91480d11f0858b2503fcef61b` |

The public branch contains source, tests and sanitized records only. Full transcripts, databases, private review material and prior handoff files are not published here. The supported Library helper failed with a network error before returning a file ID; no Library save is confirmed and no alternate upload route was used. Obtain private evidence from its owner and verify its hash.

## What remains

**Frozen criterion 9 remains partial.** The local repair stages retain A PASS, B PASS, C evidence FAIL, repair PASS, synthesis COMPLETE and SLEEP. Five explicit waiting ticks make eleven actual tick opportunities, not the required six scheduled wakes. The frozen criterion was not changed to call this a PASS.

Wakes and model delivery were manual. Complete platform input/tool-history isolation, provider-side exactly-once launch, hidden-fault reasoning and owner-controlled authority are unproved. Local checksums are not inaccessible MAC seals; visible fixtures are not owner-hidden criteria.

The next decision is an owner-approved finite scheduler and programmatic fresh-model launcher providing durable job IDs, idempotency/reconciliation and auditable no-steer bindings. Minimum access is confined to reading bound requests and appending launch/results in an isolated sandbox. No service was selected or activated, and no separately credentialed paid API was called. Obtain provider/key and cost approval before API-dependent work.

Scored proof still requires the separate owner-controlled principal/gate/verifier, off-box reviewed-code anchor, sealed hidden catalog/fault data with sufficient repair choices, S1–S6 manifest, independent observation and built-boundary Gage/Sentry co-sign. Do not replace that bar with this local result.

This isolated branch changes no main, held PR32, website feature branch, deployment, credential, network policy or schedule. It authorizes no production/customer work or business effects. A future operator, including Grok Bot, should start with the README, source manifest, frozen criteria and unresolved prerequisites above.
