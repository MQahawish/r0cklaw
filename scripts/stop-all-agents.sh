#!/usr/bin/env bash
# Stop all Rocklaw ZeroClaw gateways that were started by start-all-agents.sh.

AGENTS=(elena marcus finn lena sera aldric cora rook)

echo "Stopping all Rocklaw agents..."
for agent in "${AGENTS[@]}"; do
  PID="/tmp/zeroclaw-$agent.pid"
  if [[ -f "$PID" ]]; then
    pid=$(cat "$PID")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid"
      echo "  $agent -- stopped (pid $pid)"
    else
      echo "  $agent -- not running"
    fi
    rm -f "$PID"
  else
    echo "  $agent -- no pid file found"
  fi
done
