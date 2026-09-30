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
Never commit secrets. CORS allowlist: `https://evaisawesome2025.github.io`.
