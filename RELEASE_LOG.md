# Technical release log — 2026-10-05

All times UTC. This log contains public technical project information only.

- **20:35–20:38 — Baseline inspected.** Fetched current remotes; created isolated branches/worktrees. Previous Joinermill release 4123538bf18c4eb322c20247e23656625df40169 and backend main c15db296c5a7dbf2cb5df40ba8fbe9443e578570. Held PR15/PR32 unchanged. Captured existing Worker code/version and a settings fingerprint; production source drift required preserving its module.
- **20:39–20:43 — Implemented.** Editable six-field brief, local review/export, separate examples and optional explicitly requested stateless backend check. Preserved 13 specialist roles and all existing Worker routes. Added deployment helper preserving live settings and bindings. No new infrastructure or persistent user-content writes.
- **20:44–20:51 — Tested and repaired.** Backend 70/70 and frontend 2/2 unit tests pass. Thirteen browser groups cover actual export, network/mismatched-response failures, repeated clicks, cancellation, blocked download, safe literal rendering, navigation/reset, inaccessible browser storage, mobile and keyboard interaction. Broader axe checks found pre-existing low-contrast decorative text; corrected it. Final six-view desktop/mobile axe checks show zero violations. Desktop/mobile screenshots captured. Shared schema modules match.
- **20:47–20:51 — Independent review.** Fresh-context review checked security, privacy, truth labels, source preservation and release diff. Requested tighter deployment concurrency recheck and post-upload code-hash verification; implemented. Five offline synthetic deployment-helper checks pass, including rollback and refusal on concurrency/hash mismatch. Final review recommendation is recorded before publication.
- **Publication: pending.** No live success claim is made until the backend and Pages deployment are independently verified. Final commits/deployments and remaining limitations will be added here after verification.

See START_HERE.md and RELEASE.md (frontend) or worker/RELEASE.md (backend) for exact test and rollback procedures. No held PR or Pulse deployment is part of this update.
