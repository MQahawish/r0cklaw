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
# shellcheck disable=SC1091
source "$SCRIPT_DIR/agent-process.sh"

ALL_AGENTS=(elena marcus finn lena sera)
SELECTED_AGENTS=("${ALL_AGENTS[@]}")
MODE="--continue"
PROFILE="--seeded"
AUTO_TICKS=0
PROVIDER_PRESET="keep"
LOCAL_API_URL="http://127.0.0.1:8090/v1"
LOCAL_MODEL="Qwen3-4B-Q4_K_M"
FALLBACK_MODEL=""
FALLBACK_PROVIDER="openrouter"
OPENROUTER_FREE_SELECTED_MODEL=""
OPENROUTER_FREE_CANDIDATES_JSON=""

usage() {
  cat <<'EOF'
Usage: ./scripts/run-rocklaw.sh [options]

Options:
  --fresh | --continue          Reset the Rocklaw world or keep current state
  --blank-self | --seeded       Blank mutable self-state or keep seeded self-state
  --agents <all|slug[,slug...]> Run all agents, one agent, or a subset
  --provider <preset>           keep | local | openrouter-free | openrouter-gemini-flash | openrouter-gemini-pro | openrouter-gpt41-mini | openai-mini | openai-main
  --fallback-model <model-id>   Paid fallback model for --provider openrouter-free
  --fallback-provider <name>    Provider for the fallback model (default: openrouter)
  --auto <ticks>                Automatically run N world ticks after startup
  --help                        Show this help

Examples:
  ./scripts/run-rocklaw.sh --fresh --blank-self
  ./scripts/run-rocklaw.sh --fresh --blank-self --agents elena --provider local --auto 6
  ./scripts/run-rocklaw.sh --fresh --agents elena,finn --provider openrouter-gemini-flash --auto 4
  ./scripts/run-rocklaw.sh --fresh --provider openrouter-free --fallback-model google/gemini-2.5-flash
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: required command not found: $1"
    exit 1
  fi
}

is_valid_agent() {
  local needle=${1,,}
  local agent
  for agent in "${ALL_AGENTS[@]}"; do
    if [[ "$agent" == "$needle" ]]; then
      return 0
    fi
  done
  return 1
}

parse_selected_agents() {
  local raw=${1,,}
  if [[ "$raw" == "all" ]]; then
    SELECTED_AGENTS=("${ALL_AGENTS[@]}")
    return 0
  fi

  local parsed=()
  local seen=" "
  local item
  IFS=',' read -r -A items <<<"$raw"
  for item in "${items[@]}"; do
    item="${item// /}"
    [[ -n "$item" ]] || continue
    if ! is_valid_agent "$item"; then
      echo "Error: unknown agent slug '$item'"
      exit 1
    fi
    if [[ "$seen" != *" $item "* ]]; then
      parsed+=("$item")
      seen+="$(printf '%s ' "$item")"
    fi
  done

  if [[ "${#parsed[@]}" -eq 0 ]]; then
    echo "Error: no valid agents were selected."
    exit 1
  fi

  SELECTED_AGENTS=("${parsed[@]}")
}

provider_preset_label() {
  case "$1" in
    keep) echo "Keep current provider/model settings" ;;
    local) echo "Local llama.cpp -> $LOCAL_MODEL via proxy" ;;
    openai-mini) echo "OpenAI Codex auth -> gpt-5.4-mini" ;;
    openai-main) echo "OpenAI Codex auth -> gpt-5.4" ;;
    openrouter-free) echo "OpenRouter -> best free tools-capable model with paid fallback" ;;
    openrouter-gemini-flash) echo "OpenRouter -> google/gemini-2.5-flash" ;;
    openrouter-gemini-pro) echo "OpenRouter -> google/gemini-2.5-pro" ;;
    openrouter-gpt41-mini) echo "OpenRouter -> openai/gpt-4.1-mini" ;;
    *) echo "$1" ;;
  esac
}

agent_display_name() {
  case "$1" in
    elena) echo "Elena Voss" ;;
    marcus) echo "Marcus Hale" ;;
    finn) echo "Finn" ;;
    lena) echo "Lena Marsh" ;;
    sera) echo "Sera" ;;
    *)
      echo "Error: unknown agent slug '$1'" >&2
      exit 1
      ;;
  esac
}

