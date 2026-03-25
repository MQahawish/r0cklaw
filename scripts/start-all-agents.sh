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
# shellcheck disable=SC1091
source "$SCRIPT_DIR/load-local-env.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/provider-env.sh"

echo "Starting all Rocklaw agents..."
echo ""

for agent in "${AGENTS[@]}"; do
  AGENT_DIR="$SCRIPT_DIR/../agents/$agent"
  CONFIG_PATH="$AGENT_DIR/config.toml"
  LOG="/tmp/zeroclaw-$agent.log"
  PID="/tmp/zeroclaw-$agent.pid"

  if ! provider_credentials_ok "$CONFIG_PATH"; then
    echo "  $agent -- skipped (missing credentials)"
    echo "           $(provider_credentials_message "$CONFIG_PATH")"
    continue
  fi

  if [[ -f "$PID" ]] && kill -0 "$(cat "$PID")" 2>/dev/null; then
    echo "  $agent -- already running (pid $(cat "$PID"))"
    continue
  fi

  cd "$AGENT_DIR"
  nohup zeroclaw --config-dir "$AGENT_DIR" gateway start > "$LOG" 2>&1 < /dev/null &
  pid=$!
  echo "$pid" > "$PID"
  echo "  $agent -- started (pid $pid, provider $(provider_from_config "$CONFIG_PATH"), log $LOG)"
done

echo ""
echo "All agents launched. Use 'scripts/stop-all-agents.sh' to stop."
