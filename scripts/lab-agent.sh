#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck disable=SC1091
source "$SCRIPT_DIR/load-local-env.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/provider-env.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/agent-lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/agent-process.sh"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: required command not found: $1"
    exit 1
  fi
}

require_cmd docker
require_cmd curl
require_cmd zeroclaw
require_cmd npx
require_cmd perl
"$SCRIPT_DIR/ensure-agent-workspace-perms.sh"

AGENT=""
MODE="--continue"
PROFILE="--seeded"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --continue|--fresh)
      MODE="$1"
      shift
      ;;
    --seeded|--blank-self)
      PROFILE="$1"
      shift
      ;;
    --help|-h)
      echo "Usage: $0 <agent-slug> [--continue|--fresh] [--seeded|--blank-self]"
      exit 0
      ;;
    *)
      if [[ -z "$AGENT" ]]; then
        AGENT="$1"
        shift
      else
        echo "Usage: $0 <agent-slug> [--continue|--fresh] [--seeded|--blank-self]"
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$AGENT" ]]; then
  echo "Usage: $0 <agent-slug> [--continue|--fresh] [--seeded|--blank-self]"
  exit 1
fi

AGENT_DIR="$ROOT_DIR/agents/$AGENT"
CONFIG_PATH="$AGENT_DIR/config.toml"
TRACE_PATH="$AGENT_DIR/workspace/state/runtime-trace.jsonl"
TICK_DEBUG_PATH="$AGENT_DIR/workspace/state/tick-debug.jsonl"
LOG_PATH="/tmp/zeroclaw-$AGENT.log"
PID_PATH="$(agent_pid_file "$AGENT")"
AGENT_NAME="$(agent_slug_to_name "$AGENT")"
GATEWAY_PORT="$(sed -n 's/^port[[:space:]]*=[[:space:]]*\([0-9][0-9]*\)$/\1/p' "$CONFIG_PATH" | head -n1)"

if [[ ! -d "$AGENT_DIR" ]]; then
  echo "Error: no agent directory found at $AGENT_DIR"
  exit 1
fi

if ! provider_credentials_ok "$CONFIG_PATH"; then
  echo "Error: provider credentials are not configured for $AGENT."
  provider_credentials_message "$CONFIG_PATH"
  exit 1
fi

cd "$ROOT_DIR"
export HOST_UID="${HOST_UID:-$(id -u)}"
export HOST_GID="${HOST_GID:-$(id -g)}"

echo "[1/5] Starting self-hosted Convex backend..."
docker compose up -d backend dashboard
wait_for_url "http://127.0.0.1:3210/version"
"$SCRIPT_DIR/sync-convex-env.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/load-local-env.sh"
"$SCRIPT_DIR/ensure-convex-functions.sh"

echo "[2/5] Stopping background sim and all gateways..."
npx convex run rocklaw/god:stopSim >/dev/null 2>&1 || true
"$SCRIPT_DIR/stop-all-agents.sh" >/dev/null 2>&1 || true
stop_agent_process "$AGENT" >/dev/null 2>&1 || true

if [[ "$MODE" == "--fresh" ]]; then
  echo "[3/5] Reinitialising Rocklaw world..."
  npx convex run rocklaw/init:initRocklaw '{"force":true}' >/dev/null
  "$SCRIPT_DIR/reset-agent-session.sh" "$AGENT" "$PROFILE"
else
  echo "[3/5] Keeping current Rocklaw world state..."
  npx convex run rocklaw/init:initRocklaw >/dev/null
fi
npx convex run rocklaw/init:setAllAgentsBlankProfile '{"blankSelf":false}' >/dev/null
npx convex run rocklaw/init:setAgentBlankProfile "{\"agentName\":\"$AGENT_NAME\",\"blankSelf\":$([[ \"$PROFILE\" == \"--blank-self\" ]] && echo true || echo false)}" >/dev/null
npx convex run rocklaw/init:setWorkspaceRoot "{\"rootPath\":\"$ROOT_DIR\"}" >/dev/null

echo "[4/5] Enabling full runtime traces for $AGENT..."
mkdir -p "$(dirname "$TRACE_PATH")"
: > "$TRACE_PATH"
: > "$TICK_DEBUG_PATH"
configure_debug_observability "$CONFIG_PATH"

echo "[5/5] Starting $AGENT in background..."
cd "$AGENT_DIR"
nohup zeroclaw --config-dir "$AGENT_DIR" gateway start > "$LOG_PATH" 2>&1 < /dev/null &
echo $! > "$PID_PATH"
wait_for_url "http://127.0.0.1:${GATEWAY_PORT}/health" 30 1

echo ""
echo "Agent lab ready."
echo "Agent:     $AGENT_NAME"
echo "Provider:  $(provider_from_config "$CONFIG_PATH")"
echo "Model:     $(model_from_config "$CONFIG_PATH")"
echo "Gateway:   http://127.0.0.1:${GATEWAY_PORT}"
echo "Log file:  $LOG_PATH"
echo "Trace:     $TRACE_PATH"
echo "Tick log:  $TICK_DEBUG_PATH"
echo ""
echo "Next commands:"
echo "  Tick once:      npm run tick:agent -- $AGENT"
echo "  Peek state:     npm run peek:agent -- $AGENT"
echo "  Tail log:       npm run tail:agent -- $AGENT"
