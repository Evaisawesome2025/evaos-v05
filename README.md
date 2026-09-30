# EvaOS v0.5 — in-product Ask (real)

**Live:** https://evaisawesome2025.github.io/evaos-v05/  
**Prior (kept):** [v0.4](https://evaisawesome2025.github.io/evaos-v04/) · [v0.3](https://evaisawesome2025.github.io/evaos-v03/) · [v0.2](https://evaisawesome2025.github.io/evaos-v02/) · [v0.1](https://evaisawesome2025.github.io/evaos-v01/)

Owner Ask (real, in-product): EvaOS Submit → Cloudflare Worker (bearer) → hidden Issue inbox → Eva `process_owner_asks.sh` → `outbox/threads.json` → Pages.

No secrets in client JS. $0 (CF Workers free tier). No new agent. GitHub is plumbing, not owner UX.

Dogfood auth: owner bearer in browser localStorage (paste once) — **not** long-term production auth.
