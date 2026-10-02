#!/usr/bin/env bash
# Call site for scripts/process_owner_asks.sh.
#
# Calls publish_evidence.py only for a dogfood owner/objective packet that is
# already terminal (ANSWERED or DONE) and already has at least one evidence URL.
# Canned OBJECTIVE answers and selftests are dropped by select_packets.py.
#
# HELM_EVIDENCE_PUBLISH unset or 0: staging path only (local file). No live push.
# HELM_EVIDENCE_PUBLISH=1: this hook still does not pass --i-accept-gage-enable,
# so publish_evidence.py hard-refuses live Helm / joinermill dual-write.
# This cut does not implement that live write.
set -euo pipefail

MODULE="$(cd "$(dirname "$0")" && pwd)"
UZ_INBOX="${1:-}"
OPS_OUTBOX="${2:-}"
PUBLISHER="$MODULE/publish_evidence.py"
SELECT="$MODULE/select_packets.py"

flag="${HELM_EVIDENCE_PUBLISH:-0}"
flag="${flag//[[:space:]]/}"
case "$flag" in
  1|true|TRUE|yes|ON) flag_on=1 ;;
  *) flag_on=0 ;;
esac

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

python3 "$SELECT" \
  --uz-inbox "$UZ_INBOX" \
  --ops-outbox "$OPS_OUTBOX" \
  --out-dir "$workdir/packets" >/dev/null

shopt -s nullglob
packets=("$workdir/packets"/*.json)
if [[ ${#packets[@]} -eq 0 ]]; then
  if [[ "$flag_on" -eq 1 ]]; then
    echo "EVIDENCE_PUBLISH flag=ON action=skip packets=0 live_push=false"
  else
    echo "EVIDENCE_PUBLISH flag=OFF action=skip packets=0 live_push=false"
  fi
  exit 0
fi

for pkt in "${packets[@]}"; do
  if [[ "$flag_on" -eq 1 ]]; then
    echo "EVIDENCE_PUBLISH flag=ON action=refuse-live packet=$(basename "$pkt") live_push=false"
    # Publisher exits non-zero. Do not add the gage-enable switch here.
    python3 "$PUBLISHER" --packet "$pkt"
  else
    echo "EVIDENCE_PUBLISH flag=OFF action=staging packet=$(basename "$pkt") live_push=false"
    python3 "$PUBLISHER" --packet "$pkt"
  fi
done
