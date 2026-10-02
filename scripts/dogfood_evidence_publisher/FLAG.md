# Dogfood evidence publisher — feature flag

**Flag:** `HELM_EVIDENCE_PUBLISH`  
**Default:** **OFF** (`0` / unset)  
**As of:** 2026-10-02 ~07:15 CT  
**Contract:** `architecture/evaos/operating/cycles/ATLAS_DOGFOOD_EVIDENCE_PUBLISH_CONTRACT_20261002.md`

| State | Meaning |
|-------|---------|
| **OFF** | Build + dry-run + staging writes allowed. **No** live push to Helm `v07/outbox/threads.json` or joinermill `app/outbox/threads.json`. |
| **ON** | Live dual-write code exists. It runs only when a human also passes `--i-accept-gage-enable` after a Gage enable packet. Ask-processor call sites never pass that switch. |

**Enable:** a new Gage AUDITOR packet authorizes flag ON for dogfood-owner scope. Then Eva/Drew, in one manual run, set `HELM_EVIDENCE_PUBLISH=1` and pass `--i-accept-gage-enable` to `publish_evidence.py`. Do not commit the flag. Do not export it from CI or `process_owner_asks.sh`.

**Live targets (only behind both gates):**

| Target | Repo path |
|--------|-----------|
| Helm Objective Bay | `Evaisawesome2025/evaos-v06` `v07/outbox/threads.json` |
| Joinermill product poll | `Evaisawesome2025/joinermill` `app/outbox/threads.json` |

Any other repo or path is refused.

**Non-claims:** flag stays OFF in this repo. Empty live Helm bay stays honest until that manual run. Do not claim “evidence live,” clean ship, or UZ cleared.

## This repo

`HELM_EVIDENCE_PUBLISH` is not exported in this repo, in CI, or in `scripts/process_owner_asks.sh`. Unset and `0` are **OFF**. `run_from_asks.sh` never passes the gage-enable switch, so the ask processor cannot live-push. Not UZ-cleared. Not a clean ship.
