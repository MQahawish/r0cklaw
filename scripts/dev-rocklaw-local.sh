#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck disable=SC1091
source "$SCRIPT_DIR/load-local-env.sh"

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

cd "$ROOT_DIR"

RESET_MODE="continue"
if [[ "${1:-}" == "--fresh" ]]; then
  RESET_MODE="fresh"
elif [[ "${1:-}" == "--continue" || -z "${1:-}" ]]; then
  RESET_MODE="continue"
else
  echo "Usage: $0 [--continue|--fresh]"
  exit 1
fi

if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo "Error: OPENROUTER_API_KEY is not set."
  echo "Put it in .env.local or .env.rocklaw.local, or export it before running."
  exit 1
fi

echo "[1/6] Starting self-hosted Convex backend..."
docker compose up -d backend dashboard
wait_for_url "http://127.0.0.1:3210/version"

echo "[2/6] Starting ZeroClaw agent gateways..."
"$SCRIPT_DIR/stop-all-agents.sh" >/dev/null 2>&1 || true
"$SCRIPT_DIR/start-all-agents.sh"
wait_for_url "http://127.0.0.1:42617/health"

if [[ "$RESET_MODE" == "fresh" ]]; then
  echo "[3/6] Reinitialising Rocklaw world from scratch..."
  npx convex run rocklaw/init:initRocklaw '{"force":true}' >/dev/null
else
  echo "[3/6] Ensuring Rocklaw world exists (continuing current state)..."
  npx convex run rocklaw/init:initRocklaw >/dev/null
fi

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
