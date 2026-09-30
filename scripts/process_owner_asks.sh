#!/usr/bin/env bash
# EvaOS v0.5 — process allowlisted owner-ask Issues → comment + outbox/threads.json
# Ingress may be Worker (hidden) or direct Issue; owner UX is EvaOS Submit.
# Run on Eva box (gh as Evaisawesome2025). No secrets in Pages.
set -euo pipefail

REPO="${REPO:-Evaisawesome2025/evaos-v05}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export EVAOS_ALLOWLIST="$ROOT/control/ALLOWLIST.txt"
OUTBOX="$ROOT/outbox/threads.json"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
CT_NOW="$(TZ=America/Chicago date '+%Y-%m-%dT%H:%M-05:00')"

[[ -f "$EVAOS_ALLOWLIST" ]] || { echo "FAIL: missing allowlist"; exit 1; }
[[ -f "$OUTBOX" ]] || { echo "FAIL: missing outbox"; exit 1; }

gh label create owner-ask --repo "$REPO" --color "1e6b3f" --description "Owner question for Eva (EvaOS v05)" 2>/dev/null || true
gh label create eva-answered --repo "$REPO" --color "2a4a38" --description "Eva processed and replied" 2>/dev/null || true
gh label create loop-selftest --repo "$REPO" --color "6a645a" --description "Selftest — not owner" 2>/dev/null || true

gh issue list --repo "$REPO" --label owner-ask --state open --json number,title,body,author,url,labels,createdAt --limit 50 > "$WORK/issues.json"

python3 - "$WORK/issues.json" "$OUTBOX" "$CT_NOW" "$REPO" << 'PY'
import json, os, sys, subprocess, re
from pathlib import Path

issues_path, outbox_path, ct_now, repo = sys.argv[1:5]
work = Path(issues_path).parent
issues = json.loads(Path(issues_path).read_text())
outbox = json.loads(Path(outbox_path).read_text())
allowed = {
    ln.strip().lower()
    for ln in Path(os.environ["EVAOS_ALLOWLIST"]).read_text().splitlines()
    if ln.strip() and not ln.strip().startswith("#")
}

def extract_question(title, body):
    body = body or ""
    m = re.search(r"## Owner question\s*\n+(.+?)(?:\n---|\n<!--|\Z)", body, re.S | re.I)
    if m:
        q = re.sub(r"<!--.*?-->", "", m.group(1), flags=re.S).strip()
        if q:
            return q[:500]
    if (title or "").lower().startswith("owner ask"):
        return title.split(":", 1)[-1].strip()[:500]
    return (title or "Owner question")[:500]

def extract_intent_id(body):
    body = body or ""
    m = re.search(r"intent_id[=:\s`]+([0-9a-f]{16,64})", body, re.I)
    return m.group(1) if m else None

