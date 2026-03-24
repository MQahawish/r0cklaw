#!/usr/bin/env bash
# Start all 8 Rocklaw ZeroClaw gateways in the background.
#
# Usage:
#   ./scripts/start-all-agents.sh
#
# Requires:
#   - zeroclaw binary in PATH
#   - OPENROUTER_API_KEY set in environment
#
# Logs land in /tmp/zeroclaw-<agent>.log
# PIDs land in /tmp/zeroclaw-<agent>.pid

set -euo pipefail

AGENTS=(elena marcus finn lena sera aldric cora rook)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo "Error: OPENROUTER_API_KEY is not set."
  echo "Export it before running: export OPENROUTER_API_KEY='your-key'"
  exit 1
fi

echo "Starting all Rocklaw agents..."
echo ""

for agent in "${AGENTS[@]}"; do
  AGENT_DIR="$SCRIPT_DIR/../agents/$agent"
  LOG="/tmp/zeroclaw-$agent.log"
  PID="/tmp/zeroclaw-$agent.pid"

  if [[ -f "$PID" ]] && kill -0 "$(cat "$PID")" 2>/dev/null; then
    echo "  $agent -- already running (pid $(cat "$PID"))"
    continue
  fi

  cd "$AGENT_DIR"
  zeroclaw --config-dir "$AGENT_DIR" gateway start > "$LOG" 2>&1 &
  echo $! > "$PID"
  echo "  $agent -- started (pid $!, log $LOG)"
done

echo ""
echo "All agents launched. Use 'scripts/stop-all-agents.sh' to stop."
