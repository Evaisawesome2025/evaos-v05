"""Visible synthetic data and deterministic adapters, never a model-autonomy proof."""
from .model import AUTHORITY, clone, digest

PACKETS = {
    "A": {"topic": "synthetic response observations", "observations": {"a1": 2, "a2": 4, "a3": 6}},
    "B": {"topic": "synthetic turnaround observations", "observations": {"b1": 3, "b2": 5, "b3": 7}},
    "C": {"topic": "synthetic revision observations", "observations": {"c1": 1, "c2": 8, "c3": 9}},
}


def catalog():
    out = {}
    for name in PACKETS:
        out["analyze_" + name] = {
            "action": {"kind": "analyze", "packet_id": name},
            "success_criterion": {"check": "complete_analysis_v1", "packet_id": name,
                                  "description": "All source observations, exact count/total and source digest."},
        }
    out["repair_C_evidence"] = {
        "action": {"kind": "repair", "packet_id": "C"},
        "success_criterion": {"check": "complete_analysis_v1", "packet_id": "C",
                              "description": "All source observations, exact count/total and source digest."},
    }
    out["synthesize"] = {
        "action": {"kind": "synthesize"},
        "success_criterion": {"check": "verified_synthesis_v1",
                              "description": "Cite exactly the verified A/B/C analyses and their correct aggregate."},
    }
    for item in out.values():
        item["authority"] = clone(AUTHORITY)
        item["expected_effects"] = "NONE"
    return out


class FixturePlanner:
    """Reads remaining work and last_failure, not a wake number or Turn queue."""
    def propose(self, packet):
        if packet["last_failure"]:
            failure = packet["last_failure"]
            if failure["fault_payload"].get("defect_class") == "missing_observation":
                slot = "repair_C_evidence"
            else:
                return {"kind": "BLOCK", "reason": "No bounded repair for this failure"}
        elif packet["remaining_work"]:
            slot = "analyze_" + sorted(packet["remaining_work"])[0]
        elif not packet["synthesis_verified"]:
            slot = "synthesize"
        else:
            return {"kind": "COMPLETE", "reason": "All verified evidence exists"}
        entry = packet["catalog"][slot]
        return {"kind": "ACTION", "slot_id": slot, "action": clone(entry["action"]),
                "why_now": "Derived from remaining work or the durable failure receipt",
                "objective_delta": "Produce the next missing verified artifact",
                "authority_required": clone(entry["authority"]),
                "expected_effects": "NONE"}


class FixtureWorker:
    def __init__(self, defect=False):
        self.defect = defect

    def execute(self, grant, inputs):
        # Grant is a controller-returned data structure, NOT a cryptographic trust
        # boundary. The controller consumes its one-shot start before this call.
        action = grant["envelope"]["action"]
        if action["kind"] in {"analyze", "repair"}:
            name = action["packet_id"]
            source = inputs["packets"][name]
            ids = sorted(source["observations"])
            # Visible fault device changes artifact bytes, never the verdict.
            # Its predicate is action/data based, not wake count.
            if self.defect and action == {"kind": "analyze", "packet_id": "C"}:
                ids = [i for i in ids if i != "c3"]
            return {"kind": "analysis", "packet_id": name, "source_digest": digest(source),
                    "observation_ids": ids, "count": len(ids),
                    "total": sum(source["observations"][i] for i in ids)}
        analyses = inputs["verified_analyses"]
        return {"kind": "synthesis", "analysis_turns": {k: v["turn_id"] for k, v in analyses.items()},
                "total": sum(v["artifact"]["total"] for v in analyses.values()),
                "observation_count": sum(v["artifact"]["count"] for v in analyses.values())}


class FixtureVerifier:
    """Separate implementation recomputes source truth; never asks the worker for PASS."""
    def evaluate(self, envelope, artifact, inputs):
        criterion = envelope["success_criterion"]
        invalid_shape = not isinstance(artifact, dict)
        if not invalid_shape and criterion["check"] == "complete_analysis_v1":
            ids = artifact.get("observation_ids", [])
            invalid_shape = not isinstance(ids, list) or not all(isinstance(i, str) for i in ids)
        if invalid_shape:
            return {"verdict": "FAIL", "reasons": ["malformed_artifact"],
                    "fault_payload": {"defect_class": "invalid_artifact", "missing_observation_ids": []},
                    "evidence_digest": digest(artifact)}
        failures = []
        missing = []
        if criterion["check"] == "complete_analysis_v1":
            name = criterion["packet_id"]
            source = inputs["packets"][name]
            expected_ids = sorted(source["observations"])
            missing = sorted(set(expected_ids) - set(artifact.get("observation_ids", [])))
            expected = {"kind": "analysis", "packet_id": name,
                        "source_digest": digest(source), "observation_ids": expected_ids,
                        "count": len(expected_ids), "total": sum(source["observations"].values())}
        elif criterion["check"] == "verified_synthesis_v1":
            analyses = inputs["verified_analyses"]
            if set(analyses) != set(inputs["packets"]):
                failures.append("missing_verified_analysis")
            expected = {"kind": "synthesis", "analysis_turns": {k: v["turn_id"] for k, v in analyses.items()},
                        "total": sum(v["artifact"]["total"] for v in analyses.values()),
                        "observation_count": sum(v["artifact"]["count"] for v in analyses.values())}
        else:
            return {"verdict": "FAIL", "reasons": ["unknown_check"], "fault_payload": {}}
        for key, value in expected.items():
            if artifact.get(key) != value:
                failures.append("mismatch:" + key)
        if set(artifact) != set(expected):
            failures.append("unexpected_or_missing_fields")
        return {"verdict": "FAIL" if failures else "PASS", "reasons": failures,
                "fault_payload": {"defect_class": "missing_observation" if missing else "invalid_artifact",
                                  "missing_observation_ids": missing},
                "evidence_digest": digest(artifact)}
