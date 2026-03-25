#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/agent-lib.sh"

AGENT=${1:-}

if [[ -z "$AGENT" ]]; then
  echo "Usage: $0 <agent-slug>"
  exit 1
fi

AGENT_NAME="$(agent_slug_to_name "$AGENT")"
TICK_DEBUG="$ROOT_DIR/agents/$AGENT/workspace/state/tick-debug.jsonl"
BEFORE_LINES=0

if [[ -f "$TICK_DEBUG" ]]; then
  BEFORE_LINES="$(wc -l < "$TICK_DEBUG" | tr -d ' ')"
fi

npx convex run rocklaw/engine:manualTick "{\"agentName\":\"$AGENT_NAME\"}"

echo "Waiting for persisted tick result..."
for _ in $(seq 1 120); do
  if [[ -f "$TICK_DEBUG" ]]; then
    AFTER_LINES="$(wc -l < "$TICK_DEBUG" | tr -d ' ')"
    if [[ "$AFTER_LINES" -gt "$BEFORE_LINES" ]]; then
      NEW_LINES="$(tail -n +"$((BEFORE_LINES + 1))" "$TICK_DEBUG")"
      if grep -Eq '"phase":"(completed|transport_failed|parse_failed|invalid_action)"' <<<"$NEW_LINES"; then
        echo "$NEW_LINES" | tail -n 5
        exit 0
      fi
    fi
  fi
  sleep 1
done

echo "Timed out waiting for tick-debug completion in $TICK_DEBUG" >&2
exit 1
