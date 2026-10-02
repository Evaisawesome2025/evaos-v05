# EvaOS v0.5 — Message Eva (real)

**Live:** https://evaisawesome2025.github.io/evaos-v05/  
**Cleanup:** subtractive V0.5 — one primary message surface (see architecture `V05_CLEANUP_REPORT.md`)

Owner → Message Eva (Send) → trusted ingress → Eva process → sanitized reply on this page.

No secrets in client JS. $0. GitHub/Worker/outbox are plumbing, not owner UX. Dogfood access code in localStorage — not production auth.

Prior prototypes kept: [0.4](https://evaisawesome2025.github.io/evaos-v04/) · [0.3](https://evaisawesome2025.github.io/evaos-v03/) · [0.2](https://evaisawesome2025.github.io/evaos-v02/) · [0.1](https://evaisawesome2025.github.io/evaos-v01/)

Atmosphere: upper-left analog clock (`clock.js`) — browser local time only; Ask loop unchanged.

## Dogfood evidence publisher (flag OFF)

`HELM_EVIDENCE_PUBLISH` defaults **unset / 0**. `scripts/process_owner_asks.sh` calls `scripts/dogfood_evidence_publisher/publish_evidence.py` only for a terminal dogfood owner/objective packet that already has evidence URLs. That call writes a local staging outbox, or skips. It does not push Helm `v07/outbox/threads.json` or Joinermill `app/outbox/threads.json`.

Live push stays refused without `HELM_EVIDENCE_PUBLISH=1` and `--i-accept-gage-enable`, and this cut still refuses live dual-write even then. Enable only after a new Gage packet. Not UZ-cleared. Not a clean ship. See `SHIP.md` and `scripts/dogfood_evidence_publisher/FLAG.md`.
