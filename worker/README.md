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

## Dogfood hard-stop

Authorized owner `POST /intent` preflights before the GitHub issue write (`assert_job_may_start` mirror → hold work credits). On deny the Worker returns `403` with `error: "hard_stop"` and does not write. On accept it settles `record_job_complete` at the dogfood estimate (`0.05` USD unless `ASK_ESTIMATED_COGS_USD` is set). `kind=selftest` and classes `DEMO` / `REPLAY` / `SELFTEST` / `SAMPLE` do not burn work credits.

Unauthenticated `POST /intent` stays `401`. Stranger write stays off.

The box file ledger under `architecture/evaos/metering/` is not imported here. Without `METERING_KV` the ledger lives in isolate memory and resets with the isolate. A KV binding is the durable bridge; this repo does not create that namespace and does not deploy it.

Work-credit included amount in `src/dogfood_policy.js` is a dogfood placeholder, not a customer allowance. Accept settles at the estimate because this Worker does not see provider token cost. That ledger is separate from the box ledger; do not add them together.

```bash
cd worker && npm test
```

**Claims this wire does not make:** payment-ready, Ready=YES, Stripe, stranger-live Ask, waitlist, ListingLift open. `GET /health` reports `payment_ready: false`, `ready: false`, `stranger_write: false`.
