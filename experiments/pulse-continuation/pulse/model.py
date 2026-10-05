"""Canonical bytes and explicit adapter contracts; no external dependencies."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Protocol

LABEL = "UNSCORED_LOCAL_SIMULATION"
OBJECTIVE_STATUSES = {"OPEN", "WAITING", "BLOCKED", "COMPLETE", "CORRUPT"}
TURN_STATUSES = {"PROPOSED", "AUTHORIZED", "RUNNING", "VERIFYING", "VERIFIED", "FAILED", "BLOCKED"}
AUTHORITY = {"class": "LOCAL_SYNTHETIC_COMPUTE", "effects": "NONE"}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def clone(value):
    return json.loads(canonical(value))


def code_hash():
    root = Path(__file__).parent
    return digest({p.name: p.read_text() for p in sorted(root.glob("*.py"))})


class Rejected(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class Corrupt(Exception):
    pass


class Planner(Protocol):
    def propose(self, packet: dict) -> dict:
        """One ACTION/WAIT/BLOCK/COMPLETE from the principal-built packet."""


class Worker(Protocol):
    def execute(self, grant: dict, inputs: dict) -> dict:
        """Return artifact bytes only. No store, admission or verdict interface."""


class Verifier(Protocol):
    def evaluate(self, envelope: dict, artifact: dict, inputs: dict) -> dict:
        """Compute verdict from fixed criterion and evidence; no caller verdict."""
