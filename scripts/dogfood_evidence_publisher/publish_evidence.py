#!/usr/bin/env python3
"""Dogfood evidence publisher — Atlas B1 contract.

Default: flag OFF → validate + write local staging outbox only.
Live push to Helm / joinermill requires HELM_EVIDENCE_PUBLISH=1 and
--i-accept-gage-enable (Gage packet already filed). Never invent busy.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
STAGING = ROOT / "staging" / "threads.json"
CT = ZoneInfo("America/Chicago")

ALLOWED_STAGES = {"answered", "done"}
FORBIDDEN_SUBSTRINGS = (
    "hedstrom",
    "charles heating",
    "listinglift $39",
    "gumroad.com/l/listinglift",
)


def ct_now() -> str:
    return datetime.now(CT).strftime("%Y-%m-%dT%H:%M-05:00")


def die(msg: str, code: int = 2) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)
    raise SystemExit(code)


def clean(s) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip()


def looks_secret(s: str) -> bool:
    low = s.lower()
    if "bearer " in low or "api_key" in low or "sk-" in low:
        return True
    if re.search(r"(ghp_|gho_|github_pat_)[A-Za-z0-9_]+", s):
        return True
    return False


def validate_url(u: str) -> str:
    u = clean(u)
    if not u or len(u) > 800:
        die(f"bad evidence url length: {u[:80]!r}")
    # https OR documented absolute box/repo path
    if u.startswith("https://"):
        if re.search(r"[\s<>\"']", u):
            die(f"unsafe https url: {u}")
        return u
    if u.startswith("/home/box/") or u.startswith("/workspace/"):
        return u
    if u.startswith("architecture/") or u.startswith("audit/") or u.startswith("operating/"):
        # relative under /home/box/business/
        return u
    die(f"evidence url must be https:// or documented disk path: {u}")


def validate_packet(pkt: dict) -> dict:
    if not isinstance(pkt, dict):
        die("packet must be object")

    status = clean(pkt.get("status")).upper()
    stage = clean(pkt.get("stage")).lower()
    if status not in ("ANSWERED", "DONE"):
        die("status must be ANSWERED or DONE (terminal only)")
    if stage not in ALLOWED_STAGES:
        die("stage must be answered|done")

    kind = clean(pkt.get("kind")).lower() or "owner"
    if kind not in ("owner", "objective"):
        die("kind must be owner|objective (dogfood owner scope)")
    if kind == "selftest":
        die("selftest must not publish to product outbox")

    objective_id = clean(pkt.get("objective_id") or pkt.get("intent_id"))
    intent_id = clean(pkt.get("intent_id") or objective_id)
    if not objective_id or not intent_id:
        die("objective_id / intent_id required")

    question = clean(pkt.get("question"))
    answer_text = clean(pkt.get("answer_text"))
    if not question or not answer_text:
        die("question and answer_text required")
    if looks_secret(question) or looks_secret(answer_text):
        die("secrets detected in question/answer")

    evidence = pkt.get("evidence")
    if not isinstance(evidence, list) or len(evidence) < 1:
        die("evidence[] required with ≥1 re-fetchable pointer")

    out_ev = []
    for item in evidence:
        if not isinstance(item, dict):
            die("evidence items must be objects {title,url,type,opened_ct?}")
        title = clean(item.get("title") or item.get("label"))
        url = validate_url(item.get("url") or item.get("href") or "")
        typ = clean(item.get("type")) or "file"
        opened = clean(item.get("opened_ct")) or ct_now()
        if not title:
            die("evidence.title required")
        blob = f"{title} {url}".lower()
        for bad in FORBIDDEN_SUBSTRINGS:
            if bad in blob or bad in answer_text.lower() or bad in question.lower():
                die(f"forbidden content for dogfood publish: {bad}")
        if looks_secret(url) or looks_secret(title):
            die("secrets in evidence")
        out_ev.append(
            {
                "title": title[:200],
                "url": url,
                "type": typ[:64],
                "opened_ct": opened,
            }
        )

    # Presence always idle on terminal publish
    record = {
        "intent_id": intent_id[:80],
        "objective_id": objective_id[:80],
        "status": "ANSWERED" if status == "ANSWERED" else "DONE",
        "stage": stage,
        "question": question[:800],
        "answer_text": answer_text[:2000],
        "answer_html": clean(pkt.get("answer_html"))[:4000] if pkt.get("answer_html") else "",
        "answered_ct": clean(pkt.get("answered_ct")) or ct_now(),
        "kind": "owner" if kind == "owner" else "objective",
        "evidence": out_ev,
    }
    # Drop empty html
    if not record["answer_html"]:
        del record["answer_html"]
    return record


def idle_presence() -> list:
    return [
        {"id": "eva", "status": "idle"},
        {"id": "delivery", "status": "idle"},
        {"id": "auditor", "status": "idle"},
        {"id": "client-success", "status": "idle"},
        {"id": "growth", "status": "idle"},
    ]


def load_staging() -> dict:
    if STAGING.exists():
        return json.loads(STAGING.read_text())
    return {
        "version": "0.7-staging",
        "updated": "",
        "note": (
            "STAGING dogfood outbox — not live Pages. "
            "Empty until a terminal packet is written here with flag OFF. "
            "Presence idle. No secrets. No stranger write."
        ),
        "presence": idle_presence(),
        "approves": [],
        "threads": [],
    }


def merge_thread(outbox: dict, record: dict) -> dict:
    threads = [t for t in (outbox.get("threads") or []) if isinstance(t, dict)]
    threads = [
        t
        for t in threads
        if t.get("intent_id") != record["intent_id"]
        and t.get("objective_id") != record.get("objective_id")
    ]
    threads.insert(0, record)
    outbox["threads"] = threads
    outbox["presence"] = idle_presence()
    outbox["approves"] = outbox.get("approves") if isinstance(outbox.get("approves"), list) else []
    outbox["updated"] = ct_now()
    outbox["updated_ct"] = ct_now()
    outbox["note"] = (
        "STAGING dogfood outbox — not live Pages. "
        "Terminal dogfood-owner evidence only. Presence idle. No secrets."
    )
    return outbox


def main() -> None:
    ap = argparse.ArgumentParser(description="Dogfood evidence publisher (flag OFF by default)")
    ap.add_argument("--packet", required=True, help="Path to terminal evidence packet JSON")
    ap.add_argument("--dry-run", action="store_true", help="Validate only; write dry_run receipt")
    ap.add_argument(
        "--i-accept-gage-enable",
        action="store_true",
        help="Required together with HELM_EVIDENCE_PUBLISH=1 for any live push (not implemented this cut)",
    )
    args = ap.parse_args()

    flag_on = os.environ.get("HELM_EVIDENCE_PUBLISH", "0").strip() in ("1", "true", "TRUE", "yes", "ON")
    packet_path = Path(args.packet)
    if not packet_path.is_file():
        die(f"packet not found: {packet_path}")

    pkt = json.loads(packet_path.read_text())
    record = validate_packet(pkt)

    # Live path deliberately not implemented while flag policy is OFF-first.
    if flag_on:
        if not args.i_accept_gage_enable:
            die("HELM_EVIDENCE_PUBLISH=1 requires --i-accept-gage-enable after Gage packet")
        die(
            "live Helm/joinermill dual-write not enabled in this cut — "
            "flag stays OFF; use staging only until Gage enable + Drew wire"
        )

    receipt = {
        "ok": True,
        "flag": "OFF",
        "mode": "dry-run" if args.dry_run else "staging",
        "validated_ct": ct_now(),
        "record": record,
        "live_push": False,
        "contract": "ATLAS_DOGFOOD_EVIDENCE_PUBLISH_CONTRACT_20261002.md",
    }

    dry_dir = ROOT / "dry_run"
    dry_dir.mkdir(parents=True, exist_ok=True)
    receipt_path = dry_dir / f"{record['objective_id']}_{'dry' if args.dry_run else 'staging'}.json"

    if args.dry_run:
        receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
        print(f"PASS dry-run · receipt {receipt_path}")
        print(json.dumps({"objective_id": record["objective_id"], "evidence_n": len(record["evidence"])}))
        return

    STAGING.parent.mkdir(parents=True, exist_ok=True)
    outbox = merge_thread(load_staging(), record)
    STAGING.write_text(json.dumps(outbox, indent=2) + "\n")
    receipt["staging_path"] = str(STAGING)
    receipt["threads_n"] = len(outbox["threads"])
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
    print(f"PASS staging · {STAGING}")
    print(
        json.dumps(
            {
                "objective_id": record["objective_id"],
                "evidence_n": len(record["evidence"]),
                "presence": "idle",
                "live_push": False,
            }
        )
    )


if __name__ == "__main__":
    main()
