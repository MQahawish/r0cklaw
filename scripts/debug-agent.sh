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

AGENT=${1:-}
MODE=${2:---continue}

if [[ -z "$AGENT" ]]; then
  echo "Usage: $0 <agent-slug> [--continue|--fresh]"
  exit 1
fi

if [[ "$MODE" != "--continue" && "$MODE" != "--fresh" ]]; then
  echo "Usage: $0 <agent-slug> [--continue|--fresh]"
  exit 1
fi

AGENT_DIR="$ROOT_DIR/agents/$AGENT"
CONFIG_PATH="$AGENT_DIR/config.toml"
TRACE_PATH="$AGENT_DIR/workspace/state/runtime-trace.jsonl"
TICK_DEBUG_PATH="$AGENT_DIR/workspace/state/tick-debug.jsonl"
AGENT_NAME="$(agent_slug_to_name "$AGENT")"

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

echo "[1/5] Starting self-hosted Convex backend..."
docker compose up -d backend dashboard
wait_for_url "http://127.0.0.1:3210/version"
"$SCRIPT_DIR/sync-convex-env.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/load-local-env.sh"
"$SCRIPT_DIR/ensure-convex-functions.sh"

echo "[2/5] Stopping background sim and gateways..."
npx convex run rocklaw/god:stopSim >/dev/null 2>&1 || true
"$SCRIPT_DIR/stop-all-agents.sh" >/dev/null 2>&1 || true

if [[ "$MODE" == "--fresh" ]]; then
  echo "[3/5] Reinitialising Rocklaw world..."
  npx convex run rocklaw/init:initRocklaw '{"force":true}' >/dev/null
  "$SCRIPT_DIR/reset-agent-session.sh" "$AGENT"
else
  echo "[3/5] Keeping current Rocklaw world state..."
  npx convex run rocklaw/init:initRocklaw >/dev/null
fi
npx convex run rocklaw/init:setWorkspaceRoot "{\"rootPath\":\"$ROOT_DIR\"}" >/dev/null

echo "[4/5] Enabling full runtime traces for $AGENT..."
mkdir -p "$(dirname "$TRACE_PATH")"
: > "$TRACE_PATH"
: > "$TICK_DEBUG_PATH"
configure_debug_observability "$CONFIG_PATH"

echo "[5/5] Starting $AGENT in foreground."
echo ""
echo "Single-agent debug commands:"
echo "  Manual tick:"
echo "    npx convex run rocklaw/engine:manualTick '{\"agentName\":\"$AGENT_NAME\"}'"
echo "  Latest runtime traces:"
echo "    zeroclaw --config-dir \"$AGENT_DIR\" doctor traces --limit 20"
echo "  Tail raw runtime trace file:"
echo "    tail -f \"$TRACE_PATH\""
echo "  Tail Rocklaw tick debug file:"
echo "    tail -f \"$TICK_DEBUG_PATH\""
echo "  Live workspace view:"
echo "    open http://127.0.0.1:5173/ai-town"
echo ""

exec "$SCRIPT_DIR/start-agent.sh" "$AGENT"
