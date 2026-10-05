"""LOCAL principal simulator. This module owns all authoritative API mutations.

Gate and verifier separation is logical, not adversarial isolation. The same
filesystem user can modify everything; no MAC or independent authority is claimed.
"""
from __future__ import annotations

import os
import time
import uuid

from .fixtures import PACKETS, FixtureVerifier, catalog
from .model import (AUTHORITY, Corrupt, LABEL, OBJECTIVE_STATUSES, TURN_STATUSES,
                    Rejected, clone, code_hash, digest)
from .store import Store


def initial_state(scenario="baseline", lease_seconds=900):
    if scenario not in {"baseline", "defect_repair"} or not 0 < lease_seconds <= 900:
        raise ValueError("Unsupported scenario or lease interval")
    return {"objective": {
        "objective_id": "OBJ-SYNTHETIC", "goal": "Analyze the three supplied packets and synthesize",
        "success_condition": "Verified A, B, C analyses and verified final synthesis",
        "status": "OPEN", "generation": 0, "last_verified_turn": None, "active_turn": None,
        "current_bottleneck": "Unanalyzed packets", "next_evaluation_after": None,
        "version": 0, "updated_at": time.time(), "last_failure": None, "recovery_needed": False},
        "packets": clone(PACKETS), "catalog": catalog(), "scenario": scenario,
        "lease_seconds": lease_seconds, "lease": None, "lease_epoch": 0,
        "turns": {}, "planning_packets": {}, "receipts": {}, "artifacts": {},
        "calls": {"planner": 0, "worker": 0, "verifier": 0}}


def verified_analyses(state):
    result = {}
    for turn_id, turn in state["turns"].items():
        action = turn["envelope"]["action"]
        if turn["status"] == "VERIFIED" and action["kind"] in {"analyze", "repair"}:
            result[action["packet_id"]] = {"turn_id": turn_id, "artifact": state["artifacts"][turn_id]}
    return result


def completion_holds(state):
    analyses = verified_analyses(state)
    if set(analyses) != set(state["packets"]):
        return False
    for tid, turn in state["turns"].items():
        if turn["status"] == "VERIFIED" and turn["envelope"]["action"]["kind"] == "synthesize":
            return state["artifacts"][tid].get("analysis_turns") == {k: v["turn_id"] for k, v in analyses.items()}
    return False


def validate_state(state):
    try:
        o = state["objective"]
        if o["status"] not in OBJECTIVE_STATUSES or type(o["version"]) is not int or o["version"] < 0:
            raise Corrupt("objective_schema")
        if type(o["generation"]) is not int or o["generation"] < 0:
            raise Corrupt("generation_schema")
        verified = {k: v for k, v in state["turns"].items() if v["status"] == "VERIFIED"}
        if len(verified) != o["generation"]:
            raise Corrupt("verified_count_mismatch")
        cursor, generation, seen = o["last_verified_turn"], o["generation"], set()
        while cursor is not None:
            if cursor in seen or cursor not in verified:
                raise Corrupt("broken_verified_predecessor")
            seen.add(cursor)
            t, r = verified[cursor], state["receipts"].get(cursor)
            if not r or r["verdict"] != "PASS" or t["envelope"]["generation"] != generation:
                raise Corrupt("receipt_lineage_mismatch")
            if r["proposal_digest"] != t["proposal_digest"] or r["evidence_digest"] != digest(state["artifacts"][cursor]):
                raise Corrupt("receipt_evidence_mismatch")
            cursor, generation = t["envelope"]["parent_turn"], generation - 1
        if generation != 0 or set(verified) != seen:
            raise Corrupt("verified_chain_gap")
        active = o["active_turn"]
        running = [k for k, t in state["turns"].items() if t["status"] in {"AUTHORIZED", "RUNNING", "VERIFYING"}]
        if running != ([active] if active else []):
            raise Corrupt("active_turn_mismatch")
        for t in state["turns"].values():
            if t["status"] not in TURN_STATUSES or t["proposal_digest"] != digest({"packet_digest": t["packet_digest"], "envelope": t["envelope"]}):
                raise Corrupt("turn_digest_or_status_invalid")
        if o["status"] == "COMPLETE" and not completion_holds(state):
            raise Corrupt("completion_without_verified_evidence")
    except (KeyError, TypeError, ValueError) as exc:
        raise Corrupt("invalid_schema_or_reference") from exc


