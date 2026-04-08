#!/usr/bin/env bash
# Start a ZeroClaw gateway instance for a Rocklaw villager.
#
# Usage:
#   ./scripts/start-agent.sh elena
#   ./scripts/start-agent.sh marcus
#
# Requires:
#   - zeroclaw binary in PATH (built from /home/user/zeroclaw)
#   - OPENROUTER_API_KEY set in environment

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# Load ignored local env files so OPENROUTER_API_KEY does not need manual export.
# shellcheck disable=SC1091
source "$SCRIPT_DIR/load-local-env.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/provider-env.sh"

AGENT=${1:-elena}
AGENTS_DIR="$ROOT_DIR/agents"
AGENT_DIR="$AGENTS_DIR/$AGENT"
ZEROCLAW_BIN="${ROCKLAW_ZEROCLAW_BIN:-$ROOT_DIR/.rocklaw/bin/zeroclaw}"
if [[ ! -x "$ZEROCLAW_BIN" ]]; then
  ZEROCLAW_BIN="$(command -v zeroclaw)"
fi

if [[ ! -d "$AGENT_DIR" ]]; then
  echo "Error: No agent directory found at $AGENT_DIR"
  echo "Available agents: $(ls "$AGENTS_DIR" | tr '\n' ' ')"
  exit 1
fi

CONFIG_PATH="$AGENT_DIR/config.toml"

if ! provider_credentials_ok "$CONFIG_PATH"; then
  echo "Error: provider credentials are not configured for $AGENT."
  provider_credentials_message "$CONFIG_PATH"
  exit 1
fi

LOG_FILE="/tmp/zeroclaw-$AGENT.log"
PROVIDER="$(provider_from_config "$CONFIG_PATH")"
MODEL="$(model_from_config "$CONFIG_PATH")"

echo "Starting ZeroClaw gateway for: $AGENT"
echo "Config dir: $AGENT_DIR"
echo "Provider:   ${PROVIDER:-unknown}"
echo "Model:      ${MODEL:-unknown}"
echo "Log:        $LOG_FILE"
echo ""

# Run from agent dir so relative workspace_dir resolves correctly.
# --config-dir points zeroclaw at the directory containing config.toml.
cd "$AGENT_DIR"
ZEROCLAW_DISABLE_PROVIDER_STREAMING=1 exec "$ZEROCLAW_BIN" --config-dir "$AGENT_DIR" gateway start 2>&1 | tee "$LOG_FILE"
