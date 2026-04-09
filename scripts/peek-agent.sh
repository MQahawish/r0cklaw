#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

AGENT=${1:-}

if [[ -z "$AGENT" ]]; then
  echo "Usage: $0 <agent-slug>"
  exit 1
fi

WORKSPACE="$ROOT_DIR/agents/$AGENT/workspace"
TRACE="$WORKSPACE/state/runtime-trace.jsonl"
TICK_DEBUG="$WORKSPACE/state/tick-debug.jsonl"
LOG="/tmp/zeroclaw-$AGENT.log"

echo "=== $AGENT: TURN.md ==="
sed -n '1,220p' "$WORKSPACE/TURN.md" 2>/dev/null || echo "(missing)"
echo
echo
echo "=== $AGENT: last tick debug entries ==="
tail -n 10 "$TICK_DEBUG" 2>/dev/null || echo "(no tick debug entries yet)"
echo
echo "=== $AGENT: last trace lines ==="
tail -n 20 "$TRACE" 2>/dev/null || echo "(no runtime trace events yet)"
echo
echo "=== $AGENT: last gateway log lines ==="
tail -n 20 "$LOG" 2>/dev/null || echo "(no gateway log yet)"
