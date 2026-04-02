#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck disable=SC1091
source "$SCRIPT_DIR/load-local-env.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/provider-env.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/agent-lib.sh"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: required command not found: $1"
    exit 1
  fi
}

require_cmd docker
require_cmd curl
require_cmd node
require_cmd zeroclaw
require_cmd npx
require_cmd perl
"$SCRIPT_DIR/ensure-agent-workspace-perms.sh"

MODE="--continue"
PROFILE="--seeded"
AGENTS=(elena marcus finn lena sera)
PROVIDER_PRESET="keep"
FALLBACK_MODEL=""
FALLBACK_PROVIDER="openrouter"
OPENROUTER_FREE_SELECTED_MODEL=""
OPENROUTER_FREE_CANDIDATES_JSON=""

provider_preset_label() {
  case "$1" in
    keep) echo "Keep current agent provider/model settings" ;;
    openai-mini) echo "OpenAI Codex auth -> gpt-5.4-mini" ;;
    openai-main) echo "OpenAI Codex auth -> gpt-5.4" ;;
    openrouter-free) echo "OpenRouter -> best free tools-capable model with paid fallback" ;;
    openrouter-gemini-flash) echo "OpenRouter -> google/gemini-2.5-flash" ;;
    openrouter-gemini-pro) echo "OpenRouter -> google/gemini-2.5-pro" ;;
    openrouter-gpt41-mini) echo "OpenRouter -> openai/gpt-4.1-mini" ;;
    *) echo "$1" ;;
  esac
}

prepare_openrouter_free_selection() {
  local selection_json
  selection_json="$(node "$SCRIPT_DIR/select-openrouter-free-models.mjs" 8)"
  OPENROUTER_FREE_SELECTED_MODEL="$(SELECTION_JSON="$selection_json" python3 - <<'PY'
import json, os
data = json.loads(os.environ["SELECTION_JSON"])
print(data["selected"])
PY
)"
  OPENROUTER_FREE_CANDIDATES_JSON="$(SELECTION_JSON="$selection_json" python3 - <<'PY'
import json, os
data = json.loads(os.environ["SELECTION_JSON"])
print(json.dumps(data["candidates"]))
PY
)"
}

apply_provider_preset() {
  local preset=$1
  local provider=""
  local model=""

  case "$preset" in
    keep)
      return 0
      ;;
    openai-mini)
      provider="openai-codex"
      model="gpt-5.4-mini"
      ;;
    openai-main)
      provider="openai-codex"
      model="gpt-5.4"
      ;;
    openrouter-free)
      prepare_openrouter_free_selection
      provider="openrouter"
      model="$OPENROUTER_FREE_SELECTED_MODEL"
      ;;
    openrouter-gemini-flash)
      provider="openrouter"
      model="google/gemini-2.5-flash"
      ;;
    openrouter-gemini-pro)
      provider="openrouter"
      model="google/gemini-2.5-pro"
      ;;
    openrouter-gpt41-mini)
      provider="openrouter"
      model="openai/gpt-4.1-mini"
      ;;
    *)
      echo "Error: unknown provider preset: $preset"
      exit 1
      ;;
  esac

  for agent in "${AGENTS[@]}"; do
    "$SCRIPT_DIR/set-agent-provider.sh" "$agent" "$provider" "$model" >/dev/null
  done
}

select_provider_preset() {
  local current_provider current_model
  current_provider=$(provider_from_config "$ROOT_DIR/agents/elena/config.toml")
  current_model=$(model_from_config "$ROOT_DIR/agents/elena/config.toml")

  echo "Choose agent provider/model preset:"
  echo "  1) Keep current ($current_provider / $current_model)"
  echo "  2) $(provider_preset_label openai-mini)"
  echo "  3) $(provider_preset_label openai-main)"
  echo "  4) $(provider_preset_label openrouter-free)"
  echo "  5) $(provider_preset_label openrouter-gemini-flash)"
  echo "  6) $(provider_preset_label openrouter-gemini-pro)"
  echo "  7) $(provider_preset_label openrouter-gpt41-mini)"

  local reply preset
  read -r -p "Preset [1-7, default 1]: " reply
  case "${reply:-1}" in
    1) preset="keep" ;;
    2) preset="openai-mini" ;;
    3) preset="openai-main" ;;
    4) preset="openrouter-free" ;;
    5) preset="openrouter-gemini-flash" ;;
    6) preset="openrouter-gemini-pro" ;;
    7) preset="openrouter-gpt41-mini" ;;
    *)
      echo "Unrecognized preset choice. Keeping current settings."
      preset="keep"
      ;;
  esac

  if [[ "$preset" == "openrouter-free" ]]; then
    read -r -p "Fallback paid model [default google/gemini-2.5-flash]: " FALLBACK_MODEL
    FALLBACK_MODEL="${FALLBACK_MODEL:-google/gemini-2.5-flash}"
  fi

  PROVIDER_PRESET="$preset"
  apply_provider_preset "$preset"
  echo "Using agent preset: $(provider_preset_label "$preset")"
  echo ""
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --continue|--fresh)
      MODE="$1"
      shift
      ;;
    --seeded|--blank-self)
      PROFILE="$1"
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [--continue|--fresh] [--seeded|--blank-self]"
      exit 0
      ;;
    *)
      echo "Usage: $0 [--continue|--fresh] [--seeded|--blank-self]"
      exit 1
      ;;
  esac
