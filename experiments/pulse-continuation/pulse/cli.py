"""python3 -m pulse.cli --help"""
import argparse
import json

from .controller import wake
from .model import Corrupt, LABEL, Rejected
from .principal import Principal
from .store import JournalExportError


def main():
    parser = argparse.ArgumentParser(description="Pulse UNSCORED local controller mechanics; no external services")
    sub = parser.add_subparsers(dest="command", required=True)
    init = sub.add_parser("init")
    init.add_argument("directory")
    init.add_argument("--scenario", choices=["baseline", "defect_repair"], default="baseline")
    init.add_argument("--lease-seconds", type=float, default=900)
    step = sub.add_parser("wake")
    step.add_argument("directory")
    step.add_argument("--hold-seconds", type=float, default=0)
    step.add_argument("--crash-after-start", action="store_true")
    for name in ["inspect", "export"]:
        p = sub.add_parser(name)
        p.add_argument("directory")
    args = parser.parse_args()
    try:
        if args.command == "init":
            p = Principal.initialize(args.directory, args.scenario, args.lease_seconds)
            result = {"objective": p.get_head(), "turn_count": 0, "proof_status": LABEL}
        elif args.command == "wake":
            if not 0 <= args.hold_seconds <= 10:
                parser.error("hold-seconds must be 0..10")
            result = wake(args.directory, hold_seconds=args.hold_seconds, crash_after_start=args.crash_after_start)
        elif args.command == "inspect":
            result = Principal(args.directory).snapshot()
            result["proof_status"] = LABEL
        else:
            result = {"journal": Principal(args.directory).store.export(), "proof_status": LABEL}
    except JournalExportError as exc:
        result = {"outcome": "JOURNAL_EXPORT_ERROR", "reason": str(exc), "proof_status": LABEL}
    except Corrupt as exc:
        result = {"outcome": "STATE_CORRUPT", "status": "CORRUPT", "reason": str(exc), "proof_status": LABEL}
    except Rejected as exc:
        result = {"outcome": exc.code, "proof_status": LABEL}
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