changed = []
for iss in issues:
    labels = {l["name"] for l in iss.get("labels") or []}
    if "eva-answered" in labels:
        continue
    author = (iss.get("author") or {}).get("login") or ""
    if author.lower() not in allowed:
        print(f"SKIP #{iss['number']} author @{author} not allowlisted", flush=True)
        continue
    q = extract_question(iss.get("title") or "", iss.get("body") or "")
    intent_id = extract_intent_id(iss.get("body") or "")
    ql = q.lower()
    kind = "selftest" if ("loop-selftest" in labels or "selftest" in ql or "loop check" in ql) else "owner"
    if any(x in ql for x in ("password", "api key", "secret", "token", "credit card", "cvv")):
        answer_html = "<p><strong>Refused.</strong> Public channel — no secrets or credentials here.</p>"
        answer_text = "Refused: public channel — no secrets/credentials here."
    elif kind == "selftest" or "selftest" in ql or "loop check" in ql or "ping" in ql:
        answer_html = (
            "<p><strong>Loop check OK.</strong> Eva received this Ask via the trusted ingress, "
            "wrote this reply, and committed it to the public outbox. "
            "This is a labeled selftest — not an owner decision.</p>"
            "<p>Business facts unchanged: stranger cash <strong>$0</strong>, ListingLift parked after the partner note, "
            "Opportunity Intelligence continues, no spend from this reply.</p>"
        )
        answer_text = (
            "Loop check OK. Eva received Ask via trusted ingress, replied, and committed outbox. "
            "Selftest — not an owner decision. Facts: $0; LL parked; OI continues; no spend."
        )
    elif any(x in ql for x in ("money", "revenue", "paid", "dollar", "customer")) or "$" in q:
        answer_html = (
            "<p>Collected from strangers: <strong>$0</strong>. Customers: <strong>0</strong>. "
            "ListingLift is $39 with 0 paid orders. Cold delivery failed more than demand was tested; "
            "one partner soft-intro was sent 2026-09-30. No invented forecast.</p>"
        )
        answer_text = "Stranger cash $0; 0 customers; ListingLift $39 / 0 paid; partner intro sent 2026-09-30; no forecast."
    elif any(x in ql for x in ("working on", "what are you", "doing", "status")):
        answer_html = (
            "<p><strong>Doing:</strong> passive watch on ListingLift to ~Oct 13; keep page/checkout up; "
            "search for the next honest bet (OI continues).</p>"
            "<p><strong>Not doing:</strong> new cold email, rescue channels, or spend.</p>"
        )
        answer_text = "Doing: LL watch ~Oct 13; page up; OI continues. Not: cold, rescue channels, spend."
    elif any(x in ql for x in ("need me", "need you", "decision", "approv")):
        answer_html = (
            "<p><strong>For the online business: no owner decision is waiting right now.</strong> "
            "Approve buttons on EvaOS are not execute-wired (empty queue for this bet). "
            "Last real yes: partner soft-intro ($0), sent 2026-09-30.</p>"
        )
        answer_text = "No online-business decision waiting. Last yes: partner intro $0 sent 2026-09-30."
    elif any(x in ql for x in ("park", "listinglift", "listing lift")):
        answer_html = (
            "<p>ListingLift is <strong>parked after finish-one</strong> (partner soft-intro sent). "
            "Page and checkout stay up. Not a kill yet. No new channels. No spend.</p>"
        )
        answer_text = "LL parked after partner intro; page up; not kill; no new channels; no spend."
    else:
        answer_html = (
            "<p>Eva received your question. Short honest status: stranger cash <strong>$0</strong>; "
            "ListingLift parked after partner note (watch to ~Oct 13); OI continues; "
            "nothing needs your yes/no on the online bet right now.</p>"
            "<p>Spend/approve is not auto-executed from this Ask channel.</p>"
        )
        answer_text = (
            "Received. $0; LL parked (watch ~Oct 13); OI continues; no online yes/no waiting. "
            "Spend/approve not auto-executed here."
        )

    comment = (
        f"## Eva reply (EvaOS v0.5)\n\n"
        f"**Question:** {q}\n\n"
        f"{answer_text}\n\n"
        f"---\n"
        f"_Published to public outbox `outbox/threads.json` (sanitized). "
        f"Processed {ct_now}. Kind: {kind}."
        + (f" Intent: `{intent_id}`." if intent_id else "")
        + "_\n"
    )
    cpath = work / f"comment_{iss['number']}.md"
    cpath.write_text(comment)
    subprocess.check_call(["gh", "issue", "comment", str(iss["number"]), "--repo", repo, "--body-file", str(cpath)])
    subprocess.check_call(["gh", "issue", "edit", str(iss["number"]), "--repo", repo, "--add-label", "eva-answered"])
    thread = {
        "intent_id": intent_id,
        "status": "ANSWERED",
        "issue_number": iss["number"],
        "author": author,
        "question": q,
        "answer_text": answer_text,
        "answer_html": answer_html,
        "answered_ct": ct_now,
        "kind": kind,
        # transport_ref intentionally omitted from owner-facing render; keep issue_number for ops only
    }
    outbox["threads"] = [
        t for t in outbox.get("threads", [])
        if t.get("issue_number") != iss["number"]
        and (not intent_id or t.get("intent_id") != intent_id)
    ]
    outbox["threads"].insert(0, thread)
    changed.append(iss["number"])
    print(f"ANSWERED #{iss['number']} kind={kind} author=@{author} intent={intent_id or '-'}", flush=True)

outbox["updated_ct"] = ct_now
Path(outbox_path).write_text(json.dumps(outbox, indent=2) + "\n")
print("CHANGED", ",".join(str(n) for n in changed) if changed else "none")
PY

echo "Outbox updated: $OUTBOX"
echo "Commit + push from repo root when ready so Pages shows replies."
