#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

AGENT=${1:-}

if [[ -z "$AGENT" ]]; then
  echo "Usage: $0 <agent-slug>"
  exit 1
fi

TRACE="$ROOT_DIR/agents/$AGENT/workspace/state/runtime-trace.jsonl"
LOG="/tmp/zeroclaw-$AGENT.log"

echo "Tailing $LOG"
echo "Trace file: $TRACE"
echo "Ctrl+C to stop."
echo ""

touch "$LOG"
touch "$TRACE"
tail -f "$LOG" "$TRACE"
