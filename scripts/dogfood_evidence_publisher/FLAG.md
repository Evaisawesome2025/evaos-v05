# Dogfood evidence publisher — feature flag

**Flag:** `HELM_EVIDENCE_PUBLISH`  
**Default:** **OFF** (`0` / unset)  
**As of:** 2026-10-02 ~07:15 CT  
**Contract:** `architecture/evaos/operating/cycles/ATLAS_DOGFOOD_EVIDENCE_PUBLISH_CONTRACT_20261002.md`

| State | Meaning |
|-------|---------|
| **OFF** | Build + dry-run + staging writes allowed. **No** live push to Helm `outbox/threads.json` or joinermill `app/outbox/threads.json`. |
| **ON** | Only after Gage enable packet PASS. Then Eva/Drew may dual-write dogfood-owner terminal records with `evidence[]`. |

**Enable resume_when:** Gage packet (new AUDITOR id) explicitly authorizes flag ON for dogfood-owner scope only.

**Non-claims while OFF:** empty live Helm bay is honest; do not claim “evidence live.”

## This repo

Copied to `evaos-v05` at `scripts/dogfood_evidence_publisher/FLAG.md`.

`HELM_EVIDENCE_PUBLISH` is not exported in this repo, in CI, or in `scripts/process_owner_asks.sh`. Unset and `0` are **OFF**. This cut does not push Helm `v07/outbox/threads.json` or Joinermill `app/outbox/threads.json`. Not UZ-cleared. Not a clean ship.
