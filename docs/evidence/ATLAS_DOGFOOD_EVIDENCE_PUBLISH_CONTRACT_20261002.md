# Atlas — Dogfood evidence publish contract (B1 / CC-v0.7.1)

**When:** 2026-10-02 ~07:10 CT · **Path:** `EVIDENCE-LOOP-CLOSE` · **$0** · flag **OFF** until Gage  
**For:** Drew implement · Eva orchestrate · Gage enable-audit  
**Not:** clean ship · stranger write · pay · Clerk · waitlist · LL · DEMO-as-PoW  
**Anchors:** `EVAOS_REORIENT_POST_LL_20261002.md` · `COMMAND_CENTER_PROPOSAL_20261001.md` · `UZ_OBJECTIVE_LOOP_VISIBILITY_20261001.md` · `EXP_OUTBOX_DUALWRITE_SELFTEST_20260930.md` · Gage `AUDIT-20261001-2217`

---

## Contract (one sentence)

**Only when a dogfood-owner objective has real org work that reaches ANSWERED (Ask) or DONE (uz inbox), write a sanitized, re-fetchable evidence record into the Helm / Joinermill owner outbox — idle when idle; never invent busy.**

---

## Trigger (publish IF AND ONLY IF)

All of:

1. **Owner scope:** dogfood owner thread only (`kind: owner` or uz objective for Glen User Zero). Selftests stay ops-only / UI-hidden.  
2. **Terminal truth:** Ask path `status: ANSWERED` **or** uz inbox item `DONE` after real execute (not RECEIVED / IN_PROGRESS alone).  
3. **Work PoW:** ≥1 re-fetchable evidence pointer produced by the org for *this* `intent_id` / `objective_id` (file URL, GH issue/PR, audit log path, Pages artifact).  
4. **Flag:** publisher feature flag **OFF** by default; **ON** only after Gage enable packet.

**Do not publish on:** Worker accept alone · canned Answer · guest DEMO/REPLAY · empty “we’re on it” · LL / Charles / services funnel · consequential send/spend without prior Approve.

---

## Write targets

| Target | Role |
|--------|------|
| Helm Objective Bay outbox (v0.7 `outbox/threads.json` or successor) | Primary dogfood UI evidence list |
| Joinermill `app/outbox/threads.json` | Existing dual-write product poll path (`OUTBOX_URL`) |

Same sanitized record may dual-write both. **No** stranger / multi-tenant write. **No** secrets, access codes, last names, bearer tokens.

---

## Record shape (extend, don’t dump ops)

Keep existing joinermill fields: `intent_id`, `status`, `question`, `answer_text`, `answer_html`, `answered_ct`, `kind`.

**MUST add for evidence-loop:**

| Field | Rule |
|-------|------|
| `objective_id` | Durable id (may equal `intent_id` if one-shot) |
| `evidence` | Array of `{ title, url, type, opened_ct }` — each `url` HTTP(S) or documented repo path Gage can re-fetch |
| `stage` | One of: `answered` \| `done` (not fake intermediate theater in outbox) |

**Presence:** leave idle **unless** a real in-flight job is recorded for this owner; never set `working` to decorate. When publishing a terminal ANSWERED/DONE, presence returns **idle**.

**Omit from product outbox:** author, issue_number, MCP/tool names, specialist PM chatter, raw ledgers.

---

## MUST vs LATER

### MUST (Drew · this cut · flag OFF)

1. Publisher path: ANSWERED/DONE + evidence[] → sanitized dual-write Helm +/or joinermill outbox.  
2. Skip OBJECTIVE canned Answers (already UZ rule) — publish only post-execute terminal.  
3. Default flag **OFF**; document how Eva/Drew flip after Gage PASS.  
4. Empty / idle bay when no terminal evidence — no placeholder cards.  
5. UI: Objective Bay lists evidence links from outbox for dogfood owner only.  
6. Non-claims: not UZ-cleared until Glen run + Gage re-audit.  
7. LL copy absent from new answers; no buy CTAs in evidence.

### LATER

- Stranger / multi-owner outbox · Clerk · waitlist · checkout  
- Auto-presence “working” feed beyond single honest bit  
- Guest evidence · DEMO promotion to owner PoW  
- Deep Artifacts library · multi-objective portfolio  
- Public `#trust` auto-post of every card (only sanitized, owner-gated later)

---

## Pass / fail (for Gage enable)

| | |
|--|--|
| **PASS** | Flag-off build exists; one controlled dogfood thread shows dated `evidence[].url` live; re-fetch works; presence idle when idle; guest DEMO unchanged / not counted |
| **FAIL** | Publish without evidence URLs · busy theater · DEMO/selftest as owner proof · stranger write · secrets in JSON · “evidence live” claim while flag off / empty bay |

---

## Handoff

- **Drew:** implement behind flag per this contract.  
- **Eva:** one real UZ objective after Glen supplies text; then request Gage enable.  
- **Gage:** new packet before flag ON / any UZ-threshold claim.  
- **Atlas:** idle unless mid-build contract challenge.

*— End ATLAS_DOGFOOD_EVIDENCE_PUBLISH_CONTRACT_20261002 —*
