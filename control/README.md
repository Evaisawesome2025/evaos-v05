# EvaOS v0.4 control plane (thin)

- **Inbox:** GitHub Issues labeled `owner-ask` on this repo.
- **Outbox:** `../outbox/threads.json` (public, sanitized — no secrets/PII emails).
- **Allowlist:** `ALLOWLIST.txt` — only these authors get answers.
- **Processor:** `../scripts/process_owner_asks.sh` run by Eva on the box (on-demand). Not a always-on daemon.

Public channel. Do not put credentials in Issues.
