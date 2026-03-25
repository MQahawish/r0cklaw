#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

AGENT=${1:-}

if [[ -z "$AGENT" ]]; then
  echo "Usage: $0 <agent-slug>"
  exit 1
fi

WORKSPACE="$ROOT_DIR/agents/$AGENT/workspace"

if [[ ! -d "$WORKSPACE" ]]; then
  echo "Error: workspace not found for $AGENT at $WORKSPACE"
  exit 1
fi

AGENT_NAME="$(python3 - <<'PY' "$AGENT"
import sys
slug = sys.argv[1]
parts = slug.replace('-', ' ').split()
print(' '.join(p.capitalize() for p in parts))
PY
)"

mkdir -p \
  "$WORKSPACE/self/messages/inbox" \
  "$WORKSPACE/self/messages/outbox" \
  "$WORKSPACE/world" \
  "$WORKSPACE/state" \
  "$WORKSPACE/memory" \
  "$WORKSPACE/sessions"

chmod -R a+rwX "$WORKSPACE/self" "$WORKSPACE/world" "$WORKSPACE/state" "$WORKSPACE/memory" "$WORKSPACE/sessions" 2>/dev/null || true

rotate_dir() {
  local dir_path=$1
  if [[ -e "$dir_path" ]]; then
    local stale_path="${dir_path}.stale.$(date +%s)"
    mv "$dir_path" "$stale_path" 2>/dev/null || true
  fi
}

rotate_dir "$WORKSPACE/self/messages/inbox"
rotate_dir "$WORKSPACE/self/messages/outbox"

find "$WORKSPACE/self/messages" -maxdepth 1 \( -name 'inbox.stale.*' -o -name 'outbox.stale.*' \) -exec rm -rf {} + 2>/dev/null || true

mkdir -p \
  "$WORKSPACE/self/messages/inbox" \
  "$WORKSPACE/self/messages/outbox"

rm -f \
  "$WORKSPACE/sessions/sessions.db" \
  "$WORKSPACE/sessions/sessions.db-shm" \
  "$WORKSPACE/sessions/sessions.db-wal" \
  "$WORKSPACE/memory/brain.db" \
  "$WORKSPACE/memory/brain.db-shm" \
  "$WORKSPACE/memory/brain.db-wal" \
  "$WORKSPACE/state/runtime-trace.jsonl" \
  "$WORKSPACE/state/tick-debug.jsonl" \
  "$WORKSPACE/state/memory_hygiene_state.json" \
  "$WORKSPACE/world/inventory.md" \
  "$WORKSPACE/world/location.md" \
  "$WORKSPACE/world/market_prices.md" \
  "$WORKSPACE/world/status.md" \
  "$WORKSPACE/world/village_news.md" \
  "/tmp/zeroclaw-$AGENT.log"

cat > "$WORKSPACE/06_HEARTBEAT.md" <<EOF
# HEARTBEAT -- $AGENT_NAME

## Recent Activity
- Day 1 morning: [awaiting first tick]
EOF

cat > "$WORKSPACE/self/messages/sent_log.md" <<'EOF'
# Sent Messages Log

No sent messages yet.
EOF

cat > "$WORKSPACE/self/messages/inbox/README.md" <<'EOF'
# Inbox

Incoming letters are reflected in world/location.md under "Letters waiting for you here".
Use this folder only as your personal correspondence archive when needed.
EOF
