#!/usr/bin/env python3
"""Pick dogfood packets the ask hook may hand to publish_evidence.py.

A packet is eligible only when all of these hold:

- status is terminal: ANSWERED or DONE
- kind is dogfood owner or objective (not selftest, guest, or demo)
- evidence[] has at least one {title,url}
- question and answer_text are present
- it is not marked canned

Ops fields (author, issue number, issue URL) are not copied.
publish_evidence.validate_packet is the validator; failures are skipped.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import publish_evidence


def load_records(path: str) -> list:
    if not path:
        return []
    file = Path(path)
    if not file.is_file():
        return []
    data = json.loads(file.read_text())
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    if isinstance(data, dict):
        for key in ("items", "threads"):
            if isinstance(data.get(key), list):
                return [x for x in data[key] if isinstance(x, dict)]
    return []


def _kind(item: dict) -> str:
    question = publish_evidence.clean(item.get("question") or item.get("raw_question") or item.get("objective"))
    kind = publish_evidence.clean(item.get("kind")).lower()
    is_objective = question.lstrip().upper().startswith("OBJECTIVE:") or kind == "objective"
    if kind == "selftest":
        return "selftest"
    if not is_objective and ("selftest" in question.lower() or "loop check" in question.lower()):
        return "selftest"
    if kind in ("guest", "demo", "replay", "stranger"):
        return kind
    if is_objective:
        return "objective"
    if kind == "owner" or not kind:
        return "owner"
    return kind or "owner"


def _canned(item: dict) -> bool:
    if item.get("canned") is True:
        return True
    source = publish_evidence.clean(item.get("answer_source")).lower()
    return source == "canned"


def candidate(item: dict) -> dict | None:
    if not isinstance(item, dict) or _canned(item):
        return None
    status = publish_evidence.clean(item.get("status")).upper()
    if status not in ("ANSWERED", "DONE"):
        return None
    kind = _kind(item)
    if kind not in ("owner", "objective"):
        return None
    question = publish_evidence.clean(item.get("question") or item.get("raw_question") or item.get("objective"))
    answer_text = publish_evidence.clean(item.get("answer_text"))
    if not question or not answer_text:
        return None
    evidence = item.get("evidence")
    if not isinstance(evidence, list) or not evidence:
        return None
    out_ev = []
    for entry in evidence:
        if not isinstance(entry, dict):
            return None
        title = publish_evidence.clean(entry.get("title") or entry.get("label"))
        url = publish_evidence.clean(entry.get("url") or entry.get("href"))
        if not title or not url:
            return None
        ev = {
            "title": title,
            "url": url,
            "type": publish_evidence.clean(entry.get("type")) or "file",
        }
        opened = publish_evidence.clean(entry.get("opened_ct"))
        if opened:
            ev["opened_ct"] = opened
        out_ev.append(ev)
    objective_id = publish_evidence.clean(item.get("objective_id") or item.get("intent_id"))
    intent_id = publish_evidence.clean(item.get("intent_id") or objective_id)
    if not objective_id or not intent_id:
        return None
    packet = {
        "objective_id": objective_id,
        "intent_id": intent_id,
        "status": status,
        "stage": "done" if status == "DONE" else "answered",
        "kind": kind,
        "question": question,
        "answer_text": answer_text,
        "evidence": out_ev,
    }
    if item.get("answer_html"):
        packet["answer_html"] = item.get("answer_html")
    if item.get("answered_ct"):
        packet["answered_ct"] = item.get("answered_ct")
    try:
        publish_evidence.validate_packet(packet)
    except SystemExit:
        return None
    return packet


def collect(*paths: str) -> list:
    found = []
    seen = set()
    for path in paths:
        for item in load_records(path):
            packet = candidate(item)
            if not packet:
                continue
            key = packet["objective_id"]
            alt = packet["intent_id"]
            if key in seen or alt in seen:
                continue
            seen.add(key)
            seen.add(alt)
            found.append(packet)
    return found


def main() -> None:
    parser = argparse.ArgumentParser(description="Select terminal dogfood evidence packets")
    parser.add_argument("--uz-inbox", default="")
    parser.add_argument("--ops-outbox", default="")
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args()
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for packet in collect(args.uz_inbox, args.ops_outbox):
        name = re.sub(r"[^A-Za-z0-9._-]+", "_", packet["objective_id"])[:80] or "packet"
        path = out / f"{name}.json"
        path.write_text(json.dumps(packet, indent=2) + "\n")
        print(path)


if __name__ == "__main__":
    main()
