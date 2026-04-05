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

is_frontend_ready() {
  curl -fsS "http://127.0.0.1:5173/ai-town" >/dev/null 2>&1
}

ensure_port_free() {
  local port=$1
  local pids
  pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
  [[ -n "$pids" ]] || return 0

  echo "Port $port is already in use. Stopping existing listener(s): $pids"
  for pid in $pids; do
    kill "$pid" 2>/dev/null || true
  done

  sleep 1

  pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "Port $port is still occupied. Forcing stop: $pids"
    for pid in $pids; do
      kill -9 "$pid" 2>/dev/null || true
    done
  fi

  if lsof -ti tcp:"$port" >/dev/null 2>&1; then
    echo "Error: could not free port $port"
    exit 1
  fi
}

require_cmd docker
require_cmd curl
require_cmd zeroclaw
require_cmd npx
require_cmd lsof
"$SCRIPT_DIR/ensure-agent-workspace-perms.sh"

cd "$ROOT_DIR"
export HOST_UID="${HOST_UID:-$(id -u)}"
export HOST_GID="${HOST_GID:-$(id -g)}"

RESET_MODE="fresh"
PROFILE="--blank-self"
AUTO_START_SIM=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fresh)
      RESET_MODE="fresh"
      shift
      ;;
    --continue)
      RESET_MODE="continue"
      shift
      ;;
    --blank-self|--seeded)
      PROFILE="$1"
      shift
      ;;
    --start-sim)
      AUTO_START_SIM=1
      shift
      ;;
    *)
      echo "Usage: $0 [--continue|--fresh] [--blank-self|--seeded] [--start-sim]"
      exit 1
      ;;
  esac
done

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
    "$SCRIPT_DIR/reset-agent-session.sh" "$(basename "$(dirname "$config_path")")" "$PROFILE"
  done
else
  echo "[3/6] Ensuring Rocklaw world exists (continuing current state)..."
  npx convex run rocklaw/init:initRocklaw >/dev/null
  for config_path in "$ROOT_DIR"/agents/*/config.toml; do
    [[ -f "$config_path" ]] || continue
    "$SCRIPT_DIR/reset-agent-session.sh" "$(basename "$(dirname "$config_path")")" "$PROFILE"
  done
fi
npx convex run rocklaw/init:setAllAgentsBlankProfile "{\"blankSelf\":$([[ \"$PROFILE\" == \"--blank-self\" ]] && echo true || echo false)}" >/dev/null
npx convex run rocklaw/init:setWorkspaceRoot "{\"rootPath\":\"$ROOT_DIR\"}" >/dev/null

echo "[4/6] Stopping Rocklaw simulation..."
npx convex run rocklaw/god:stopSim >/dev/null 2>&1 || true
if [[ "$AUTO_START_SIM" -eq 1 ]]; then
  echo "        Auto-start enabled; restarting Rocklaw simulation..."
  npx convex run rocklaw/god:startSim >/dev/null
fi

echo "[5/6] Launching frontend + Convex log tail..."
ensure_port_free 5173
echo "Frontend: http://127.0.0.1:5173"
echo "Convex:   http://127.0.0.1:3210"
echo "Dashboard:http://127.0.0.1:6791"
echo "Mode:     $RESET_MODE"
echo "Profile:  $([[ "$PROFILE" == "--blank-self" ]] && echo blank-self || echo seeded)"
echo "Sim:      $([[ "$AUTO_START_SIM" -eq 1 ]] && echo auto-start || echo stopped)"
echo ""

if is_frontend_ready; then
  echo "Frontend on 5173 is already running; reusing existing dev server."
  exec npm run dev:backend
fi

exec npx concurrently "npm run dev:backend" "bash $SCRIPT_DIR/start-rocklaw-frontend.sh 5173 127.0.0.1"
