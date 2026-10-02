#!/usr/bin/env python3
"""Ops-only checks. Not a Helm card. Does not call gh or write product outboxes.

Proves:
- HELM_EVIDENCE_PUBLISH defaults OFF
- OFF dry-run/staging sets live_push false and idle presence
- ON without the gage-enable switch hard-refuses
- ON with that switch still refuses live dual-write in this cut
- canned OBJECTIVE, selftest, and empty evidence are not selected
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

MODULE = Path(__file__).resolve().parent
REPO = MODULE.parents[1]
PUBLISHER = MODULE / "publish_evidence.py"
HOOK = MODULE / "run_from_asks.sh"
FIXTURE = MODULE / "fixtures" / "UZ-FC-20261002-001.json"
STAGING = MODULE / "staging"
DRY = MODULE / "dry_run"

sys.path.insert(0, str(MODULE))
import select_packets  # noqa: E402


def _env(**extra):
    env = os.environ.copy()
    env.pop("HELM_EVIDENCE_PUBLISH", None)
    env.update(extra)
    return env


def _run(args, env):
    return subprocess.run(
        [sys.executable, str(PUBLISHER), *args],
        cwd=str(REPO),
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def _base(**overrides):
    packet = {
        "objective_id": "obj-1",
        "intent_id": "obj-1",
        "status": "DONE",
        "stage": "done",
        "kind": "objective",
        "author": "Evaisawesome2025",
        "issue_number": 99,
        "issue_url": "https://github.com/Evaisawesome2025/evaos-v05/issues/99",
        "question": "OBJECTIVE: Record the audit path for this dogfood objective.",
        "answer_text": "Org finished. The audit path is the evidence.",
        "evidence": [
            {
                "title": "Audit note",
                "url": "https://evaisawesome2025.github.io/evaos-v06/v07/",
                "type": "https",
                "opened_ct": "2026-10-02T07:15-05:00",
            }
        ],
    }
    packet.update(overrides)
    return packet


class FlagOffTests(unittest.TestCase):
    def tearDown(self):
        shutil.rmtree(STAGING, ignore_errors=True)
        shutil.rmtree(DRY, ignore_errors=True)

    def test_default_constant_is_off(self):
        source = PUBLISHER.read_text()
        self.assertIn('os.environ.get("HELM_EVIDENCE_PUBLISH", "0")', source)
        flag = (MODULE / "FLAG.md").read_text()
        self.assertIn("OFF", flag)
        self.assertIn("`0` / unset", flag)

    def test_repo_does_not_set_flag_on(self):
        for path in REPO.rglob("*"):
            if not path.is_file():
                continue
            if path.suffix not in {".sh", ".yml", ".yaml", ".json"} and path.name != "wrangler.toml":
                continue
            if "dogfood_evidence_publisher/fixtures" in str(path):
                continue
            if path.name == "test_flag_off.py":
                continue
            text = path.read_text(errors="ignore")
            for line in text.splitlines():
                stripped = line.strip()
                if stripped.startswith("#"):
                    continue
                self.assertNotRegex(
                    stripped,
                    r"HELM_EVIDENCE_PUBLISH=(1|true|TRUE|yes|ON)\b",
                    msg=str(path),
                )

    def test_hook_code_does_not_pass_gage_switch(self):
        for path in (HOOK, REPO / "scripts" / "process_owner_asks.sh"):
            for line in path.read_text().splitlines():
                if line.strip().startswith("#"):
                    continue
                self.assertNotIn("--i-accept-gage-enable", line, msg=str(path))

    def test_dry_run_flag_off_no_live_push(self):
        result = _run(["--packet", str(FIXTURE), "--dry-run"], _env())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("PASS dry-run", result.stdout)
        self.assertFalse(STAGING.exists())
        receipt = json.loads((DRY / "UZ-FC-20261002-001_dry.json").read_text())
        self.assertEqual(receipt["flag"], "OFF")
        self.assertFalse(receipt["live_push"])
        record = receipt["record"]
        self.assertEqual(record["stage"], "done")
        self.assertGreaterEqual(len(record["evidence"]), 1)
        self.assertNotIn("author", record)
        self.assertNotIn("issue_number", record)

    def test_staging_flag_off_idle_and_not_live(self):
        result = _run(["--packet", str(FIXTURE)], _env())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('"live_push": false', result.stdout)
        self.assertIn('"presence": "idle"', result.stdout)
        outbox = json.loads((STAGING / "threads.json").read_text())
        self.assertTrue(all(p["status"] == "idle" for p in outbox["presence"]))
        self.assertEqual(outbox["threads"][0]["objective_id"], "UZ-FC-20261002-001")
        self.assertIn("STAGING", outbox["note"])
        self.assertNotIn("author", outbox["threads"][0])

    def test_flag_on_without_switch_hard_refuses(self):
        result = _run(["--packet", str(FIXTURE)], _env(HELM_EVIDENCE_PUBLISH="1"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("requires --i-accept-gage-enable", result.stderr)
        self.assertFalse((STAGING / "threads.json").exists())

    def test_flag_on_with_switch_still_refuses_live_write(self):
        result = _run(
            ["--packet", str(FIXTURE), "--i-accept-gage-enable"],
            _env(HELM_EVIDENCE_PUBLISH="1"),
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("live Helm/joinermill dual-write not enabled", result.stderr)
        self.assertFalse((STAGING / "threads.json").exists())

    def test_empty_evidence_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "empty.json"
            packet = json.loads(FIXTURE.read_text())
            packet["evidence"] = []
            path.write_text(json.dumps(packet))
            result = _run(["--packet", str(path), "--dry-run"], _env())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("evidence[]", result.stderr)

    def test_selftest_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "self.json"
            packet = json.loads(FIXTURE.read_text())
            packet["kind"] = "selftest"
            path.write_text(json.dumps(packet))
            result = _run(["--packet", str(path), "--dry-run"], _env())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("kind must be owner|objective", result.stderr)

    def test_non_terminal_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "recv.json"
            packet = json.loads(FIXTURE.read_text())
            packet["status"] = "RECEIVED"
            path.write_text(json.dumps(packet))
            result = _run(["--packet", str(path), "--dry-run"], _env())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("terminal", result.stderr)


class SelectTests(unittest.TestCase):
    def test_skips_canned_objective_selftest_and_empty_evidence(self):
        received = _base(status="RECEIVED", stage="answered")
        canned = _base(objective_id="canned-1", intent_id="canned-1", canned=True)
        selftest = _base(objective_id="st-1", intent_id="st-1", kind="selftest", question="SELFTEST loop check")
        empty = _base(objective_id="empty-1", intent_id="empty-1", evidence=[])
        no_url = _base(
            objective_id="nourl-1",
            intent_id="nourl-1",
            evidence=[{"title": "Missing", "url": "", "type": "file"}],
        )
        good = _base()
        with tempfile.TemporaryDirectory() as tmp:
            inbox = Path(tmp) / "queue.json"
            inbox.write_text(json.dumps({"items": [received, canned, selftest, empty, no_url, good]}))
            picked = select_packets.collect(str(inbox))
        self.assertEqual([p["objective_id"] for p in picked], ["obj-1"])
        self.assertNotIn("author", picked[0])
        self.assertNotIn("issue_number", picked[0])
        self.assertEqual(picked[0]["stage"], "done")
        self.assertGreaterEqual(len(picked[0]["evidence"]), 1)

    def test_current_ops_outbox_has_no_evidence_packets(self):
        picked = select_packets.collect("", str(REPO / "outbox" / "threads.json"))
        self.assertEqual(picked, [])

    def test_answered_owner_with_evidence_is_selected(self):
        item = _base(
            status="ANSWERED",
            stage="answered",
            kind="owner",
            question="Where is the audit note?",
            objective_id="ask-1",
            intent_id="ask-1",
        )
        self.assertEqual(select_packets.candidate(item)["stage"], "answered")

    def test_ll_buy_copy_not_selected(self):
        item = _base(answer_text="Buy it on listinglift $39 today.")
        self.assertIsNone(select_packets.candidate(item))


class HookTests(unittest.TestCase):
    def tearDown(self):
        shutil.rmtree(STAGING, ignore_errors=True)
        shutil.rmtree(DRY, ignore_errors=True)

    def _hook(self, inbox: Path, outbox: Path, env):
        bin_dir = inbox.parent / "bin"
        bin_dir.mkdir(exist_ok=True)
        gh = bin_dir / "gh"
        gh.write_text("#!/bin/sh\necho gh-called >&2\nexit 99\n")
        gh.chmod(0o755)
        run_env = _env(**{k: v for k, v in env.items()})
        run_env["PATH"] = str(bin_dir) + os.pathsep + run_env.get("PATH", "")
        return subprocess.run(
            ["bash", str(HOOK), str(inbox), str(outbox)],
            cwd=str(REPO),
            env=run_env,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_default_flag_skips_when_no_terminal_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            inbox = Path(tmp) / "queue.json"
            inbox.write_text(
                json.dumps(
                    {
                        "items": [
                            _base(status="RECEIVED"),
                            _base(objective_id="st", intent_id="st", kind="selftest", question="selftest"),
                        ]
                    }
                )
            )
            outbox = Path(tmp) / "threads.json"
            outbox.write_text(json.dumps({"threads": []}))
            result = self._hook(inbox, outbox, {})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("flag=OFF", result.stdout)
        self.assertIn("packets=0", result.stdout)
        self.assertIn("live_push=false", result.stdout)
        self.assertNotIn("gh-called", result.stderr)
        self.assertFalse((STAGING / "threads.json").exists())

    def test_flag_off_stages_terminal_evidence_without_gh(self):
        with tempfile.TemporaryDirectory() as tmp:
            inbox = Path(tmp) / "queue.json"
            inbox.write_text(json.dumps({"items": [_base(objective_id="hook-1", intent_id="hook-1")]}))
            outbox = Path(tmp) / "threads.json"
            outbox.write_text(json.dumps({"threads": []}))
            result = self._hook(inbox, outbox, {})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("flag=OFF", result.stdout)
        self.assertIn("action=staging", result.stdout)
        self.assertNotIn("gh-called", result.stderr)
        staged = json.loads((STAGING / "threads.json").read_text())
        self.assertTrue(all(p["status"] == "idle" for p in staged["presence"]))
        self.assertEqual(staged["threads"][0]["objective_id"], "hook-1")
        self.assertGreaterEqual(len(staged["threads"][0]["evidence"]), 1)
        receipt = json.loads((DRY / "hook-1_staging.json").read_text())
        self.assertFalse(receipt["live_push"])

    def test_flag_on_refuses_without_writing_staging(self):
        with tempfile.TemporaryDirectory() as tmp:
            inbox = Path(tmp) / "queue.json"
            inbox.write_text(json.dumps({"items": [_base()]}))
            outbox = Path(tmp) / "threads.json"
            outbox.write_text(json.dumps({"threads": []}))
            result = self._hook(inbox, outbox, {"HELM_EVIDENCE_PUBLISH": "1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("action=refuse-live", result.stdout)
        self.assertIn("requires --i-accept-gage-enable", result.stderr)
        self.assertNotIn("gh-called", result.stderr)
        self.assertFalse((STAGING / "threads.json").exists())


if __name__ == "__main__":
    unittest.main()
