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

AGENT=${1:-elena}
AGENTS_DIR="$(cd "$(dirname "$0")/.." && pwd)/agents"
AGENT_DIR="$AGENTS_DIR/$AGENT"

if [[ ! -d "$AGENT_DIR" ]]; then
  echo "Error: No agent directory found at $AGENT_DIR"
  echo "Available agents: $(ls "$AGENTS_DIR" | tr '\n' ' ')"
  exit 1
fi

if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo "Error: OPENROUTER_API_KEY is not set."
  echo "Export it before running: export OPENROUTER_API_KEY='your-key'"
  exit 1
fi

CONFIG="$AGENT_DIR/config.toml"
LOG_FILE="/tmp/zeroclaw-$AGENT.log"

echo "Starting ZeroClaw gateway for: $AGENT"
echo "Config: $CONFIG"
echo "Log:    $LOG_FILE"
echo ""

# Run zeroclaw gateway from the agent's directory so relative workspace_dir works
cd "$AGENT_DIR"
exec zeroclaw gateway --config "$CONFIG" 2>&1 | tee "$LOG_FILE"
