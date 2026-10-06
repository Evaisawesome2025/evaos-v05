# Cloud release handoff — 2026-10-06

**Status: tested candidates; production release blocked before any deployment.** Public cloud access works. The existing authenticated request path returned HTTP 401, so current Worker provenance and rollback readiness remain unverified. This checkpoint changes release documentation only; candidate runtime files are unchanged.

Frontend source: `ad0af760bae86702526bd935ff6fc5fc17a172f9`. Backend source: `c23ce45671e9d8bc9d153d65b277caae2f1513a2`. Both exact remote branch tips and the documented ancestry chains were verified. Backend changes after `d39936927821ce80087194eec948c7d94857037b` are documentation only. See [machine-readable status](CLOUD_RELEASE_STATUS.json) and [test evidence](docs/release-evidence/cloud-20261006/).

Fresh verification passes 25 frontend unit tests, 70 backend tests, 64 browser groups, and 36 axe scans with zero violations or page errors. The shared brief model is byte-identical. Desktop/mobile screenshots were inspected. Browser checks use synthetic input and intercept the Worker URL to invoke the real local handler. They do not establish live deployment correctness. Independent offline review found no runtime blocker and passed 66 delegation cases, four stateless origin cases and six mocked deployment-helper cases. Its live-release signoff remains conditional.

At 02:55:31 UTC, one unauthenticated GET to each public URL returned origin HTTP 200 and CONNECT 200 with no redirects or network errors. The homepage title was “EvaOS — your workspace, by Joinermill”; the health summary was `{"ok":true,"service":"evaos-v05-ask"}`. Exact timestamps and response hashes are in the status file.

At 03:00:20.695 UTC, a single authenticated GET to `https://api.cloudflare.com/client/v4/user/tokens/verify` through the repository-documented existing proxy/credential environment returned HTTP 401. Further authenticated requests stopped. No raw credential, settings or response body was printed or saved. The response does not establish whether token validity, scope or destination substitution caused the failure. No approval-review rejection occurred; no deployment was attempted.

## Safe continuation

1. Establish the supported existing secret-substitution path for `api.cloudflare.com`; do not create credentials or alter access settings under this release scope.
2. Fetch current Worker deployments/version, settings and module through that authenticated API. Save only sanitized metadata, settings fingerprint, and authorized source capture; never persist raw settings or secrets. Compare the exact current module to preserved source SHA-256 `7976a5690e588c36f220b7b9e2fad588b57f9180da26cbfa823dfbe9497ab84f`. Refreshing only a version ID is insufficient. Stop for unresolved drift.
3. Establish rollback to the actual captured predeploy module/settings. Historical version `514bf8c7-30cb-4f8f-bc9e-2c08882a45e8` is not newly attested. The preserving helper checks settings equality even during rollback, so it cannot restore an unexpected settings change by itself. Do not use old backend main or plain Wrangler as rollback.
4. Recheck exact remote candidate/main refs and production state immediately before writes. Deploy backend first with the reviewed preserving procedure. Verify deployed module hashes, every setting/binding, health, harmless synthetic stateless validation and existing route preservation. Stop or safely roll back if checks fail.
5. Only after backend verification, publish frontend using existing GitHub Pages configuration. Current mode is legacy `main:/` with `joinermill.com`; checked-in `Deploy GitHub Pages` is disabled manually. The active dynamic Pages workflow succeeded for `4123538bf18c4eb322c20247e23656625df40169`: [existing run 37367233537](https://github.com/Evaisawesome2025/joinermill/actions/runs/37367233537). Preserve configuration; monitor the new exact commit/build and verify live desktop/mobile flows.

Current frontend production source/rollback reference remains `4123538bf18c4eb322c20247e23656625df40169`; backend repository main is `c15db296c5a7dbf2cb5df40ba8fbe9443e578570` and is not a production rollback source. No live rollback was needed because nothing was deployed. Held PR15/32, Pulse, private archives, customer data, services/spending and access settings remain untouched.

## Reproduce local verification

Use sibling frontend/backend checkouts at the source SHAs above. In the frontend, run `npm_config_cache=/tmp/joinermill-release-npm-cache npm ci --ignore-scripts --no-audit --no-fund` and `npm test`; in backend `worker`, run `npm test`. Serve the frontend with `python3 -m http.server 8765 --bind 127.0.0.1`, then run `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:browser`. All inputs are synthetic. The initial default-cache install failed locally; the explicit writable-cache install succeeded without dependency-file changes.
