#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

AGENT=${1:-}
PROFILE=${2:---seeded}

if [[ -z "$AGENT" ]]; then
  echo "Usage: $0 <agent-slug> [--seeded|--blank-self]"
  exit 1
fi

if [[ "$PROFILE" != "--seeded" && "$PROFILE" != "--blank-self" ]]; then
  echo "Usage: $0 <agent-slug> [--seeded|--blank-self]"
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
  "$WORKSPACE/state/seeded_docs" \
  "$WORKSPACE/state/seeded_skills" \
  "$WORKSPACE/memory" \
  "$WORKSPACE/sessions"

chmod -R a+rwX "$WORKSPACE/self" "$WORKSPACE/world" "$WORKSPACE/state" "$WORKSPACE/memory" "$WORKSPACE/sessions" 2>/dev/null || true

backup_seeded_doc() {
  local file_name=$1
  local src="$WORKSPACE/$file_name"
  local backup="$WORKSPACE/state/seeded_docs/$file_name"
  if [[ -f "$src" && ! -f "$backup" ]]; then
    cp "$src" "$backup"
  fi
}

restore_seeded_doc() {
  local file_name=$1
  local src="$WORKSPACE/state/seeded_docs/$file_name"
  local dst="$WORKSPACE/$file_name"
  if [[ -f "$src" ]]; then
    cp "$src" "$dst"
  fi
}

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

backup_seeded_doc "IDENTITY.md"
backup_seeded_doc "SOUL.md"
backup_seeded_doc "AGENTS.md"
backup_seeded_doc "TOOLS.md"

while IFS= read -r skill_file; do
  rel="${skill_file#$WORKSPACE/skills/}"
  backup="$WORKSPACE/state/seeded_skills/$rel"
  mkdir -p "$(dirname "$backup")"
  if [[ ! -f "$backup" ]]; then
    cp "$skill_file" "$backup"
  fi
done < <(find "$WORKSPACE/skills" -type f -name 'SKILL.md' 2>/dev/null | sort)

if [[ "$PROFILE" == "--seeded" ]]; then
  restore_seeded_doc "IDENTITY.md"
  restore_seeded_doc "SOUL.md"
  restore_seeded_doc "AGENTS.md"
  restore_seeded_doc "TOOLS.md"
fi

cat > "$WORKSPACE/HEARTBEAT.md" <<EOF
# HEARTBEAT -- $AGENT_NAME

## Recent Activity
- Day 1 morning: [awaiting first tick]
EOF

if [[ "$PROFILE" == "--blank-self" ]]; then
  find "$WORKSPACE/self" -type f \
    ! -path "$WORKSPACE/self/messages/inbox/README.md" \
    -delete 2>/dev/null || true

  cat > "$WORKSPACE/MEMORY.md" <<EOF
# Memory -- $AGENT_NAME

## Things I know to be true

- None yet.

## Events that mattered

- None yet.

## People

- None yet.
EOF

  cat > "$WORKSPACE/self/goals.md" <<EOF
# Goals -- $AGENT_NAME

What I am working toward this week:
  - Nothing defined yet.
EOF

  cat > "$WORKSPACE/self/plans.md" <<EOF
# Plans -- $AGENT_NAME

Specific upcoming intentions:
  - Nothing defined yet.
EOF

  python3 - <<'PY' "$WORKSPACE" "$AGENT_NAME"
import pathlib
import re
import sys

workspace = pathlib.Path(sys.argv[1])
agent_name = sys.argv[2]

aliases = {
    "Elena Voss": ["Elena Voss", "Elena"],
    "Marcus Hale": ["Marcus Hale", "Marcus"],
    "Finn": ["Finn"],
    "Lena Marsh": ["Lena Marsh", "Lena"],
    "Sera": ["Sera"],
    "Brother Aldric": ["Brother Aldric", "Aldric"],
    "Cora": ["Cora"],
    "Old Rook": ["Old Rook", "Rook"],
}

other_patterns = []
for name, forms in aliases.items():
    if name == agent_name:
      continue
    other_patterns.extend(forms)

pattern = re.compile("|".join(re.escape(name) for name in other_patterns))

for filename in ("IDENTITY.md", "SOUL.md"):
    path = workspace / filename
    if not path.exists():
        continue
    lines = path.read_text(encoding="utf-8").splitlines()
    kept = []
    for line in lines:
        if line.startswith("# "):
            kept.append(line)
            continue
        if pattern.search(line):
            continue
        kept.append(line)
    text = "\n".join(kept).strip() + "\n"
    path.write_text(text, encoding="utf-8")
PY
fi

restore_seeded_doc "AGENTS.md"
restore_seeded_doc "TOOLS.md"

cat > "$WORKSPACE/self/messages/sent_log.md" <<'EOF'
# Sent Messages Log

No sent messages yet.
EOF

cat > "$WORKSPACE/self/messages/inbox/README.md" <<'EOF'
# Inbox

Incoming letters are reflected in world/location.md under "Letters waiting for you here".
Use this folder only as your personal correspondence archive when needed.
EOF
