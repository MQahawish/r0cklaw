#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck disable=SC1091
source "$SCRIPT_DIR/load-local-env.sh"

cd "$ROOT_DIR"

echo "Deploying Convex functions to the local self-hosted backend..."
npx convex deploy -y --typecheck disable --codegen disable >/dev/null