prepare_openrouter_free_selection() {
  if [[ -z "$FALLBACK_MODEL" ]]; then
    echo "Error: --fallback-model is required when --provider openrouter-free is used."
    exit 1
  fi

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

set_config_api_url() {
  local config_path=$1
  local api_url=${2:-}

  if [[ -n "$api_url" ]]; then
    if grep -q '^api_url[[:space:]]*=' "$config_path"; then
      sed -i "s|^api_url[[:space:]]*=.*$|api_url = \"$api_url\"|" "$config_path"
    else
      perl -0pi -e "s/^(default_model\\s*=.*\\n)/\$1api_url = \"$api_url\"\\n/" "$config_path"
    fi
  else
    perl -0pi -e 's/^api_url\s*=.*\n//mg' "$config_path"
  fi
}

apply_provider_preset() {
  local preset=$1
  local provider=""
  local model=""
  local api_url=""

  case "$preset" in
    keep)
      return 0
      ;;
    local)
      provider="llamacpp"
      model="$LOCAL_MODEL"
      api_url="$LOCAL_API_URL"
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

  local agent config_path
  for agent in "${SELECTED_AGENTS[@]}"; do
    config_path="$ROOT_DIR/agents/$agent/config.toml"
    "$SCRIPT_DIR/set-agent-provider.sh" "$agent" "$provider" "$model" >/dev/null
    set_config_api_url "$config_path" "$api_url"
  done
}

provider_is_local() {
  local provider=${1,,}
  case "$provider" in
    llamacpp|llama.cpp|ollama|lmstudio|lm-studio|sglang|vllm|osaurus)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

selected_agents_need_local_stack() {
  local agent config_path provider
  for agent in "${SELECTED_AGENTS[@]}"; do
    config_path="$ROOT_DIR/agents/$agent/config.toml"
    provider="$(provider_from_config "$config_path")"
    if provider_is_local "$provider"; then
      return 0
    fi
  done
  return 1
}

ensure_local_llama_stack() {
  if ! curl -fsS "http://127.0.0.1:8080/v1/models" >/dev/null 2>&1; then
    echo "Error: local llama-server is not reachable at http://127.0.0.1:8080/v1/models"
    echo "Start llama-server first, then retry."
    exit 1
  fi

  if ! curl -fsS "http://127.0.0.1:8090/v1/models" >/dev/null 2>&1; then
    echo "Error: llama-proxy is not reachable at http://127.0.0.1:8090/v1/models"
    echo "Start the proxy with: npm run llama:proxy"
    exit 1
  fi
}

selected_agent_names_json() {
  AGENTS_CSV="$(IFS=,; echo "${SELECTED_AGENTS[*]}")" python3 - <<'PY'
import json
import os

mapping = {
    "elena": "Elena Voss",
    "marcus": "Marcus Hale",
    "finn": "Finn",
    "lena": "Lena Marsh",
    "sera": "Sera",
}

slugs = [part for part in os.environ["AGENTS_CSV"].split(",") if part]
print(json.dumps([mapping[slug] for slug in slugs]))
PY
}

manual_tick_with_summary() {
  local tick_index=$1
  local tick_output
  local tick_log_line
  local active_agents
  echo ""
  echo "=== World Tick $tick_index ==="
  tick_output="$(npx convex run rocklaw/engine:manualTick 2>&1)"
  tick_log_line="$(printf '%s\n' "$tick_output" | grep -F "[engine] manualTick" | tail -n 1 || true)"
  active_agents="$(TICK_OUTPUT="$tick_output" python3 - <<'PY'
import os, re
text = os.environ.get("TICK_OUTPUT", "")
m = re.search(r"agents:\s*\[(.*?)\]", text, re.S)
if not m:
    print("")
else:
    names = [part.strip().strip("'\"") for part in m.group(1).split(",") if part.strip()]
    print(",".join(names))
PY
)"
  [[ -n "$tick_log_line" ]] && echo "$tick_log_line"
  ROCKLAW_ACTIVE_AGENTS="$active_agents" node "$SCRIPT_DIR/watch-rocklaw-step.mjs"
}

