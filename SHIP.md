# Ship note — B1 dogfood evidence publisher

**Path:** EVIDENCE-LOOP-CLOSE · **2026-10-02** · **$0**

This is not a clean ship. User Zero is not cleared. Helm evidence is not live.

## Flag

**Name:** `HELM_EVIDENCE_PUBLISH`  
**Default:** unset / `0` (**OFF**). See `scripts/dogfood_evidence_publisher/FLAG.md`.

Nothing in this repo, and no CI config, sets the flag to `1`.

## What the ask hook does

`scripts/process_owner_asks.sh` calls `scripts/dogfood_evidence_publisher/run_from_asks.sh` only after a dogfood owner or objective packet is already terminal (`ANSWERED` or `DONE`) and already has at least one evidence URL.

Canned `OBJECTIVE:` answers stay enqueue-only. `kind=selftest` stays off the product outbox. Empty evidence does not create a card.

While the flag is OFF, a qualifying packet is written to the local staging file `scripts/dogfood_evidence_publisher/staging/threads.json` only. Presence on that write is idle. That file is not Pages.

## Live dual-write (code present, flag OFF)

The publisher can dual-write a validated terminal packet through the GitHub contents API (same GET/PUT shape as `process_owner_asks.sh`). It does that only when `HELM_EVIDENCE_PUBLISH=1` **and** a human passes `--i-accept-gage-enable`.

| Target | Path |
|--------|------|
| Helm Objective Bay | `Evaisawesome2025/evaos-v06` `v07/outbox/threads.json` |
| Joinermill product poll | `Evaisawesome2025/joinermill` `app/outbox/threads.json` |

`scripts/process_owner_asks.sh` and `run_from_asks.sh` never pass that switch, so the ask processor cannot live-push. Flag unset/`0` remains validate + local staging only. Presence on a terminal publish is idle. Other repos and paths are refused.

Enable only after a new Gage AUDITOR packet: one manual run, flag set in that shell only, switch passed by the human. Do not commit the flag. Do not claim the Objective Bay shows live org evidence from this change.
