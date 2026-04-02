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
canonical = {
    "elena": "Elena Voss",
    "marcus": "Marcus Hale",
    "finn": "Finn",
    "lena": "Lena Marsh",
    "sera": "Sera",
}
if slug in canonical:
    print(canonical[slug])
    raise SystemExit(0)
parts = slug.replace('-', ' ').split()
print(' '.join(p.capitalize() for p in parts))
PY
)"

mkdir -p \
  "$WORKSPACE/state" \
  "$WORKSPACE/memory" \
  "$WORKSPACE/sessions"

chmod -R a+rwX "$WORKSPACE" "$WORKSPACE/state" "$WORKSPACE/memory" "$WORKSPACE/sessions" 2>/dev/null || true

seed_runtime_doc_from_repo() {
  local file_name=$1
  local shared_template_src="$ROOT_DIR/agents/shared/seed_docs/$file_name"
  local template_src="$ROOT_DIR/agents/$AGENT/seed_docs/$file_name"
  local src="$WORKSPACE/$file_name"

  if [[ ( "$file_name" == "TOOLS.md" || "$file_name" == "AGENTS.md" ) && -f "$shared_template_src" ]]; then
    cp "$shared_template_src" "$src"
    return 0
  fi

  if [[ -f "$template_src" ]]; then
    cp "$template_src" "$src"
    return 0
  fi

  if [[ -f "$src" ]]; then
    return 0
  fi

  local repo_path="agents/$AGENT/workspace/$file_name"

  if git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    && git -C "$ROOT_DIR" show "HEAD:$repo_path" >"$src" 2>/dev/null; then
    return 0
  fi
}

sanitize_runtime_doc() {
  local file_name=$1
  local doc_path=$2

  python3 - <<'PY' "$file_name" "$doc_path"
import pathlib
import re
import sys

file_name = sys.argv[1]
path = pathlib.Path(sys.argv[2])

if not path.exists():
    raise SystemExit(0)

text = path.read_text(encoding="utf-8")

if file_name == "AGENTS.md":
    text = re.sub(
        r"\nYou are currently in a live chat scene with .*? end the scene\.\n",
        "\n",
        text,
        flags=re.S,
    )
elif file_name == "TOOLS.md":
    text = re.sub(
        r"\n- `chat`: continue your live chat with .*?never output filler like `\.\.\.` or `waiting for your response`\.\n",
        "\n",
        text,
        flags=re.S,
    )

text = re.sub(r"\n{3,}", "\n\n", text).strip() + "\n"
path.write_text(text, encoding="utf-8")
PY
}

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
  "$WORKSPACE/TURN.md" \
  "$WORKSPACE/JOURNAL.md" \
  "$WORKSPACE/SELF.md" \
  "$WORKSPACE/world/inventory.md" \
  "$WORKSPACE/world/location.md" \
  "$WORKSPACE/world/CHAT.md" \
  "$WORKSPACE/world/OFFERS.md" \
  "$WORKSPACE/world/market_prices.md" \
  "$WORKSPACE/world/status.md" \
  "$WORKSPACE/world/village_news.md" \
  "/tmp/zeroclaw-$AGENT.log"

rm -rf \
  "$WORKSPACE/state/seeded_docs" \
  "$WORKSPACE/state/seeded_skills" \
  "$WORKSPACE/chat" \
  "$WORKSPACE/world/chat" \
  "$WORKSPACE/world" \
  "$WORKSPACE/self" \
  "$WORKSPACE/self/messages"

seed_runtime_doc_from_repo "AGENTS.md"
seed_runtime_doc_from_repo "TOOLS.md"
sanitize_runtime_doc "AGENTS.md" "$WORKSPACE/AGENTS.md"
sanitize_runtime_doc "TOOLS.md" "$WORKSPACE/TOOLS.md"

if [[ "$PROFILE" == "--seeded" ]]; then
  seed_runtime_doc_from_repo "AGENTS.md"
  seed_runtime_doc_from_repo "TOOLS.md"
fi

cat > "$WORKSPACE/HEARTBEAT.md" <<EOF
# HEARTBEAT -- $AGENT_NAME

## Recent Activity
- Day 1 morning: [awaiting first tick]
EOF

cat > "$WORKSPACE/JOURNAL.md" <<EOF
# Journal -- $AGENT_NAME

- No journal entries recorded yet.
EOF

if [[ "$PROFILE" == "--blank-self" ]]; then
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
    path.write_text("\n".join(kept).strip() + "\n", encoding="utf-8")
PY
fi

sanitize_runtime_doc "AGENTS.md" "$WORKSPACE/AGENTS.md"
sanitize_runtime_doc "TOOLS.md" "$WORKSPACE/TOOLS.md"

chmod 666 "$WORKSPACE/HEARTBEAT.md" 2>/dev/null || true
chmod 666 "$WORKSPACE/JOURNAL.md" 2>/dev/null || true
