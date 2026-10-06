# Reusable manual work instructions

This increment adds one local reusable definition, separate from active work. It is deterministic software for owner-written directions, not an agent run, assignment, schedule, enforced approval gate or proof of completion. There are no model calls, connected recipients, cloud accounts, new services or backend runtime changes.

## Use the workflow

1. Open **Work instructions**. Write a definition or explicitly **Copy active brief into instructions**. Copying replaces the editor's six fields and clears its title/owner/blocker/handoff fields; it never copies the active result or review. The confirmation can be cancelled without changing either editor or active work.
2. Add a title, accountable owner label, blocker directions and handoff recipient/next step. Complete the existing six brief fields. These fields describe human responsibility and conditions; no identity is verified and no recipient is contacted. Write “None identified” when there is no known blocker; software does not establish readiness.
3. Explicitly save one instructions copy in this browser or download an instructions JSON file. Loading and importing replace only the instructions editor after confirmation. Nothing starts or saves automatically. Clear editor affects only its unsaved fields; Remove saved instructions affects only its separate storage key.
4. Choose **Start new work from instructions**. Review its confirmation and preserve current active work with a save or backup first. Confirming replaces the active tab with only the six brief fields and copied directions. Result text, provenance, feedback, owner decision, captured target, instance timestamps, action notes, missing-input notes and prior format-check state are empty. Reusing the same definition again produces another clean instance.
5. Use the existing active-work flow to edit the brief, record an actual result and make an owner decision. Active work and the reusable definition are independent. Changing either does not silently change the other. Copied owner/blocker/handoff labels are contextual; owner acceptance covers the captured six-field brief, not those labels.

The 13-role directory and canned examples remain separate and unchanged. No simulated activity or generated evidence is introduced.

## Storage and file boundaries

- The reusable definition has exact keys `kind`, `version`, `brief`, `directions`; kind is `joinermill.work-instructions`, version is 1. Directions require exactly `title`, `owner`, `blocker`, `handoff`, with maximum lengths 120/160/1000/1000 and at least three characters after trimming. Existing brief limits and normalization remain. Files are capped at 64 KiB before parsing and after normalization; unknown keys/versions/types/control characters and whole-work backups are rejected.
- One definition uses `joinermill.instructions.v1`. Only explicit Save writes it, replacing the previous saved definition. It never writes or deletes the active-work key. Reading on startup advertises availability without loading the editor. A blocked/corrupt/quota-failed store leaves editing and local file import/export usable. Shared-browser users may access saved copies; there is no sync or account isolation.
- Active snapshots retain `joinermill.workdesk.v1` and now write schema version 3: exact keys `version`, `savedAt`, `draft`, `plan`, `result`, `directions`. Directions are null for ordinary work or a strictly validated copied direction object. Version 1 reads add an empty result and null directions; version 2 reads preserve the actual result and add null directions. Reads do not rewrite old data. Older application versions reject v3 safely. Existing 128 KiB active-backup limit remains.
- Instructions imports and active-work imports intentionally reject each other's format. A full backup restores actual result/review state; a reusable definition contains no such fields. No import saves, starts work or transmits automatically. JSON timestamps and owner decisions in active backups remain unauthenticated claims.
- Readable work-plan export includes copied directions and their limited meaning. Brief-only export and the optional backend check still include exactly six current brief fields. Directions, definition metadata, planning notes, actual result, source and owner review are excluded from that request. Local files/links are never fetched or uploaded.

## Reliability and review

All new confirmations use the reviewed exclusive confirmation mechanism. Opening a different confirmation cancels pending file reads; leaving the instructions editor or editing it cancels its pending import. Superseded reads/errors cannot resurrect a prompt. Confirming a start requires the same editor revision that was shown. Stale/closed/repeated confirmation clicks cannot act on later work. Replacing active work invalidates prior acceptance and pending backend checks. Focus restoration cannot override a newer selected field.

Mobile navigation now wraps into a grid to fit the fifth navigation item without horizontal overflow. Fields, dialogs and copied directions are checked at 1440/390/320px, with keyboard focus and axe scans. Automated Chromium checks do not prove all browser/assistive-technology support.

Tests use fictional inputs only. The portable handoff includes full and focused regression logs, independent review, before-fix findings, screenshots, exact remote hashes and recovery patches. See RELEASE_STATUS.json for final counts/status. Final review and full regression must complete before feature-branch publication.

## Scope and release gate

This task stops at the two reviewed reusable-instructions branches. No main merge, workflow dispatch, public deployment, new permission, credential, spend, outreach, customer-data access or Library retry. Pulse is part of EVAOS and owned by a separate task; its paths, branches and interfaces are untouched here. Backend runtime, shared six-field model, authentication, bindings, CORS and preserving deployment helper are unchanged.

READINESS.md records the inherited public-host/settings-editor blocker and the missing live/first-real-user verification. Do not treat a branch push or synthetic tests as a live release. Before any later deployment, refresh current remote/Worker baselines and use the existing settings-preserving process; never plain wrangler defaults or older backend main as rollback. No live rollback is needed for this branch-only increment. Revert only this increment's commit after checking concurrent work if a branch rollback is needed.
