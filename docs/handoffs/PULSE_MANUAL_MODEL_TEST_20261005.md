# Pulse manual model-planner test — 2026-10-05

**Status: completed, independently reviewed, UNSCORED. Not autonomous scheduling, a scored Pulse acceptance, or production readiness.** This is a sanitized technical handoff for a future operator, including Grok Bot. It records one synthetic experiment against the unchanged reviewed local prototype; it does not authorize further execution.

## What ran

Six manually launched wake opportunities used six fresh Python processes and five new task-model launches with no conversation history fork. Each planner received the same frozen generic JSON protocol plus the current principal-built planning packet. Its single returned JSON was relayed unchanged, without retries, schema repairs, steering, or deterministic planner fallback. The expected sequence was frozen before the run and was not included in the recorded planner prompts.

Only planning used task models. The worker and verifier remained the reviewed, visible deterministic fixtures. The three packets contained synthetic numeric observations, with no customer data or business effects.

| Wake | Selected action | Observed result | Verified generation | State version |
| --- | --- | --- | ---: | ---: |
| 1 | Analyze A | PASS | 1 | 1 |
| 2 | Analyze B | PASS | 2 | 2 |
| 3 | Analyze C | Evidence FAIL | 2 | 3 |
| 4 | Repair C evidence | PASS | 3 | 4 |
| 5 | Synthesize | PASS / COMPLETE | 4 | 5 |
| 6 | No planner launch | SLEEP_COMPLETE | 4 | 5 |

C's visible fixture omitted one observation. The submitted artifact genuinely failed the unchanged check; no verdict was forced. Verified progress and the B predecessor remained unchanged. A fresh planner selected repair from the next packet's durable failure record. The repair used B as parent at generation 3. Synthesis cited the verified repair, excluded failed C, and produced nine observations totaling 45. The final sleep added no planner launch, worker/verifier call, Turn, or verified progress.

## Independent review and integrity

A separate non-author reviewer found **no material finding within this bounded UNSCORED scope**. The audit checked all 114 extracted candidate files, six distinct wake processes, 56 hash-linked journal events, five receipts, state/packet/proposal/artifact bindings, and offline failure/repair verdicts. Five final model outputs observed directly through the task platform matched the relayed bytes exactly. This corroborates the visible output relay, not complete platform transcript provenance.

The previously recorded 35 tests and 31 probe groups were preserved; that fixture suite was not rerun and presented as new model evidence.

| Evidence | SHA256 |
| --- | --- |
| Original reviewed delivery ZIP | `337d6bdef9bbb75316f33bf2e54088d21a309c624373a36f03ae5ce7093f664d` |
| Inner reviewed candidate ZIP | `4ca4d99d13aa5ae06ca5fd0ba9929973decc8ca14ab3ecf5a6899d9bd0331127` |
| Runtime code hash | `8066428b71c0200c0a85f24dad4626fdc52eb05ac96441e09f56ed9077abe71c` |
| Pre-run experiment freeze | `c0416c923961cad0b110a8e47da95cc3bf1b2e2a017f91033cf3cc9b1425c8f2` |
| New evidence ZIP: `Pulse_manual_model_planner_UNSCORED_20261005.zip` | `6427f7689f03a6fe0bc0a3a123112d0b782a2caef35a68b667cd5bc38151d6b2` |
| Independent review report | `78670b28cff7ec9d79632c2d5fcc549980a45242ab40df43a429637082aee78b` |

Full prompts, outputs, state snapshots, receipts, the database/journal, reviewer scripts and prior evidence remain in the privately retained package, not this public repository record. The subsequent supported Library upload attempt failed before returning a file ID; a Library save is not confirmed. Obtain the archive from its owner and verify the hash before relying on it.

## Limits and next prerequisites

- Wakes were manually launched and model results manually relayed. Ordinary child-task messages and the file bridge are not a durable autonomous scheduler.
- No-history launches do not prove complete input isolation, absence of all tool use, a validated line-zero comparison, or independently sealed full transcripts. Inherited platform instructions and shared tools/filesystem remained available.
- Local checksums and cooperating interfaces are not MAC seals, substitution prevention, an agent-inaccessible principal/gate/verifier, or an external evidence anchor.
- The fault was a visible fixture, and the packet explicitly revealed the repair slot from a one-repair-choice catalog. This is not owner-hidden fault discrimination or a REASON proof. Artifact PASS means submitted synthetic bytes met the visible check, not independently proven labor.
- For a next scheduled test, first obtain authorization for a finite durable scheduler connected to a programmatic fresh-context model launcher and principal relay, with recovery and auditable no-steer input/output binding. If this needs a separately credentialed provider or billable API, obtain the owner's provider/key and cost decision before implementation or calls.
- A scored run additionally requires the owner-controlled Atlas R3/Gage R2 boundary: an agent-inaccessible principal and credentials, off-box anchored reviewed code, an owner-authored sealed catalog and evidence-true hidden-fault capsule with at least eight plausible repair choices, the sealed S1–S6 manifest, independently checked transcript/relay provenance and observation, and built-boundary Gage/Sentry co-sign. The amended six-wake standard governs; do not substitute the original five-wake baseline or a forced FAIL.

The experiment introduced no new credentials, separately paid model API calls, external writes, persistent schedules, network/security changes, deployments, or business effects. This later documentation-only publication does not change the runtime or main branch, merge held PR32, or authorize deployment. Resume from the evidence and unresolved prerequisites above; do not infer broader approval from the local outcomes.
