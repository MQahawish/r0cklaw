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

echo "Rocklaw local services stopped."
