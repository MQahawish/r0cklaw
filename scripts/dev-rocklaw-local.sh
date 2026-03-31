#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck disable=SC1091
source "$SCRIPT_DIR/load-local-env.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/provider-env.sh"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: required command not found: $1"
    exit 1
  fi
}

wait_for_url() {
  local url=$1
  local retries=${2:-30}
  local delay=${3:-1}

  for _ in $(seq 1 "$retries"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay"
  done

  echo "Error: timed out waiting for $url"
  exit 1
}

require_cmd docker
require_cmd curl
require_cmd zeroclaw
require_cmd npx
"$SCRIPT_DIR/ensure-agent-workspace-perms.sh"

cd "$ROOT_DIR"
export HOST_UID="${HOST_UID:-$(id -u)}"
export HOST_GID="${HOST_GID:-$(id -g)}"

RESET_MODE="continue"
if [[ "${1:-}" == "--fresh" ]]; then
  RESET_MODE="fresh"
elif [[ "${1:-}" == "--continue" || -z "${1:-}" ]]; then
  RESET_MODE="continue"
else
  echo "Usage: $0 [--continue|--fresh]"
  exit 1
fi

missing_credentials=0
for config_path in "$ROOT_DIR"/agents/*/config.toml; do
  [[ -f "$config_path" ]] || continue
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

echo "[1/6] Starting self-hosted Convex backend..."
docker compose up -d backend dashboard
wait_for_url "http://127.0.0.1:3210/version"
"$SCRIPT_DIR/sync-convex-env.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/load-local-env.sh"
"$SCRIPT_DIR/ensure-convex-functions.sh"

echo "[2/6] Starting ZeroClaw agent gateways..."
"$SCRIPT_DIR/stop-all-agents.sh" >/dev/null 2>&1 || true
"$SCRIPT_DIR/start-all-agents.sh"
wait_for_url "http://127.0.0.1:42617/health"

if [[ "$RESET_MODE" == "fresh" ]]; then
  echo "[3/6] Reinitialising Rocklaw world from scratch..."
  npx convex run rocklaw/init:initRocklaw '{"force":true}' >/dev/null
  for config_path in "$ROOT_DIR"/agents/*/config.toml; do
    [[ -f "$config_path" ]] || continue
    "$SCRIPT_DIR/reset-agent-session.sh" "$(basename "$(dirname "$config_path")")"
  done
else
  echo "[3/6] Ensuring Rocklaw world exists (continuing current state)..."
  npx convex run rocklaw/init:initRocklaw >/dev/null
fi
npx convex run rocklaw/init:setWorkspaceRoot "{\"rootPath\":\"$ROOT_DIR\"}" >/dev/null

echo "[4/6] Restarting Rocklaw simulation..."
npx convex run rocklaw/god:stopSim >/dev/null 2>&1 || true
npx convex run rocklaw/god:startSim >/dev/null

echo "[5/6] Launching frontend + Convex log tail..."
echo "Frontend: http://127.0.0.1:5173"
echo "Convex:   http://127.0.0.1:3210"
echo "Dashboard:http://127.0.0.1:6791"
echo "Mode:     $RESET_MODE"
echo ""

exec npx npm-run-all --parallel dev:backend dev:frontend
