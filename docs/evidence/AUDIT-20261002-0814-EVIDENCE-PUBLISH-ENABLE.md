# AUDIT — Dogfood evidence publisher ENABLE packet

**ID:** AUDIT-20261002-0814-EVIDENCE-PUBLISH-ENABLE  
**Timestamp:** 2026-10-02 ~08:14 CT  
**Auditor:** Gage · AUDITOR  
**Subject:** Authorize ONE manual live dual-write via `publish_evidence.py` (dogfood-owner scope)  
**Contract:** `architecture/evaos/operating/cycles/ATLAS_DOGFOOD_EVIDENCE_PUBLISH_CONTRACT_20261002.md`  
**Code tip:** `Evaisawesome2025/evaos-v05` **`df32246`** (PR #20 merge; PR #19 `026413e` flag-OFF build)  
**Prior:** `AUDIT-20261001-2217` WARN3 (outbox publisher deferred) · `AUDIT-20261002-0706` LL CLOSED  
**Verdict:** **PASS WITH WARNING — ENABLE AUTHORIZED (conditional)**  
**Clean-ship:** **DENIED**  
**User Zero / objective→org-works threshold:** **NOT CLEARED** (this packet does not clear it)  
**Bay “evidence live” claim:** **DENIED** until post-publish re-audit with re-fetchable https PoW

## Bottom line
Dual gates are real: default `HELM_EVIDENCE_PUBLISH` **OFF**; `run_from_asks.sh` / `process_owner_asks.sh` **never** pass `--i-accept-gage-enable`; flag=1 without switch **hard-refuses**; live targets allowlisted to Helm `v07/outbox/threads.json` + joinermill `app/outbox/threads.json` only; stranger repo refused; presence idle on terminal publish; 24 unit tests OK on tip. **Eva/Drew may run ONE manual shell publish** under the conditions below. Fixture `UZ-FC-20261002-001.json` as checked in is **NOT approved for live write as-is** (mostly `/home/box/` paths; Helm UI only renders `https://`).

## What is authorized

| Allowed (once) | Forbidden |
|----------------|-----------|
| In one interactive shell only: `HELM_EVIDENCE_PUBLISH=1` + `python3 …/publish_evidence.py --packet <PATH> --i-accept-gage-enable` | Commit / CI / `process_owner_asks` export of the flag |
| Packet: `kind` owner\|objective · status ANSWERED\|DONE · stage answered\|done · ≥1 evidence item | Continuous ON · ask-hook live push · stranger / other repos |
| **≥1 evidence `url` that is `https://` and re-fetchable from the public network**, and is **not** solely the Helm bay / joinermill home self-link | Live write of box-only evidence set (current fixture) without remapping |
| After write: leave flag unset; ping Gage with SHAs + live outbox curls | Claim clean ship · UZ cleared · “evidence live” before re-audit |
| | LL / Charles / DEMO-as-PoW · secrets · Hedstrom |

## Conditions (HARD — violate ⇒ treat as unauthorized write)

1. **One shell run** — not standing env; not committed; not CI.  
2. **Both gates** — env `1` + `--i-accept-gage-enable`.  
3. **Public PoW:** at least one `https://` evidence URL Gage can `curl` (raw.githubusercontent, Pages artifact, public audit mirror, GH issue/PR). Box paths may remain for ops, but **must not be the only** evidence; Helm `bay.js` drops non-https.  
4. **Remap before live:** do **not** push `fixtures/UZ-FC-20261002-001.json` unchanged until ≥1 meaningful https PoW is added (or box docs mirrored to a public URL).  
5. **Post-publish:** Eva reports both outbox URLs + commit SHAs; Gage re-audits before any “bay shows org evidence” / UZ-threshold language.  
6. **Owner locks:** EvaOS primary; ListingLift CLOSED; no cleaning-vendor contact.

## Bug / safety matrix (enable scope)

| Check | Result | Evidence |
|-------|--------|----------|
| Flag default OFF | **PASS** | `os.environ.get("HELM_EVIDENCE_PUBLISH", "0")`; FLAG.md; no `.github` export; process_owner_asks leaves unset |
| Dual gate | **PASS** | flag ON without switch → `FAIL: … requires --i-accept-gage-enable` (live run) |
| Ask hook cannot live-push | **PASS** | `run_from_asks.sh` never passes switch; ON → `action=refuse-live` |
| Targets allowlist | **PASS** | only `Evaisawesome2025/evaos-v06` `v07/outbox/threads.json` + `Evaisawesome2025/joinermill` `app/outbox/threads.json` |
| Stranger repo refuse | **PASS** | tests + `_refuse_stranger` |
| Terminal + evidence required | **PASS** | validate_packet |
| Idle presence on publish | **PASS** | `idle_presence()` splice |
| LL / Charles / Hedstrom filter | **PASS** | FORBIDDEN_SUBSTRINGS |
| Live bay currently empty | **PASS** | Helm outbox threads `[]` idle; joinermill has prior Ask threads (separate path) |
| Fixture public-render honesty | **WARN / BLOCK for this fixture** | 5/6 URLs are `/home/box/…`; only https is Helm self; UI strips non-https |

## Independent PoW (Gage · ~08:13 CT)

| Check | Result |
|-------|--------|
| PR #19 merged | `026413e` · Add flag-off dogfood evidence publisher |
| PR #20 merged | `df32246` · Gate live dual-write behind flag + Gage switch |
| `test_flag_off.py` | **24 OK** |
| Flag OFF publish fixture | staging write · `live_push: false` |
| Flag ON no switch | hard refuse |
| Helm live outbox | empty threads · idle presence |
| Helm evidence href rule | `bay.js` `safeHref` → https only |

## Warnings

1. **Public vs box PoW mismatch** — publisher accepts `/home/box/` paths; Helm UI does not show them. Live packets need https PoW or evidence looks empty/theater.  
2. **Joinermill outbox already has Ask dual-write history** — distinct from this Helm evidence path; do not conflate as UZ proof.  
3. Enable is **narrow** — does not approve waitlist arm, founding-seat sell, or continuous publish.

## Non-claims held
Not clean ship · not UZ-cleared · not stranger write · not always-on · flag not standing ON · bay not “evidence live” until re-audit · LL CLOSED · no DEMO-as-PoW.

## Final status
**PASS WITH WARNING — ENABLE AUTHORIZED (conditional)** for **one** manual dogfood-owner live publish under HARD conditions above. Fixture as-is = staging only until https remap.

*— End AUDIT-20261002-0814-EVIDENCE-PUBLISH-ENABLE —*
