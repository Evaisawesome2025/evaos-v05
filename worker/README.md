# evaos-v05-ask Worker

Trusted Ask ingress. Secrets via `wrangler secret put` only:

| Secret | Purpose |
|--------|---------|
| `OWNER_BEARER` | Single-owner dogfood bearer (same value Glen pastes into EvaOS localStorage) |
| `GH_PAT` | Fine-grained PAT: Issues write on `Evaisawesome2025/evaos-v05` only |

```bash
cd worker
npm install
npx wrangler login          # Glen CF account — free tier
npx wrangler secret put OWNER_BEARER
npx wrangler secret put GH_PAT
npx wrangler deploy
```

After deploy, set public Worker URL in Pages `app.js` (`WORKER_URL`) or `window.EVAOS_WORKER_URL`.
Never commit secrets. CORS allowlist: `https://evaisawesome2025.github.io`, `https://joinermill.com`, `https://www.joinermill.com`, and local `http://127.0.0.1:8765` / `http://localhost:8765`.

## Hard-stop gate (dogfood WC, not a charge)

Payment FAIL is **not** lifted. Ready stays **no**. This worker does not call Stripe, capture a payment, arm a waitlist, or open stranger write. Unauthenticated `POST /intent` still returns 401.

Before a **billable** owner ask creates its GitHub issue, the worker runs the same allow/deny shape as the box `preflight` hook:

- Included allowance is the dogfood placeholder in `src/hardstop.js` (50 WC / calendar month CT, $0.10 per WC, hard stop at 100%, 1 WC reserve floor, 40 jobs/day, $5 estimated COGS/day). That figure is not a customer allowance.
- Hold quote: `estimated_cogs_usd / 0.10 × complexity multiplier`. A normal ask uses job class `ask_reply` (×1) and the wire-contract sample estimate **$0.05**, so the hold is **0.5 WC**. The browser cannot set `billable: false` to skip this.
- **Deny** (HTTP 403 `error: "hard_stop"`) when the hold would cross the hard stop, eat the reserve, or pass a daily cap. The issue is not created.
- **Allow** writes the hold into the ledger **before** the GitHub write. `hold_wc` is returned on the 201 and copied into an HTML comment on the issue for the box. That comment is not a charge.
- If the GitHub write fails, the hold is released. No `JOB_COST` row is written for a job that did not start.
- `POST /metering/complete` (same owner bearer) settles a hold into a `JOB_COST` row. That is ledger burn, not payment capture. Client `hold_wc` is ignored; the stored hold is used.

`DEMO`, `REPLAY`, `SELFTEST`, and `SAMPLE` (and the existing selftest / “loop check” kind) stay non-billable: hold `0`, balance unchanged, and they still run when the ledger is unbound.

The durable store is Workers KV binding `METERING_KV` (one JSON document per workspace). This repo has no D1 or Durable Object. The namespace is **not** created here. Until the binding exists, billable asks fail closed with `metering_unconfigured`. KV writes are awaited before the job starts; they are not a transaction, so two overlapping billable asks can race. Dogfood traffic is single-owner.

Box Python ledgers are not imported. `auto_overage: true` still denies — overage is not a charge path.
