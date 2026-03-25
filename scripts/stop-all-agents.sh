#!/usr/bin/env bash
# Stop all Rocklaw ZeroClaw gateways that were started by start-all-agents.sh.

AGENTS=(elena marcus finn lena sera aldric cora rook)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/agent-process.sh"

echo "Stopping all Rocklaw agents..."
for agent in "${AGENTS[@]}"; do
  if pid="$(stop_agent_process "$agent" 2>/dev/null)"; then
    echo "  $agent -- stopped (pid $pid)"
  else
    echo "  $agent -- not running"
  fi
done
