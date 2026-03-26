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
      echo "Usage: $0 [--continue|--fresh] [--seeded|--blank-self]"
      exit 0
      ;;
    *)
      echo "Usage: $0 [--continue|--fresh] [--seeded|--blank-self]"
      exit 1
      ;;
  esac
done

cd "$ROOT_DIR"

missing_credentials=0
for config_path in "$ROOT_DIR"/agents/*/config.toml; do
  if ! provider_credentials_ok "$config_path"; then
    echo "Error: missing credentials for $(basename "$(dirname "$config_path")")."
    provider_credentials_message "$config_path"
    missing_credentials=1
  fi
done
if [[ "$missing_credentials" -ne 0 ]]; then
  echo "Set the required provider keys in .env.local or .env.rocklaw.local."
  exit 1
fi

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

if [[ "$MODE" == "--fresh" ]]; then
  echo "[3/5] Reinitialising Rocklaw world..."
  npx convex run rocklaw/init:initRocklaw '{"force":true}' >/dev/null
  for config_path in "$ROOT_DIR"/agents/*/config.toml; do
    "$SCRIPT_DIR/reset-agent-session.sh" "$(basename "$(dirname "$config_path")")" "$PROFILE"
  done
else
  echo "[3/5] Keeping current Rocklaw world state..."
  npx convex run rocklaw/init:initRocklaw >/dev/null
fi
npx convex run rocklaw/init:setAllAgentsBlankProfile "{\"blankSelf\":$([[ \"$PROFILE\" == \"--blank-self\" ]] && echo true || echo false)}" >/dev/null
npx convex run rocklaw/init:setWorkspaceRoot "{\"rootPath\":\"$ROOT_DIR\"}" >/dev/null

echo "[4/5] Preparing all agent runtime traces..."
for agent_dir in "$ROOT_DIR"/agents/*; do
  agent_slug="$(basename "$agent_dir")"
  config_path="$agent_dir/config.toml"
  trace_path="$agent_dir/workspace/state/runtime-trace.jsonl"
  tick_debug_path="$agent_dir/workspace/state/tick-debug.jsonl"
  mkdir -p "$(dirname "$trace_path")"
  : > "$trace_path"
  : > "$tick_debug_path"
  configure_debug_observability "$config_path"
done

echo "[5/5] Starting all agents in background..."
"$SCRIPT_DIR/start-all-agents.sh" >/dev/null
wait_for_url "http://127.0.0.1:42617/health" 30 1

echo ""
echo "Rocklaw world lab ready."
echo "Mode:      ${MODE#--}"
echo "Profile:   ${PROFILE#--}"
echo "Agents:    elena marcus finn lena sera aldric cora rook"
echo "Backend:   http://127.0.0.1:3210"
echo "Frontend:  http://127.0.0.1:5173/ai-town"
echo ""
echo "Next commands:"
echo "  Step world:     npm run step:rocklaw -- ${MODE}"
echo "  Manual world:   npx convex run rocklaw/engine:manualTick"
echo "  Stop stack:     npm run stop:rocklaw"
