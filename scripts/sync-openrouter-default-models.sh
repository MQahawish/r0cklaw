#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck disable=SC1091
source "$SCRIPT_DIR/provider-env.sh"

if [[ "${ROCKLAW_SYNC_OPENROUTER_DEFAULTS:-1}" == "0" ]]; then
  exit 0
fi

selection_json="$(node "$SCRIPT_DIR/select-openrouter-free-models.mjs" 24 2>/dev/null || true)"
if [[ -z "$selection_json" ]]; then
  echo "Warning: could not fetch OpenRouter recommended models; keeping current config defaults."
  exit 0
fi

selected_model="$(
  SELECTION_JSON="$selection_json" node -e "const payload = JSON.parse(process.env.SELECTION_JSON || '{}'); process.stdout.write(String(payload.selected || ''));"
)"

if [[ -z "$selected_model" ]]; then
  echo "Warning: OpenRouter model selection did not return a default model; keeping current config defaults."
  exit 0
fi

updated=0
for config_path in "$ROOT_DIR"/agents/*/config.toml; do
  [[ -f "$config_path" ]] || continue
  if [[ "$(provider_from_config "$config_path")" != "openrouter" ]]; then
    continue
  fi

  if grep -q '^default_model[[:space:]]*=' "$config_path"; then
    sed -i "s|^default_model[[:space:]]*=.*$|default_model = \"$selected_model\"|" "$config_path"
  else
    printf 'default_model = "%s"\n%s' "$selected_model" "$(cat "$config_path")" > "$config_path"
  fi
  updated=1
done

if [[ "$updated" -eq 1 ]]; then
  echo "Synced OpenRouter default model: $selected_model"
fi