prompt_for_more_ticks() {
  local next_tick_index=$1
  local response=""

  while true; do
    echo ""
    printf 'Continue with more ticks? [enter=stop, y=1, number=batch size]: '
    IFS= read -r response || return 0

    response="${response// /}"
    if [[ -z "$response" || "$response" == "n" || "$response" == "N" ]]; then
      return 0
    fi

    if [[ "$response" == "y" || "$response" == "Y" ]]; then
      manual_tick_with_summary "$next_tick_index"
      next_tick_index=$((next_tick_index + 1))
      continue
    fi

    if [[ "$response" =~ ^[0-9]+$ && "$response" -gt 0 ]]; then
      local count
      for count in $(seq 1 "$response"); do
        manual_tick_with_summary "$next_tick_index"
        next_tick_index=$((next_tick_index + 1))
      done
      continue
    fi

    echo "Enter nothing to stop, 'y' for one more tick, or a positive number for another batch."
  done
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fresh|--continue)
      MODE="$1"
      shift
      ;;
    --blank-self|--seeded)
      PROFILE="$1"
      shift
      ;;
    --agents)
      if [[ $# -lt 2 ]]; then
        usage
        exit 1
      fi
      parse_selected_agents "$2"
      shift 2
      ;;
    --provider)
      if [[ $# -lt 2 ]]; then
        usage
        exit 1
      fi
      PROVIDER_PRESET="$2"
      shift 2
      ;;
    --fallback-model)
      if [[ $# -lt 2 ]]; then
        usage
        exit 1
      fi
      FALLBACK_MODEL="$2"
      shift 2
      ;;
    --fallback-provider)
      if [[ $# -lt 2 ]]; then
        usage
        exit 1
      fi
      FALLBACK_PROVIDER="$2"
      shift 2
      ;;
    --auto)
      if [[ $# -lt 2 || ! "$2" =~ ^[0-9]+$ ]]; then
        usage
        exit 1
      fi
      AUTO_TICKS="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage
      exit 1
      ;;
  esac
done

require_cmd docker
require_cmd curl
require_cmd node
require_cmd zeroclaw
require_cmd npx
require_cmd perl
require_cmd python3
"$SCRIPT_DIR/ensure-agent-workspace-perms.sh"

cd "$ROOT_DIR"
export HOST_UID="${HOST_UID:-$(id -u)}"
export HOST_GID="${HOST_GID:-$(id -g)}"

apply_provider_preset "$PROVIDER_PRESET"

if selected_agents_need_local_stack; then
  ensure_local_llama_stack
fi

missing_credentials=0
for agent in "${SELECTED_AGENTS[@]}"; do
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

echo "Using provider preset: $(provider_preset_label "$PROVIDER_PRESET")"
echo "Agents: ${SELECTED_AGENTS[*]}"
echo ""

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
npx convex run init '{"numAgents":0}' >/dev/null

echo "[2/5] Stopping background sim and all gateways..."
npx convex run rocklaw/god:stopSim >/dev/null 2>&1 || true
"$SCRIPT_DIR/stop-all-agents.sh" >/dev/null 2>&1 || true

if [[ "$MODE" == "--fresh" ]]; then
  echo "[3/5] Reinitialising Rocklaw world..."
  agent_names_json="$(selected_agent_names_json)"
  npx convex run rocklaw/init:initRocklaw "{\"force\":true,\"agentNames\":$agent_names_json}" >/dev/null
  for agent in "${SELECTED_AGENTS[@]}"; do
    "$SCRIPT_DIR/reset-agent-session.sh" "$agent" "$PROFILE"
  done
else
  echo "[3/5] Keeping current Rocklaw world state..."
  npx convex run rocklaw/init:initRocklaw >/dev/null
fi

npx convex run rocklaw/init:setAllAgentsBlankProfile '{"blankSelf":false}' >/dev/null
for agent in "${SELECTED_AGENTS[@]}"; do
  agent_name="$(agent_slug_to_name "$agent")"
  npx convex run rocklaw/init:setAgentBlankProfile "{\"agentName\":\"$agent_name\",\"blankSelf\":$([[ \"$PROFILE\" == \"--blank-self\" ]] && echo true || echo false)}" >/dev/null
done
npx convex run rocklaw/init:setWorkspaceRoot "{\"rootPath\":\"$ROOT_DIR\"}" >/dev/null

if [[ "$PROVIDER_PRESET" == "openrouter-free" ]]; then
  candidates_json_escaped="$(OPENROUTER_FREE_CANDIDATES_JSON="$OPENROUTER_FREE_CANDIDATES_JSON" python3 - <<'PY'
import json, os
print(json.dumps(os.environ["OPENROUTER_FREE_CANDIDATES_JSON"]))
PY
)"
  for agent in "${SELECTED_AGENTS[@]}"; do
    agent_name="$(agent_slug_to_name "$agent")"
    npx convex run rocklaw/godNode:configureOpenRouterFreeAgent "{\"agentName\":\"$agent_name\",\"currentModel\":\"$OPENROUTER_FREE_SELECTED_MODEL\",\"fallbackModel\":\"$FALLBACK_MODEL\",\"fallbackProvider\":\"$FALLBACK_PROVIDER\",\"candidatesJson\":$candidates_json_escaped}" >/dev/null
  done
elif [[ "$PROVIDER_PRESET" != "keep" ]]; then
  for agent in "${SELECTED_AGENTS[@]}"; do
    agent_name="$(agent_slug_to_name "$agent")"
    npx convex run rocklaw/godNode:clearOpenRouterFreeAgent "{\"agentName\":\"$agent_name\"}" >/dev/null
  done
fi

echo "[4/5] Preparing selected agent runtime traces..."
for agent in "${SELECTED_AGENTS[@]}"; do
  agent_dir="$ROOT_DIR/agents/$agent"
  config_path="$agent_dir/config.toml"
  trace_path="$agent_dir/workspace/state/runtime-trace.jsonl"
  tick_debug_path="$agent_dir/workspace/state/tick-debug.jsonl"
  mkdir -p "$(dirname "$trace_path")"
  : > "$trace_path"
  : > "$tick_debug_path"
  configure_debug_observability "$config_path"
done

echo "[5/5] Starting selected agents in background..."
for agent in "${SELECTED_AGENTS[@]}"; do
  agent_dir="$ROOT_DIR/agents/$agent"
  config_path="$agent_dir/config.toml"
  log_path="$(agent_log_file "$agent")"
  pid_path="$(agent_pid_file "$agent")"
  gateway_port="$(sed -n 's/^port[[:space:]]*=[[:space:]]*\([0-9][0-9]*\)$/\1/p' "$config_path" | head -n1)"

  cd "$agent_dir"
  nohup zeroclaw --config-dir "$agent_dir" gateway start > "$log_path" 2>&1 < /dev/null &
  echo $! > "$pid_path"
  wait_for_url "http://127.0.0.1:${gateway_port}/health" 30 1
done

cd "$ROOT_DIR"

echo ""
echo "Rocklaw run ready."
echo "Mode:      ${MODE#--}"
echo "Profile:   ${PROFILE#--}"
echo "Agents:    ${SELECTED_AGENTS[*]}"
echo "Provider:  $(provider_preset_label "$PROVIDER_PRESET")"
echo "Backend:   http://127.0.0.1:3210"
echo "Frontend:  http://127.0.0.1:5173/ai-town"

if [[ "$AUTO_TICKS" -gt 0 ]]; then
  for tick_index in $(seq 1 "$AUTO_TICKS"); do
    manual_tick_with_summary "$tick_index"
  done
  echo ""
  echo "Auto-run complete."
  prompt_for_more_ticks "$((AUTO_TICKS + 1))"
else
  echo ""
  echo "Next commands:"
  echo "  Step world:     npx convex run rocklaw/engine:manualTick"
  echo "  Watch step:     node ./scripts/watch-rocklaw-step.mjs"
  if [[ "${#SELECTED_AGENTS[@]}" -eq 1 ]]; then
    echo "  Tick agent:     npm run tick:agent -- ${SELECTED_AGENTS[0]}"
  fi
fi