done

cd "$ROOT_DIR"
export HOST_UID="${HOST_UID:-$(id -u)}"
export HOST_GID="${HOST_GID:-$(id -g)}"

if [[ -t 0 ]]; then
  select_provider_preset
fi

missing_credentials=0
for agent in "${AGENTS[@]}"; do
  config_path="$ROOT_DIR/agents/$agent/config.toml"
  if ! provider_credentials_ok "$config_path"; then
    echo "Error: missing credentials for $agent."
    provider_credentials_message "$config_path"
    missing_credentials=1
  fi
done
if [[ "$missing_credentials" -ne 0 ]]; then
  echo "Set the required provider keys in .env.local or .env.rocklaw.local."
  exit 1
fi

echo "[1/5] Starting self-hosted Rocklaw stack..."
if [[ "$MODE" == "--fresh" ]]; then
  docker compose down -v >/dev/null 2>&1 || true
fi
docker compose up -d backend dashboard frontend
wait_for_url "http://127.0.0.1:3210/version"
wait_for_url "http://127.0.0.1:5173"
"$SCRIPT_DIR/sync-convex-env.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/load-local-env.sh"
"$SCRIPT_DIR/ensure-convex-functions.sh"
echo "Ensuring base AI Town world/map exists for the frontend..."
npx convex run init '{"numAgents":0}' >/dev/null

echo "[2/5] Stopping background sim and all gateways..."
npx convex run rocklaw/god:stopSim >/dev/null 2>&1 || true
"$SCRIPT_DIR/stop-all-agents.sh" >/dev/null 2>&1 || true

if [[ "$MODE" == "--fresh" ]]; then
  echo "[3/5] Reinitialising Rocklaw world..."
  npx convex run rocklaw/init:initRocklaw '{"force":true}' >/dev/null
  for agent in "${AGENTS[@]}"; do
    "$SCRIPT_DIR/reset-agent-session.sh" "$agent" "$PROFILE"
  done
else
  echo "[3/5] Keeping current Rocklaw world state..."
  npx convex run rocklaw/init:initRocklaw >/dev/null
fi
npx convex run rocklaw/init:setAllAgentsBlankProfile "{\"blankSelf\":$([[ \"$PROFILE\" == \"--blank-self\" ]] && echo true || echo false)}" >/dev/null
npx convex run rocklaw/init:setWorkspaceRoot "{\"rootPath\":\"$ROOT_DIR\"}" >/dev/null

if [[ "$PROVIDER_PRESET" == "openrouter-free" ]]; then
  candidates_json_escaped="$(OPENROUTER_FREE_CANDIDATES_JSON="$OPENROUTER_FREE_CANDIDATES_JSON" python3 - <<'PY'
import json, os
print(json.dumps(os.environ["OPENROUTER_FREE_CANDIDATES_JSON"]))
PY
)"
  for agent in "${AGENTS[@]}"; do
    agent_name="$(agent_slug_to_name "$agent")"
    npx convex run rocklaw/godNode:configureOpenRouterFreeAgent "{\"agentName\":\"$agent_name\",\"currentModel\":\"$OPENROUTER_FREE_SELECTED_MODEL\",\"fallbackModel\":\"$FALLBACK_MODEL\",\"fallbackProvider\":\"$FALLBACK_PROVIDER\",\"candidatesJson\":$candidates_json_escaped}" >/dev/null
  done
elif [[ "$PROVIDER_PRESET" != "keep" ]]; then
  for agent in "${AGENTS[@]}"; do
    agent_name="$(agent_slug_to_name "$agent")"
    npx convex run rocklaw/godNode:clearOpenRouterFreeAgent "{\"agentName\":\"$agent_name\"}" >/dev/null
  done
fi

echo "[4/5] Preparing all agent runtime traces..."
for agent_slug in "${AGENTS[@]}"; do
  agent_dir="$ROOT_DIR/agents/$agent_slug"
  config_path="$agent_dir/config.toml"
  trace_path="$agent_dir/workspace/state/runtime-trace.jsonl"
  tick_debug_path="$agent_dir/workspace/state/tick-debug.jsonl"
  mkdir -p "$(dirname "$trace_path")"
  : > "$trace_path"
  : > "$tick_debug_path"
  configure_debug_observability "$config_path"
done

echo "[5/5] Starting all agents in background..."
"$SCRIPT_DIR/start-all-agents.sh" >/dev/null
wait_for_url "http://127.0.0.1:42617/health" 30 1

echo ""
echo "Rocklaw world lab ready."
echo "Mode:      ${MODE#--}"
echo "Profile:   ${PROFILE#--}"
echo "Agents:    elena marcus finn lena sera"
echo "Backend:   http://127.0.0.1:3210"
echo "Frontend:  http://127.0.0.1:5173/ai-town"
echo ""
echo "Next commands:"
echo "  Step world:     npm run step:rocklaw -- ${MODE}"
echo "  Manual world:   npx convex run rocklaw/engine:manualTick"
echo "  Stop stack:     npm run stop:rocklaw"
