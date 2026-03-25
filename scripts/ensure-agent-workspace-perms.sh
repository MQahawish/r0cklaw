#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

find "$ROOT_DIR/agents" -type d -exec chmod a+rwx {} + 2>/dev/null || true
find "$ROOT_DIR/agents" -type f -exec chmod a+rw {} + 2>/dev/null || true
