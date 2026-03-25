#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.local"

set_env_var() {
  local key=$1
  local value=$2
  local file=$3

  python3 - "$file" "$key" "$value" <<'PY'
from pathlib import Path
import sys
import shlex

path = Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]
rendered = f"{key}={shlex.quote(value)}"

lines = path.read_text().splitlines() if path.exists() else []
updated = []
replaced = False
for line in lines:
    if line.startswith(f"{key}="):
        updated.append(rendered)
        replaced = True
    else:
        updated.append(line)

if not replaced:
    updated.append(rendered)

path.write_text("\n".join(updated) + "\n")
PY
}

BACKEND_URL="http://127.0.0.1:3210"
ADMIN_KEY="$(
  docker compose exec -T backend ./generate_admin_key.sh \
    | tr -d '\r' \
    | grep '^convex-self-hosted|' \
    | head -n 1
)"

if [[ -z "$ADMIN_KEY" ]]; then
  echo "Error: failed to obtain Convex admin key from backend"
  exit 1
fi

touch "$ENV_FILE"
set_env_var "CONVEX_SELF_HOSTED_ADMIN_KEY" "$ADMIN_KEY" "$ENV_FILE"
set_env_var "CONVEX_SELF_HOSTED_URL" "$BACKEND_URL" "$ENV_FILE"
set_env_var "VITE_CONVEX_URL" "$BACKEND_URL" "$ENV_FILE"

echo "Synced self-hosted Convex credentials into $ENV_FILE"
