# Dogfood evidence publisher (B1 / CC-v0.7.1)

**Path:** `EVIDENCE-LOOP-CLOSE` · **$0** · flag **OFF** until Gage  
**Implements:** Atlas contract `ATLAS_DOGFOOD_EVIDENCE_PUBLISH_CONTRACT_20261002.md`  
**Built:** 2026-10-02 ~07:15 CT (UZ-FC-20261002-001)

## What this is

A reversible, flag-gated publisher that turns a **terminal** dogfood-owner objective (ANSWERED / DONE + ≥1 re-fetchable evidence URL) into a sanitized outbox record shaped for Helm Objective Bay + joinermill dual-write.

## What this is not

- A live push while the flag is OFF
- Stranger write / Clerk / waitlist / pay
- DEMO-as-PoW · Worker-accept-as-evidence · busy theater
- ListingLift / Charles / Path2
- A clean ship or a UZ-cleared claim

## Usage (flag OFF = staging only)

```bash
# Validate + write staging outbox (default)
python3 publish_evidence.py --packet fixtures/UZ-FC-20261002-001.json

# Explicit dry-run (no staging write)
python3 publish_evidence.py --packet fixtures/UZ-FC-20261002-001.json --dry-run

# Live dual-write exists and stays OFF.
# Ask hooks never pass the gage-enable switch.
# After a Gage packet, a human may run one manual publish with
# HELM_EVIDENCE_PUBLISH=1 and that switch. Do not commit the flag.
```

From the evaos-v05 repo root:

```bash
python3 scripts/dogfood_evidence_publisher/publish_evidence.py \
  --packet scripts/dogfood_evidence_publisher/fixtures/UZ-FC-20261002-001.json \
  --dry-run
```

## Files

| Path | Role |
|------|------|
| `FLAG.md` | OFF until Gage |
| `publish_evidence.py` | Validator + staging writer |
| `fixtures/*.json` | Terminal packets |
| `staging/threads.json` | Local staging outbox (not Pages) |
| `dry_run/` | Dry-run receipts |
| `select_packets.py` | Ask-hook filter: terminal + evidence only |
| `run_from_asks.sh` | Call site used by `scripts/process_owner_asks.sh` |

## Drew handoff

Wire this into `evaos-v05/scripts/process_owner_asks.sh` **behind the same flag** when ready: on uz DONE / Ask ANSWERED with evidence[], call this publisher. Do **not** push live until Gage enable packet.

**Wired in this repo (flag still OFF).** `process_owner_asks.sh` calls `run_from_asks.sh` at the end. That hook calls `publish_evidence.py` only for a dogfood owner/objective packet that is already terminal (`ANSWERED` or `DONE`) and already has at least one evidence URL. Canned OBJECTIVE answers and `kind=selftest` never qualify.

- `HELM_EVIDENCE_PUBLISH` unset or `0`: staging file only (or no call, when nothing qualifies). No live dual-write.
- The hook never passes the gage-enable switch. With the flag ON and no switch, the publisher hard-refuses.
- Live dual-write runs only when a human sets the flag and passes that switch on `publish_evidence.py`. Targets are Helm `Evaisawesome2025/evaos-v06` `v07/outbox/threads.json` and Joinermill `Evaisawesome2025/joinermill` `app/outbox/threads.json` (same contents API as the ask dual-write). Other repos are refused.
- Tests point `EVIDENCE_LIVE_SINK=dir:<tmp>` so they do not push Pages. The default sink is `gh`.

Not UZ-cleared. Not a clean ship. Do not claim evidence is live.
