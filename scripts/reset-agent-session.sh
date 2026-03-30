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
  "$WORKSPACE/state" \
  "$WORKSPACE/state/seeded_docs" \
  "$WORKSPACE/state/seeded_skills" \
  "$WORKSPACE/memory" \
  "$WORKSPACE/sessions"

chmod -R a+rwX "$WORKSPACE" "$WORKSPACE/state" "$WORKSPACE/memory" "$WORKSPACE/sessions" 2>/dev/null || true

backup_seeded_doc() {
  local file_name=$1
  local src="$WORKSPACE/$file_name"
  local backup="$WORKSPACE/state/seeded_docs/$file_name"
  if [[ -f "$src" ]]; then
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
  "$WORKSPACE/chat" \
  "$WORKSPACE/world/chat" \
  "$WORKSPACE/world" \
  "$WORKSPACE/self" \
  "$WORKSPACE/self/messages"

backup_seeded_doc "IDENTITY.md"
backup_seeded_doc "SOUL.md"
backup_seeded_doc "AGENTS.md"
backup_seeded_doc "TOOLS.md"

while IFS= read -r skill_file; do
  rel="${skill_file#$WORKSPACE/skills/}"
  backup="$WORKSPACE/state/seeded_skills/$rel"
  mkdir -p "$(dirname "$backup")"
  cp "$skill_file" "$backup"
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
  find "$WORKSPACE/self" -type f -delete 2>/dev/null || true

  cat > "$WORKSPACE/MEMORY.md" <<EOF
# Memory -- $AGENT_NAME

## Things I know to be true

- None yet.

## Events that mattered

- None yet.

## People

- None yet.
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

python3 - <<'PY' "$WORKSPACE" "$AGENT_NAME" "$PROFILE"
import pathlib
import shutil
import sys

workspace = pathlib.Path(sys.argv[1])
agent_name = sys.argv[2]
profile = sys.argv[3]
self_dir = workspace / "self"
self_path = workspace / "SELF.md"

def read_section(filename: str) -> str:
    path = self_dir / filename
    if not path.exists():
        return ""
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        return ""
    lines = text.splitlines()
    idx = 0
    while idx < len(lines) and not lines[idx].strip():
        idx += 1
    if idx < len(lines) and lines[idx].startswith("# "):
        idx += 1
    while idx < len(lines) and not lines[idx].strip():
        idx += 1
    return "\n".join(lines[idx:]).strip()

def build_relationships() -> str:
    social_dir = self_dir / "social"
    if not social_dir.exists():
        return "- None yet."
    lines = []
    for entry in sorted([p for p in social_dir.iterdir() if p.is_dir()], key=lambda p: p.name):
        notes = []
        for name in ("private.md", "public.md"):
          file_path = entry / name
          if not file_path.exists():
              continue
          content = file_path.read_text(encoding="utf-8").strip()
          if not content:
              continue
          split = content.splitlines()
          idx = 0
          while idx < len(split) and not split[idx].strip():
              idx += 1
          if idx < len(split) and split[idx].startswith("# "):
              idx += 1
          while idx < len(split) and not split[idx].strip():
              idx += 1
          body = " ".join(line.strip() for line in split[idx:] if line.strip())
          if body:
              notes.append(body)
        if notes:
            lines.append(f"- {entry.name}: {' '.join(notes)}")
    return "\n".join(lines) if lines else "- None yet."

if profile == "--blank-self":
    content = "\n".join([
        f"# Self Context -- {agent_name}",
        "",
        "## Goals",
        "What I am working toward this week:",
        "  - Survive and stay functional.",
        "",
        "## Plans",
        "Specific upcoming intentions:",
        "  - Nothing defined yet.",
        "",
        "## Beliefs",
        "- None yet.",
        "",
        "## Desires",
        "- None yet.",
        "",
        "## Secrets",
        "- None yet.",
        "",
        "## Relevant Relationships",
        "- None yet.",
        "",
    ])
    self_path.write_text(content, encoding="utf-8")
else:
    if not self_path.exists():
        goals = read_section("goals.md") or "What I am working toward this week:\n  - Nothing defined yet."
        plans = read_section("plans.md") or "Specific upcoming intentions:\n  - Nothing defined yet."
        beliefs = read_section("beliefs.md") or "- None yet."
        desires = read_section("desires.md") or "- None yet."
        secrets = read_section("secrets.md") or "- None yet."
        relationships = build_relationships()
        content = "\n".join([
            f"# Self Context -- {agent_name}",
            "",
            "## Goals",
            goals,
            "",
            "## Plans",
            plans,
            "",
            "## Beliefs",
            beliefs,
            "",
            "## Desires",
            desires,
            "",
            "## Secrets",
            secrets,
            "",
            "## Relevant Relationships",
            relationships,
            "",
        ])
        self_path.write_text(content, encoding="utf-8")

for legacy_name in ("goals.md", "plans.md", "beliefs.md", "desires.md", "secrets.md"):
    try:
        (self_dir / legacy_name).unlink()
    except FileNotFoundError:
        pass

social_dir = self_dir / "social"
if social_dir.exists():
    shutil.rmtree(social_dir, ignore_errors=True)
if self_dir.exists():
    shutil.rmtree(self_dir, ignore_errors=True)
PY