class Principal:
    def __init__(self, directory, verifier=None):
        self.store = Store(directory)
        self.verifier = verifier or FixtureVerifier()

    @classmethod
    def initialize(cls, directory, scenario="baseline", lease_seconds=900):
        Store.create(directory, initial_state(scenario, lease_seconds))
        return cls(directory)

    def _run(self, operation, token=None):
        def guarded(s, emit):
            validate_state(s)
            if s["code_hash"] != code_hash():
                raise Rejected("REJECT_CODE_CHANGED")
            working, pending = clone(s), []
            try:
                result = operation(working, lambda name, **details: pending.append((name, details)))
                validate_state(working)
                # Last authorization checkpoint, under the same SQLite write
                # lock as the eventual commit. Even release/renew must finish
                # preparation within the original holder's lease.
                if token is not None:
                    self._lease(s, token)
                s.clear()
                s.update(working)
                for name, details in pending:
                    emit(name, **details)
                return {"result": result}
            except Rejected as exc:
                emit("REQUEST_REJECTED", reason=exc.code)
                return {"error": exc.code}
        result = self.store.mutate(guarded)
        if "error" in result:
            raise Rejected(result["error"])
        return result["result"]

    def snapshot(self):
        try:
            s = self.store.read()
            validate_state(s)
            return s
        except Corrupt as exc:
            self.store.quarantine(str(exc))
            raise

    def get_head(self):
        return clone(self.snapshot()["objective"])

    @staticmethod
    def _lease(s, token):
        lease = s["lease"]
        if not lease or lease["fencing_token"] != token:
            raise Rejected("REJECT_FENCED")
        if lease["expires_at"] <= time.time():
            raise Rejected("REJECT_LEASE_EXPIRED")
        return lease

    @staticmethod
    def _version(s, expected):
        if s["objective"]["version"] != expected:
            raise Rejected("REJECT_STALE_PLAN")

    @classmethod
    def _unused_wake(cls, s, token):
        lease = cls._lease(s, token)
        if lease["work_consumed"] is not None:
            raise Rejected("REJECT_WAKE_BUDGET")
        return lease

    def acquire(self, expected_version):
        def op(s, emit):
            emit("WAKE_SEEN", pid=os.getpid(), opportunity_only=True)
            if s["lease"]:
                if s["lease"]["expires_at"] > time.time():
                    return {"outcome": "SLEEP_ALREADY_RUNNING"}
                return {"outcome": "EXPIRED_RECLAIM_REQUIRED"}
            self._version(s, expected_version)
            s["lease_epoch"] += 1
            now = time.time()
            lease = {"objective_id": s["objective"]["objective_id"], "lock_id": uuid.uuid4().hex,
                     "fencing_token": str(s["lease_epoch"]) + ":" + uuid.uuid4().hex,
                     "acquired_at": now, "expires_at": now + s["lease_seconds"], "renewals": 0,
                     "objective_version_seen": expected_version, "work_consumed": None}
            s["lease"] = lease
            emit("LOCK_ACQUIRED", lock_id=lease["lock_id"], epoch=s["lease_epoch"])
            return {"outcome": "ACQUIRED", "token": lease["fencing_token"]}
        return self._run(op)

    def renew(self, token):
        def op(s, emit):
            lease = self._lease(s, token)
            if lease["renewals"] >= 3:
                raise Rejected("REJECT_RENEWAL_LIMIT")
            lease["renewals"] += 1
            lease["expires_at"] = time.time() + s["lease_seconds"]
            emit("LOCK_RENEWED", renewals=lease["renewals"])
        return self._run(op, token)

    def release(self, token):
        def op(s, emit):
            self._lease(s, token)
            if any(t["token"] == token and t["status"] in {"PROPOSED", "AUTHORIZED", "RUNNING", "VERIFYING"}
                   for t in s["turns"].values()):
                s["objective"]["recovery_needed"] = True
                emit("RECOVERY_REQUIRED", reason="released_unresolved_turn")
            s["lease"] = None
            emit("LOCK_RELEASED")
        return self._run(op, token)

    def reclaim_expired(self):
        def op(s, emit):
            if not s["lease"] or s["lease"]["expires_at"] > time.time():
                raise Rejected("REJECT_NOT_EXPIRED")
            s["lease"] = None
            s["objective"]["recovery_needed"] = True
            emit("LOCK_RECLAIMED", recovery_needed=True)
            return "RECOVERY_REQUIRED"
        return self._run(op)

    def recover(self, token):
        def op(s, emit):
            lease = self._unused_wake(s, token)
            o = s["objective"]
            if not o["recovery_needed"] and not o["active_turn"]:
                raise Rejected("REJECT_NO_RECOVERY")
            lease["work_consumed"] = "RECOVERY"
            active = o["active_turn"]
            for tid, turn in s["turns"].items():
                if turn["status"] in {"PROPOSED", "AUTHORIZED", "RUNNING", "VERIFYING"}:
                    turn["status"] = "FAILED" if tid == active else "BLOCKED"
                    emit("TURN_ABANDONED", turn_id=tid, prior_execution_uncertain=tid == active)
                    if tid == active:
                        s["receipts"][tid] = self._receipt(turn, "FAIL", None, ["abandoned_during_recovery"])
                        emit("VERIFY_FAIL", receipt=s["receipts"][tid])
            o["active_turn"] = None
            o["recovery_needed"] = False
            o["version"] += 1
            o["updated_at"] = time.time()
            if active:
                o["status"] = "BLOCKED"
                o["current_bottleneck"] = "Abandoned execution requires review; never automatically replayed"
            emit("RECOVERY_FINISHED", objective=clone(o), planning_ran=False)
            return "RECOVERED_BLOCKED" if active else "RECOVERED"
        return self._run(op, token)

    def sleep(self, token, outcome):
        def op(s, emit):
            self._lease(s, token)
            emit("PULSE_SLEPT", outcome=outcome, business_work=False)
            return outcome
        return self._run(op, token)

    def build_planning_packet(self, token, **caller_fields):
        def op(s, emit):
            self._lease(s, token)
            if caller_fields:
                raise Rejected("REJECT_CALLER_PACKET_BYTES")
            o = s["objective"]
            if o["recovery_needed"] or o["active_turn"]:
                raise Rejected("REJECT_RECOVERY_REQUIRED")
            self._unused_wake(s, token)
            if o["status"] == "WAITING" and o["next_evaluation_after"] <= time.time():
                o["status"] = "OPEN"
                o["next_evaluation_after"] = None
                o["version"] += 1
                emit("WAIT_ELAPSED", version=o["version"])
            if o["status"] != "OPEN":
                raise Rejected("REJECT_OBJECTIVE_NOT_OPEN")
            analyses = verified_analyses(s)
            packet = {"objective": clone(o), "verified_analyses": analyses,
                      "remaining_work": sorted(set(s["packets"]) - set(analyses)),
                      "synthesis_verified": completion_holds(s), "last_failure": clone(o["last_failure"]),
                      "catalog": clone(s["catalog"]), "authority": clone(AUTHORITY),
                      "budget": {"max_actions_per_wake": 1, "external_effects": 0},
                      "required_response": ["ACTION", "WAIT", "BLOCK", "COMPLETE"],
                      "proof_status": LABEL}
            pd = digest(packet)
            s["planning_packets"][pd] = {"packet": packet, "token": token}
            s["calls"]["planner"] += 1
            emit("PLANNING_PACKET_CREATED", packet_digest=pd, packet=packet)
            return {"packet": clone(packet), "packet_digest": pd}
        return self._run(op, token)

    def _packet(self, s, token, packet_digest):
        self._lease(s, token)
        p = s["planning_packets"].get(packet_digest)
        if not p or p["token"] != token or digest(p["packet"]) != packet_digest:
            raise Rejected("REJECT_PACKET_BINDING")
        self._version(s, p["packet"]["objective"]["version"])
        return p["packet"]

    def submit_proposal(self, token, packet_digest, proposal):
        def op(s, emit):
            packet = self._packet(s, token, packet_digest)
            self._unused_wake(s, token)
            o = s["objective"]
            if proposal.get("kind") != "ACTION" or proposal.get("slot_id") not in s["catalog"]:
                raise Rejected("REJECT_PROPOSAL_SCHEMA")
            allowed = {"kind", "slot_id", "action", "why_now", "objective_delta", "authority_required", "expected_effects"}
            if set(proposal) != allowed or not all(isinstance(proposal[k], str) and proposal[k].strip() for k in ["why_now", "objective_delta"]):
                raise Rejected("REJECT_PROPOSAL_SCHEMA")
            slot = s["catalog"][proposal["slot_id"]]
            if proposal["action"] != slot["action"] or proposal["authority_required"] != slot["authority"] or proposal["expected_effects"] != "NONE":
                raise Rejected("REJECT_AUTHORITY_OR_ACTION")
            if any(t["packet_digest"] == packet_digest and t["status"] == "PROPOSED" for t in s["turns"].values()):
                raise Rejected("REJECT_DUPLICATE_PROPOSAL")
            tid = "TURN-" + uuid.uuid4().hex
            envelope = {"turn_id": tid, "objective_id": o["objective_id"],
                        "objective_version": packet["objective"]["version"],
                        "parent_turn": packet["objective"]["last_verified_turn"],
                        "generation": packet["objective"]["generation"] + 1,
                        "slot_id": proposal["slot_id"], "action": clone(proposal["action"]),
                        "why_now": proposal["why_now"], "objective_delta": proposal["objective_delta"],
                        "success_criterion": clone(slot["success_criterion"]),
                        "authority": clone(slot["authority"]), "expected_effects": "NONE",
                        "created_at": time.time()}
            pd = digest({"packet_digest": packet_digest, "envelope": envelope})
            s["turns"][tid] = {"envelope": envelope, "proposal_digest": pd, "packet_digest": packet_digest,
                                "status": "PROPOSED", "started": False, "token": token}
            emit("TURN_PROPOSED", envelope=clone(envelope), proposal_digest=pd, planner_output=clone(proposal))
            return {"envelope": clone(envelope), "proposal_digest": pd, "packet_digest": packet_digest}
        return self._run(op, token)

    def admit(self, token, submitted):
        def op(s, emit):
            self._lease(s, token)
            envelope = submitted.get("envelope", {})
            turn = s["turns"].get(envelope.get("turn_id"))
            if not turn or turn["token"] != token:
                raise Rejected("REJECT_UNKNOWN_TURN")
            self._packet(s, token, turn["packet_digest"])
            o = s["objective"]
            if envelope.get("parent_turn") != o["last_verified_turn"]:
                raise Rejected("REJECT_STALE_PREDECESSOR")
            if envelope.get("generation") != o["generation"] + 1:
                raise Rejected("REJECT_GENERATION")
            frozen = {"envelope": turn["envelope"], "proposal_digest": turn["proposal_digest"], "packet_digest": turn["packet_digest"]}
            if submitted != frozen or digest({"packet_digest": turn["packet_digest"], "envelope": envelope}) != turn["proposal_digest"]:
                raise Rejected("REJECT_PROPOSAL_TAMPER")
            slot = s["catalog"][envelope["slot_id"]]
            if any(envelope[k] != slot[k] for k in ["action", "success_criterion", "authority", "expected_effects"]):
                raise Rejected("REJECT_CATALOG_BINDING")
            if envelope["objective_id"] != o["objective_id"] or envelope["objective_version"] != o["version"]:
                raise Rejected("REJECT_STALE_PLAN")
            if o["status"] != "OPEN" or o["active_turn"] or o["recovery_needed"]:
                raise Rejected("REJECT_ACTIVE_OR_NOT_OPEN")
            if turn["status"] != "PROPOSED" or turn["started"]:
                raise Rejected("REJECT_DUPLICATE_ADMIT")
            lease = self._unused_wake(s, token)
            if o["last_failure"]:
                if envelope["slot_id"] != o["last_failure"]["required_repair_slot_id"]:
                    raise Rejected("REJECT_REPAIR_SLOT")
            else:
                action = envelope["action"]
                analyses = verified_analyses(s)
                if action["kind"] == "repair" or (action["kind"] == "analyze" and action["packet_id"] in analyses):
                    raise Rejected("REJECT_NO_LEGITIMATE_SUCCESSOR")
                if action["kind"] == "synthesize" and set(analyses) != set(s["packets"]):
                    raise Rejected("REJECT_INCOMPLETE_ANALYSES")
            turn["status"] = "AUTHORIZED"
            lease["work_consumed"] = envelope["turn_id"]
            o["active_turn"] = envelope["turn_id"]
            emit("TURN_AUTHORIZED", turn_id=envelope["turn_id"], proposal_digest=turn["proposal_digest"])
            return envelope["turn_id"]
        return self._run(op, token)

    def start(self, token, turn_id):
        def op(s, emit):
            self._lease(s, token)
            turn = s["turns"].get(turn_id)
            if not turn or turn["token"] != token or turn["status"] != "AUTHORIZED" or turn["started"] or s["objective"]["active_turn"] != turn_id:
                raise Rejected("REJECT_START_NOT_AUTHORIZED_OR_DUPLICATE")
            self._version(s, turn["envelope"]["objective_version"])
            turn["started"], turn["status"] = True, "RUNNING"
            s["calls"]["worker"] += 1
            emit("TURN_STARTED", turn_id=turn_id, proposal_digest=turn["proposal_digest"])
            return {"envelope": clone(turn["envelope"]), "proposal_digest": turn["proposal_digest"],
                    "proof_status": LABEL}
        return self._run(op, token)

    def worker_inputs(self, token, turn_id):
        s = self.snapshot()
        self._lease(s, token)
        if s["objective"]["active_turn"] != turn_id or s["turns"][turn_id]["status"] != "RUNNING":
            raise Rejected("REJECT_NOT_RUNNING")
        return {"packets": clone(s["packets"]), "verified_analyses": clone(verified_analyses(s))}

    @staticmethod
    def _receipt(turn, verdict, artifact, reasons):
        e = turn["envelope"]
        r = {"objective_id": e["objective_id"], "turn_id": e["turn_id"], "generation": e["generation"],
             "proposal_digest": turn["proposal_digest"], "success_criterion": clone(e["success_criterion"]),
             "verdict": verdict, "reasons": reasons, "evidence_digest": digest(artifact),
             "verified_at": time.time(), "proof_status": LABEL, "seal": "UNSEALED_LOCAL_CHECKSUM"}
        r["receipt_id"] = digest(r)
        return r

    def request_verify(self, token, turn_id, artifact, **caller_fields):
        def op(s, emit):
            self._lease(s, token)
            if caller_fields:
                raise Rejected("REJECT_CALLER_VERDICT")
            turn = s["turns"].get(turn_id)
            if not turn or turn["token"] != token or turn["status"] != "RUNNING" or s["objective"]["active_turn"] != turn_id:
                raise Rejected("REJECT_NOT_RUNNING")
            self._version(s, turn["envelope"]["objective_version"])
            try:
                frozen_artifact = clone(artifact)
                frozen_digest = digest(frozen_artifact)
            except (TypeError, ValueError, OverflowError, RecursionError, UnicodeError) as exc:
                raise Rejected("REJECT_ARTIFACT_ENCODING") from exc
            inputs = {"packets": clone(s["packets"]), "verified_analyses": clone(verified_analyses(s))}
            # One principal-owned snapshot binds verification, receipt and store.
            # Neither caller nor verifier receives an alias to that snapshot.
            result = clone(self.verifier.evaluate(clone(turn["envelope"]), clone(frozen_artifact), inputs))
            if result.get("verdict") not in {"PASS", "FAIL"}:
                raise Rejected("REJECT_VERIFIER_PROTOCOL")
            if result.get("evidence_digest") != frozen_digest:
                raise Rejected("REJECT_VERIFIER_EVIDENCE_BINDING")
            # Verifier latency cannot outlive the lease and still commit.
            self._lease(s, token)
            s["calls"]["verifier"] += 1
            turn["status"] = "VERIFYING"
            emit("TURN_VERIFYING", turn_id=turn_id)
            receipt = self._receipt(turn, result["verdict"], frozen_artifact, result["reasons"])
            s["artifacts"][turn_id] = frozen_artifact
            s["receipts"][turn_id] = receipt
            o = s["objective"]
            o["active_turn"] = None
            o["version"] += 1
            o["updated_at"] = time.time()
            if result["verdict"] == "PASS":
                turn["status"] = "VERIFIED"
                o["last_verified_turn"] = turn_id
                o["generation"] += 1
                o["last_failure"] = None
                o["current_bottleneck"] = "Remaining verified work"
                emit("TURN_VERIFIED", receipt=receipt)
                if completion_holds(s):
                    o["status"] = "COMPLETE"
                    o["current_bottleneck"] = None
                    emit("OBJECTIVE_COMPLETED", turn_id=turn_id)
            else:
                turn["status"] = "FAILED"
                repairable = (turn["envelope"]["action"]["packet_id"] == "C"
                              if "packet_id" in turn["envelope"]["action"] else False)
                repairable = repairable and result["fault_payload"].get("defect_class") == "missing_observation"
                o["last_failure"] = {"turn_id": turn_id, "receipt_id": receipt["receipt_id"],
                                     "fault_id": "visible_missing_C_observation" if repairable else "unhandled_defect",
                                     "fault_payload": clone(result["fault_payload"]),
                                     "required_repair_slot_id": "repair_C_evidence" if repairable else None}
                if not repairable:
                    o["status"] = "BLOCKED"
                o["current_bottleneck"] = "Repair verified failure" if repairable else "Unrecognized failure requires review"
                emit("TURN_FAILED", receipt=receipt, last_failure=clone(o["last_failure"]))
            emit("OBJECTIVE_UPDATED", objective=clone(o))
            return clone(receipt)
        return self._run(op, token)

    def decision(self, token, packet_digest, proposal):
        def op(s, emit):
            self._packet(s, token, packet_digest)
            o = s["objective"]
            if o["active_turn"] or o["recovery_needed"] or o["status"] != "OPEN":
                raise Rejected("REJECT_ACTIVE_OR_NOT_OPEN")
            lease = self._unused_wake(s, token)
            kind = proposal.get("kind")
            if kind == "COMPLETE":
                if not completion_holds(s):
                    raise Rejected("REJECT_UNPROVEN_COMPLETE")
                o["status"] = "COMPLETE"
            elif kind == "WAIT":
                delay = proposal.get("retry_after_seconds")
                if type(delay) not in (int, float) or not 0 < delay <= 86400:
                    raise Rejected("REJECT_WAIT_INTERVAL")
                o["status"] = "WAITING"
                o["next_evaluation_after"] = time.time() + delay
            elif kind == "BLOCK":
                o["status"] = "BLOCKED"
            else:
                raise Rejected("REJECT_DECISION_SCHEMA")
            if not isinstance(proposal.get("reason"), str) or not proposal["reason"].strip():
                raise Rejected("REJECT_DECISION_REASON")
            o["current_bottleneck"] = proposal["reason"]
            o["version"] += 1
            o["updated_at"] = time.time()
            lease["work_consumed"] = kind
            emit("PLANNER_DECISION", proposal=clone(proposal), objective=clone(o))
            return kind
        return self._run(op, token)
