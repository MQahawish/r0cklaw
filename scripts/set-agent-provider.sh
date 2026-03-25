#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck disable=SC1091
source "$SCRIPT_DIR/provider-env.sh"

AGENT=${1:-}
PROVIDER=${2:-}
MODEL=${3:-}

if [[ -z "$AGENT" || -z "$PROVIDER" ]]; then
  echo "Usage: $0 <agent-slug> <provider> [model]"
  exit 1
fi

CONFIG_PATH="$ROOT_DIR/agents/$AGENT/config.toml"

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "Error: config not found at $CONFIG_PATH"
  exit 1
fi

if grep -q '^default_provider[[:space:]]*=' "$CONFIG_PATH"; then
  sed -i "s|^default_provider[[:space:]]*=.*$|default_provider = \"$PROVIDER\"|" "$CONFIG_PATH"
else
  printf 'default_provider = "%s"\n%s' "$PROVIDER" "$(cat "$CONFIG_PATH")" > "$CONFIG_PATH"
fi

if [[ -n "$MODEL" ]]; then
  if grep -q '^default_model[[:space:]]*=' "$CONFIG_PATH"; then
    sed -i "s|^default_model[[:space:]]*=.*$|default_model = \"$MODEL\"|" "$CONFIG_PATH"
  else
    printf 'default_model = "%s"\n%s' "$MODEL" "$(cat "$CONFIG_PATH")" > "$CONFIG_PATH"
  fi
fi

echo "Updated $AGENT:"
echo "  provider: $(provider_from_config "$CONFIG_PATH")"
echo "  model:    $(model_from_config "$CONFIG_PATH")"
echo "  creds:    $(provider_credentials_message "$CONFIG_PATH")"
