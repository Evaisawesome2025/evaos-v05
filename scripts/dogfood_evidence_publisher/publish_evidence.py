#!/usr/bin/env python3
"""Dogfood evidence publisher — Atlas B1 contract.

Default: flag OFF → validate + write local staging outbox only.
Live push to Helm / joinermill requires HELM_EVIDENCE_PUBLISH=1 and
--i-accept-gage-enable (Gage packet already filed). Never invent busy.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
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
# Same contents-API targets as the ask dual-write (joinermill) and Helm v07 Pages.
# Env may select these paths only. Any other repo/path is refused.
LIVE_TARGETS = (
    {
        "name": "helm",
        "repo_env": "HELM_REPO",
        "path_env": "HELM_OUTBOX_PATH",
        "repo": "Evaisawesome2025/evaos-v06",
        "path": "v07/outbox/threads.json",
    },
    {
        "name": "joinermill",
        "repo_env": "PRODUCT_REPO",
        "path_env": "PRODUCT_OUTBOX_PATH",
        "repo": "Evaisawesome2025/joinermill",
        "path": "app/outbox/threads.json",
    },
)
ALLOWED_LIVE = {(item["repo"], item["path"]) for item in LIVE_TARGETS}
LIVE_COMMIT_MESSAGE = (
    "outbox: publish 1 sanitized dogfood evidence record "
    "(EVIDENCE-LOOP-CLOSE; flag was ON; not a clean ship)"
)
LIVE_THREAD_CAP = 50


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


def _splice_thread(outbox: dict, record: dict, *, cap: int | None, staging_note: bool) -> dict:
    threads = [t for t in (outbox.get("threads") or []) if isinstance(t, dict)]
    threads = [
        t
        for t in threads
        if t.get("intent_id") != record["intent_id"]
        and t.get("objective_id") != record.get("objective_id")
    ]
    threads.insert(0, record)
    if cap is not None:
        threads = threads[:cap]
    outbox["threads"] = threads
    outbox["presence"] = idle_presence()
    if "approves" in outbox and not isinstance(outbox.get("approves"), list):
        outbox["approves"] = []
    elif staging_note:
        outbox["approves"] = outbox.get("approves") if isinstance(outbox.get("approves"), list) else []
    outbox["updated"] = ct_now()
    outbox["updated_ct"] = ct_now()
    if staging_note:
        outbox["note"] = (
            "STAGING dogfood outbox — not live Pages. "
            "Terminal dogfood-owner evidence only. Presence idle. No secrets."
        )
    elif not str(outbox.get("note") or "").strip():
        outbox["note"] = (
            "Dogfood owner outbox. Presence stays idle unless a real job is recorded. No secrets."
        )
    if "version" not in outbox:
        outbox["version"] = "1"
    return outbox


def merge_thread(outbox: dict, record: dict) -> dict:
    return _splice_thread(outbox, record, cap=None, staging_note=True)


def assert_live_record(record: dict) -> None:
    if not isinstance(record, dict):
        die("live record must be an object")
    allowed = {
        "intent_id",
        "objective_id",
        "status",
        "stage",
        "question",
        "answer_text",
        "answer_html",
        "answered_ct",
        "kind",
        "evidence",
    }
    extra = set(record) - allowed
    if extra:
        die(f"refusing ops fields on live record: {sorted(extra)}")
    if record.get("kind") not in ("owner", "objective"):
        die("live kind must be owner|objective")
    if record.get("stage") not in ALLOWED_STAGES:
        die("live stage must be answered|done")
    if record.get("status") not in ("ANSWERED", "DONE"):
        die("live status must be ANSWERED or DONE")
    evidence = record.get("evidence")
    if not isinstance(evidence, list) or len(evidence) < 1:
        die("refusing live publish without evidence[]")
    blob = json.dumps(record)
    low = blob.lower()
    for bad in FORBIDDEN_SUBSTRINGS:
        if bad in low:
            die(f"forbidden content for dogfood publish: {bad}")
    if looks_secret(blob):
        die("secrets in live record")
    for item in evidence:
        if not isinstance(item, dict) or set(item) != {"title", "url", "type", "opened_ct"}:
            die("live evidence items must be {title,url,type,opened_ct}")
        validate_url(item.get("url") or "")


def merge_live(outbox: dict, record: dict) -> dict:
    """Sanitized prepend + idle presence. Preserves the live outbox note."""
    assert_live_record(record)
    merged = _splice_thread(dict(outbox or {}), record, cap=LIVE_THREAD_CAP, staging_note=False)
    if any((p or {}).get("status") != "idle" for p in merged.get("presence") or []):
        die("refusing busy presence on live publish")
    return merged


def live_targets(environ: dict | None = None) -> list:
    env = os.environ if environ is None else environ
    targets = []
    for item in LIVE_TARGETS:
        repo = str(env.get(item["repo_env"]) or item["repo"]).strip()
        path = str(env.get(item["path_env"]) or item["path"]).strip()
        targets.append({"name": item["name"], "repo": repo, "path": path})
    return targets


def _refuse_stranger(targets: list) -> None:
    if [t["name"] for t in targets] != ["helm", "joinermill"]:
        die("refusing unexpected live target list")
    for target in targets:
        key = (target["repo"], target["path"])
        if key not in ALLOWED_LIVE:
            die(f"refusing stranger live target {target['repo']}:{target['path']}")


class GhContentsSink:
    """GitHub contents API, same GET/PUT shape as process_owner_asks.sh."""

    def _guard(self) -> None:
        if os.environ.get("EVAOS_EVIDENCE_GH") == "forbidden":
            die("gh invoked while forbidden")

    def read(self, repo: str, path: str):
        self._guard()
        try:
            raw = subprocess.check_output(
                ["gh", "api", f"repos/{repo}/contents/{path}"],
                text=True,
                stderr=subprocess.PIPE,
            )
        except subprocess.CalledProcessError as exc:
            die(f"gh contents read failed for {repo}:{path} (exit {exc.returncode})")
        meta = json.loads(raw)
        content = base64.b64decode(meta["content"]).decode("utf-8")
        return meta["sha"], json.loads(content)

    def write(self, repo: str, path: str, sha: str, body: str, message: str) -> str:
        self._guard()
        payload = {
            "message": message,
            "content": base64.b64encode(body.encode("utf-8")).decode("ascii"),
            "sha": sha,
            "branch": "main",
        }
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        try:
            json.dump(payload, handle)
            handle.close()
            result = subprocess.check_output(
                [
                    "gh",
                    "api",
                    "--method",
                    "PUT",
                    f"repos/{repo}/contents/{path}",
                    "--input",
                    handle.name,
                ],
                text=True,
                stderr=subprocess.PIPE,
            )
        except subprocess.CalledProcessError as exc:
            die(f"gh contents write failed for {repo}:{path} (exit {exc.returncode})")
        finally:
            try:
                os.unlink(handle.name)
            except OSError:
                pass
        info = json.loads(result)
        return (info.get("commit") or {}).get("sha") or "?"


class DirContentsSink:
    """Test double. Writes under a temp directory. Does not push Pages."""

    def __init__(self, root: Path):
        self.root = root

    def _files(self, repo: str, path: str):
        if not path or path.startswith("/") or ".." in path.split("/"):
            die(f"bad outbox path: {path}")
        dest = self.root / repo.replace("/", "__") / path
        return dest, Path(str(dest) + ".sha")

    def read(self, repo: str, path: str):
        dest, sha_path = self._files(repo, path)
        if not dest.is_file() or not sha_path.is_file():
            die(f"live sink missing {repo}:{path}")
        return sha_path.read_text().strip(), json.loads(dest.read_text())

    def write(self, repo: str, path: str, sha: str, body: str, message: str) -> str:
        dest, sha_path = self._files(repo, path)
        current = sha_path.read_text().strip() if sha_path.is_file() else ""
        if current != sha:
            die(f"sha mismatch for {repo}:{path}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(body)
        new_sha = "local"
        sha_path.write_text(new_sha + "\n")
        if not message:
            die("missing commit message")
        return new_sha


def build_sink(environ: dict | None = None):
    env = os.environ if environ is None else environ
    spec = str(env.get("EVIDENCE_LIVE_SINK") or "gh").strip()
    if spec == "gh":
        return GhContentsSink()
    prefix = "dir:"
    if spec.startswith(prefix):
        root = Path(spec[len(prefix):])
        if not root.is_dir():
            die(f"EVIDENCE_LIVE_SINK dir missing: {root}")
        return DirContentsSink(root)
    die("EVIDENCE_LIVE_SINK must be gh or dir:<path>")


def dual_write_live(record: dict, targets: list, sink) -> list:
    """Read both outboxes, then write both. A bad target fails before any PUT."""
    assert_live_record(record)
    _refuse_stranger(targets)
    prepared = []
    for target in targets:
        sha, doc = sink.read(target["repo"], target["path"])
        merged = merge_live(doc, record)
        prepared.append((target, sha, json.dumps(merged, indent=2) + "\n", len(merged["threads"])))
    results = []
    for target, sha, body, threads_n in prepared:
        commit = sink.write(target["repo"], target["path"], sha, body, LIVE_COMMIT_MESSAGE)
        results.append(
            {
                "name": target["name"],
                "repo": target["repo"],
                "path": target["path"],
                "sha": commit,
                "threads_n": threads_n,
            }
        )
    return results


def main() -> None:
    ap = argparse.ArgumentParser(description="Dogfood evidence publisher (flag OFF by default)")
    ap.add_argument("--packet", required=True, help="Path to terminal evidence packet JSON")
    ap.add_argument("--dry-run", action="store_true", help="Validate only; write dry_run receipt")
    ap.add_argument(
        "--i-accept-gage-enable",
        action="store_true",
        help="Human switch required with HELM_EVIDENCE_PUBLISH=1 before any live push. Call sites must not pass this.",
    )
    args = ap.parse_args()

    flag_on = os.environ.get("HELM_EVIDENCE_PUBLISH", "0").strip() in ("1", "true", "TRUE", "yes", "ON")
    packet_path = Path(args.packet)
    if not packet_path.is_file():
        die(f"packet not found: {packet_path}")

    pkt = json.loads(packet_path.read_text())
    record = validate_packet(pkt)

    # Both gates are required. Flag OFF never reaches the live sink, even if
    # the human switch was passed by mistake.
    if flag_on and not args.i_accept_gage_enable:
        die("HELM_EVIDENCE_PUBLISH=1 requires --i-accept-gage-enable after Gage packet")

    if args.dry_run:
        receipt = {
            "ok": True,
            "flag": "ON" if flag_on else "OFF",
            "mode": "dry-run",
            "validated_ct": ct_now(),
            "record": record,
            "live_push": False,
            "would_live_push": bool(flag_on),
            "contract": "ATLAS_DOGFOOD_EVIDENCE_PUBLISH_CONTRACT_20261002.md",
        }
        dry_dir = ROOT / "dry_run"
        dry_dir.mkdir(parents=True, exist_ok=True)
        receipt_path = dry_dir / f"{record['objective_id']}_dry.json"
        receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
        print(f"PASS dry-run · receipt {receipt_path}")
        print(json.dumps({"objective_id": record["objective_id"], "evidence_n": len(record["evidence"]), "live_push": False}))
        return

    if flag_on:
        targets = live_targets()
        sink = build_sink()
        results = dual_write_live(record, targets, sink)
        transport = "gh" if isinstance(sink, GhContentsSink) else "dir"
        receipt = {
            "ok": True,
            "flag": "ON",
            "mode": "live",
            "validated_ct": ct_now(),
            "record": record,
            "live_push": True,
            "transport": transport,
            "targets": results,
            "presence": "idle",
            "contract": "ATLAS_DOGFOOD_EVIDENCE_PUBLISH_CONTRACT_20261002.md",
        }
        dry_dir = ROOT / "dry_run"
        dry_dir.mkdir(parents=True, exist_ok=True)
        receipt_path = dry_dir / f"{record['objective_id']}_live.json"
        receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
        print(f"PASS live dual-write · transport={transport}")
        print(
            json.dumps(
                {
                    "objective_id": record["objective_id"],
                    "evidence_n": len(record["evidence"]),
                    "presence": "idle",
                    "live_push": True,
                    "transport": transport,
                    "targets": [f"{row['repo']}:{row['path']}" for row in results],
                }
            )
        )
        return

    receipt = {
        "ok": True,
        "flag": "OFF",
        "mode": "staging",
        "validated_ct": ct_now(),
        "record": record,
        "live_push": False,
        "contract": "ATLAS_DOGFOOD_EVIDENCE_PUBLISH_CONTRACT_20261002.md",
    }

    dry_dir = ROOT / "dry_run"
    dry_dir.mkdir(parents=True, exist_ok=True)
    receipt_path = dry_dir / f"{record['objective_id']}_staging.json"

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
