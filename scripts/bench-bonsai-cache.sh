#!/usr/bin/env bash

set -euo pipefail

BASE_URL="${BONSAI_BASE_URL:-http://127.0.0.1:8080}"
MODEL="${BONSAI_MODEL:-Bonsai-8B.gguf}"
RUNS="${BONSAI_RUNS:-5}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: required command not found: $1" >&2
    exit 1
  fi
}

require_cmd curl
require_cmd python3

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

write_payload() {
  local path=$1
  local system_prompt=$2
  local user_prompt=$3
  python3 - "$path" "$MODEL" "$system_prompt" "$user_prompt" <<'PY'
import json
import sys

path, model, system_prompt, user_prompt = sys.argv[1:5]
payload = {
    "model": model,
    "messages": [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ],
    "temperature": 0.5,
    "top_p": 0.85,
    "top_k": 20,
}
with open(path, "w", encoding="utf-8") as f:
    json.dump(payload, f)
PY
}

print_response_summary() {
  local run_index=$1
  local response=$2
  python3 - "$run_index" "$response" <<'PY'
import json
import sys

run_index = sys.argv[1]
resp = json.loads(sys.argv[2])
timings = resp.get("timings") or {}
choice = ((resp.get("choices") or [{}])[0].get("message") or {}).get("content", "")
choice = choice.replace("\n", "\\n")
print(
    f"run {run_index} | "
    f"cache_n={timings.get('cache_n')} | "
    f"prompt_n={timings.get('prompt_n')} | "
    f"prompt_ms={timings.get('prompt_ms')} | "
    f"prompt_tps={timings.get('prompt_per_second')} | "
    f"gen_tps={timings.get('predicted_per_second')} | "
    f"reply={choice[:120]}"
)
PY
}

run_case() {
  local label=$1
  local payload_path=$2

  echo
  echo "== $label =="
  for ((i = 1; i <= RUNS; i++)); do
    local response
    response="$(curl -sS "$BASE_URL/v1/chat/completions" \
      -H 'Content-Type: application/json' \
      --data @"$payload_path")"
    print_response_summary "$i" "$response"
  done
}

write_payload \
  "$tmp_dir/identical.json" \
  "You are concise." \
  "Reply with exactly: bonsai server works"

run_case "Identical Prompt Reuse" "$tmp_dir/identical.json"

echo
echo "== Stable Prefix, Changing Tail =="
for ((i = 1; i <= RUNS; i++)); do
  write_payload \
    "$tmp_dir/tail.json" \
    "You are concise. Keep the same structure." \
    "Village state:
- forge needs coal
- bakery needs grain
- inn needs meal

Tick note $i: tell me one short action choice."

  response="$(curl -sS "$BASE_URL/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    --data @"$tmp_dir/tail.json")"
  print_response_summary "$i" "$response"
done

write_payload \
  "$tmp_dir/big.json" \
  "You are a village agent in Rocklaw. Read the situation and answer with one short line only." \
  "Day 12, dawn.
Location: forge
Inventory: 7 coal, 3 iron_ore, 2 bread, 20c
Village shortages: tool, axe, knife, meal
Possible valid actions now:
- chat: Marcus Hale
- move: bakery, farm, market
- work: horseshoe, tool, knife, iron_ingot
- eat: bread
- say

Recent notes:
- Marcus has been offering coal aggressively.
- The forge is running but inputs are tight.
- Food pressure is rising across the village.
- The innkeeper is trying to stabilize meals.
- The merchant is probing for repeat customers.

Return one short recommendation."

run_case "Large Prompt Reuse" "$tmp_dir/big.json"

echo
echo "== Large Prompt, Changing Tail =="
for ((i = 1; i <= RUNS; i++)); do
  write_payload \
    "$tmp_dir/big-tail.json" \
    "You are a village agent in Rocklaw. Read the situation and answer with one short line only." \
    "Day 12, dawn.
Location: forge
Inventory: 7 coal, 3 iron_ore, 2 bread, 20c
Village shortages: tool, axe, knife, meal
Possible valid actions now:
- chat: Marcus Hale
- move: bakery, farm, market
- work: horseshoe, tool, knife, iron_ingot
- eat: bread
- say

Recent notes:
- Marcus has been offering coal aggressively.
- The forge is running but inputs are tight.
- Food pressure is rising across the village.
- The innkeeper is trying to stabilize meals.
- The merchant is probing for repeat customers.

Tick note $i: one detail changed here. Return one short recommendation."

  response="$(curl -sS "$BASE_URL/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    --data @"$tmp_dir/big-tail.json")"
  print_response_summary "$i" "$response"
done
