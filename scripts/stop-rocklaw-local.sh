#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

echo "[1/3] Stopping Rocklaw simulation..."
npx convex run rocklaw/god:stopSim >/dev/null 2>&1 || true

echo "[2/3] Stopping ZeroClaw agent gateways..."
"$SCRIPT_DIR/stop-all-agents.sh" || true

echo "[3/3] Stopping self-hosted Convex services..."
docker compose stop backend dashboard >/dev/null 2>&1 || true

if command -v lsof >/dev/null 2>&1; then
  frontend_pids="$(lsof -ti tcp:5173 2>/dev/null || true)"
  if [[ -n "${frontend_pids:-}" ]]; then
    echo "Stopping frontend listener(s) on port 5173: $frontend_pids"
    for pid in $frontend_pids; do
      kill "$pid" 2>/dev/null || true
    done
  fi
fi

echo "Rocklaw local services stopped."
