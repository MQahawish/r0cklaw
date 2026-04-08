#!/usr/bin/env bash
# Start all active Rocklaw ZeroClaw gateways in the background.
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

AGENTS=(elena marcus finn lena sera)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/load-local-env.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/provider-env.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/agent-process.sh"

ZEROCLAW_BIN="${ROCKLAW_ZEROCLAW_BIN:-$ROOT_DIR/.rocklaw/bin/zeroclaw}"
if [[ ! -x "$ZEROCLAW_BIN" ]]; then
  ZEROCLAW_BIN="$(command -v zeroclaw)"
fi

"$SCRIPT_DIR/sync-openrouter-default-models.sh"

echo "Starting all Rocklaw agents..."
echo ""

for agent in "${AGENTS[@]}"; do
  AGENT_DIR="$SCRIPT_DIR/../agents/$agent"
  CONFIG_PATH="$AGENT_DIR/config.toml"
  LOG="$(agent_log_file "$agent")"
  PID="$(agent_pid_file "$agent")"

  if ! provider_credentials_ok "$CONFIG_PATH"; then
    echo "  $agent -- skipped (missing credentials)"
    echo "           $(provider_credentials_message "$CONFIG_PATH")"
    continue
  fi

  if pid="$(agent_running_pid "$agent" 2>/dev/null)"; then
    port="$(grep -A5 '^\[gateway\]' "$CONFIG_PATH" | grep '^\s*port' | awk -F'=' '{print $2}' | tr -d ' ')"
    if [[ -n "$port" ]] && curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
      echo "  $agent -- already running (pid $pid)"
      continue
    fi
    echo "  $agent -- running but gateway unhealthy (pid $pid), restarting..."
    kill -9 "$pid" 2>/dev/null || sudo kill -9 "$pid" 2>/dev/null || true
    sleep 1
  fi

  cd "$AGENT_DIR"
  ZEROCLAW_DISABLE_PROVIDER_STREAMING=1 nohup "$ZEROCLAW_BIN" --config-dir "$AGENT_DIR" gateway start > "$LOG" 2>&1 < /dev/null &
  pid=$!
  echo "$pid" > "$PID"
  echo "  $agent -- started (pid $pid, provider $(provider_from_config "$CONFIG_PATH"), log $LOG)"
done

echo ""
echo "All agents launched. Use 'scripts/stop-all-agents.sh' to stop."
