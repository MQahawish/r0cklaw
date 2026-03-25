#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

"$SCRIPT_DIR/stop-rocklaw-local.sh"

echo "Removing self-hosted Convex containers and local volume data..."
docker compose down -v >/dev/null 2>&1 || true

echo "Rocklaw local state cleared."
