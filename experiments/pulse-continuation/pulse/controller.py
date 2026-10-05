"""One invocation, at most one new Turn. No scheduler and no model credentials."""
import os
import time

from .fixtures import FixturePlanner, FixtureWorker
from .model import Corrupt, LABEL, Rejected
from .principal import Principal
from .store import JournalExportError


def wake(directory, planner=None, worker=None, hold_seconds=0, crash_after_start=False):
    principal = Principal(directory)
    token = None
    outcome = "UNSET"
    try:
        head = principal.get_head()
        claim = principal.acquire(head["version"])
        if claim["outcome"] == "SLEEP_ALREADY_RUNNING":
            outcome = claim["outcome"]
        elif claim["outcome"] == "EXPIRED_RECLAIM_REQUIRED":
            outcome = principal.reclaim_expired()
        else:
            token = claim["token"]
            if hold_seconds:
                time.sleep(hold_seconds)  # bounded diagnostic fixture only
            head = principal.get_head()
            if head["recovery_needed"] or head["active_turn"]:
                outcome = principal.recover(token)
            elif head["status"] in {"COMPLETE", "BLOCKED", "CORRUPT"}:
                outcome = principal.sleep(token, "SLEEP_" + head["status"])
            elif head["status"] == "WAITING" and head["next_evaluation_after"] > time.time():
                outcome = principal.sleep(token, "SLEEP_WAITING")
            else:
                bundle = principal.build_planning_packet(token)
                proposal = (planner or FixturePlanner()).propose(bundle["packet"])
                if proposal.get("kind") == "ACTION":
                    frozen = principal.submit_proposal(token, bundle["packet_digest"], proposal)
                    tid = principal.admit(token, frozen)
                    grant = principal.start(token, tid)
                    if crash_after_start:
                        # Intentional process termination: transaction already durable;
                        # no worker result, receipt or unlock can be invented.
                        os._exit(70)
                    inputs = principal.worker_inputs(token, tid)
                    scenario = principal.snapshot()["scenario"]
                    artifact = (worker or FixtureWorker(defect=scenario == "defect_repair")).execute(grant, inputs)
                    receipt = principal.request_verify(token, tid, artifact)
                    outcome = receipt["verdict"]
                else:
                    outcome = principal.decision(token, bundle["packet_digest"], proposal)
    except Rejected as exc:
        outcome = exc.code
    except Corrupt as exc:
        return {"outcome": "STATE_CORRUPT", "reason": str(exc), "status": "CORRUPT", "proof_status": LABEL}
    finally:
        if token:
            try:
                # Releasing an expired lease is prohibited; leave it for reclaim.
                principal.release(token)
            except (Rejected, Corrupt):
                pass
    snapshot = principal.snapshot()
    try:
        principal.store.export()
        export = {"status": "OK"}
    except (JournalExportError, OSError, UnicodeError) as exc:
        export = {"status": "EXPORT_ERROR", "reason": str(exc)}
    return {"outcome": outcome, "objective": snapshot["objective"], "calls": snapshot["calls"],
            "turn_count": len(snapshot["turns"]), "pid": os.getpid(), "proof_status": LABEL,
            "journal_export": export}
