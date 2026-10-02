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

## Live push (not this cut)

Live targets, when a later cut implements them after Gage:

| Target | Path |
|--------|------|
| Helm Objective Bay | `Evaisawesome2025/evaos-v06` `v07/outbox/threads.json` |
| Joinermill product poll | `Evaisawesome2025/joinermill` `app/outbox/threads.json` |

`publish_evidence.py` hard-refuses that push unless `HELM_EVIDENCE_PUBLISH=1` **and** `--i-accept-gage-enable`. The ask hook never passes that switch. Even with both, this cut still refuses and does not dual-write. Implement the live write only in a follow-on after a new Gage AUDITOR packet.

Do not claim the Objective Bay shows live org evidence from this change.
