"""SQLite is the LOCAL authority only. Every mutation and event is one transaction.

No claim of agent-inaccessible storage or signing. NDJSON is a checked append-only
export, never an input to the controller. Database triggers protect against API
mistakes, not a local administrator who can edit the database and this code.
"""
from __future__ import annotations

import contextlib
import fcntl
import json
import os
import sqlite3
import time
from pathlib import Path

from .model import Corrupt, LABEL, canonical, code_hash, digest


class JournalExportError(Exception):
    """The derived export failed; this says nothing about committed head state."""


class Store:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.path = self.directory / "state.sqlite3"
        if not self.path.is_file():
            raise ValueError("State does not exist; use init with a new directory")

    @classmethod
    def create(cls, directory, state):
        directory = Path(directory).resolve()
        directory.mkdir(parents=True, exist_ok=False)
        path = directory / "state.sqlite3"
        db = sqlite3.connect(path)
        try:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                PRAGMA synchronous=FULL;
                CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
                CREATE TABLE events (seq INTEGER PRIMARY KEY, body TEXT NOT NULL, hash TEXT NOT NULL);
                CREATE TABLE quarantine (id INTEGER PRIMARY KEY CHECK(id=1), reason TEXT NOT NULL);
                CREATE TRIGGER immutable_events_update BEFORE UPDATE ON events BEGIN
                  SELECT RAISE(ABORT,'append-only events'); END;
                CREATE TRIGGER immutable_events_delete BEFORE DELETE ON events BEGIN
                  SELECT RAISE(ABORT,'append-only events'); END;
            """)
            state["code_hash"] = code_hash()
            db.execute("INSERT INTO state VALUES(1,?)", (canonical(state),))
            cls._append(db, state, [("OBJECTIVE_CREATED", {"objective": state["objective"]})])
            db.commit()
        finally:
            db.close()
        return cls(directory)

    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.execute("PRAGMA synchronous=FULL")
        return db

    @staticmethod
    def _append(db, state, events):
        last = db.execute("SELECT seq,hash FROM events ORDER BY seq DESC LIMIT 1").fetchone()
        seq, prev = last if last else (0, "0" * 64)
        for name, details in events:
            seq += 1
            item = {"seq": seq, "previous_hash": prev, "time": time.time(), "event": name,
                    "details": details, "state_digest": digest(state),
                    "code_hash": state["code_hash"], "proof_status": LABEL}
            prev = digest(item)
            db.execute("INSERT INTO events VALUES(?,?,?)", (seq, canonical(item), prev))

    @staticmethod
    def _read(db):
        quarantine = db.execute("SELECT reason FROM quarantine").fetchone()
        if quarantine:
            raise Corrupt(quarantine[0])
        try:
            row = db.execute("SELECT body FROM state WHERE id=1").fetchone()
            state = json.loads(row[0])
            prev = "0" * 64
            last = None
            for index, (seq, body, sha) in enumerate(db.execute("SELECT seq,body,hash FROM events ORDER BY seq"), 1):
                item = json.loads(body)
                if seq != index or item["seq"] != seq or item["previous_hash"] != prev or digest(item) != sha:
                    raise Corrupt("journal_chain_invalid")
                prev, last = sha, item
            if not last or last["state_digest"] != digest(state):
                raise Corrupt("state_journal_mismatch")
            return state
        except (TypeError, KeyError, ValueError, IndexError) as exc:
            raise Corrupt("invalid_state_encoding") from exc

    def quarantine(self, reason):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM quarantine").fetchone():
                db.execute("INSERT INTO quarantine VALUES(1,?)", (reason,))
                # Do not invent a valid replacement for corrupt history.
                raw = db.execute("SELECT body FROM state WHERE id=1").fetchone()
                marker = {"code_hash": code_hash(), "corrupt_raw_digest": digest(raw[0] if raw else None)}
                self._append(db, marker, [("STATE_CORRUPT", {"reason": reason})])

    def read(self):
        with self.connect() as db:
            db.execute("BEGIN")
            return self._read(db)

    def mutate(self, operation):
        try:
            with self.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                state = self._read(db)
                events = []
                result = operation(state, lambda name, **details: events.append((name, details)))
                if events:
                    db.execute("UPDATE state SET body=? WHERE id=1", (canonical(state),))
                    self._append(db, state, events)
                return result
        except Corrupt as exc:
            self.quarantine(str(exc))
            raise

    def stream(self):
        with self.connect() as db:
            return [{**json.loads(body), "hash": sha} for body, sha in db.execute("SELECT body,hash FROM events ORDER BY seq")]

    def export(self):
        target = self.directory / "events.ndjson"
        # Serialize exporters; re-read DB only after obtaining the export lock.
        with target.open("a+", encoding="utf-8") as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            records = [canonical(e) + "\n" for e in self.stream()]
            f.seek(0)
            existing = f.readlines()
            if existing != records[:len(existing)]:
                raise JournalExportError("journal_export_prefix_mismatch")
            f.seek(0, os.SEEK_END)
            f.writelines(records[len(existing):])
            f.flush()
            os.fsync(f.fileno())
        return str(target)
