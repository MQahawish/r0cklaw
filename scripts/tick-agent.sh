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
BEFORE_TICK=""

if [[ -f "$TICK_DEBUG" ]]; then
  BEFORE_LINES="$(wc -l < "$TICK_DEBUG" | tr -d ' ')"
fi

print_terminal_summary() {
  local jsonl="$1"
  JSONL_INPUT="$jsonl" node - <<'NODE'
const raw = process.env.JSONL_INPUT ?? "";
const lines = raw.split("\n").filter(Boolean);
let terminal = null;
for (const line of lines) {
  try {
    const parsed = JSON.parse(line);
    if (["completed", "transport_failed", "parse_failed", "invalid_action"].includes(parsed.phase)) {
      terminal = parsed;
    }
  } catch {
    // ignore malformed lines
  }
}

if (!terminal) {
  process.exit(0);
}

const action = terminal?.parsedAction?.action ?? null;
const focus =
  terminal?.parsedAction?.location ??
  terminal?.parsedAction?.target ??
  terminal?.parsedAction?.item ??
  null;
const qty = typeof terminal?.parsedAction?.quantity === "number" && terminal.parsedAction.quantity > 1
  ? ` x${terminal.parsedAction.quantity}`
  : "";
const decision = action ? `${action}${focus ? ` -> ${focus}` : ""}${qty}` : "(no parsed action)";
const outcome = terminal?.validation?.outcome ?? terminal?.phase ?? "unknown";
const note = terminal?.validation?.note ?? terminal?.error ?? "";

console.log(`decision: ${decision}`);
console.log(`status: ${outcome}${note ? ` | ${note}` : ""}`);
NODE
}

get_step_state() {
  local raw
  raw="$(npx convex run rocklaw/observe:getStepSummary 2>/dev/null || true)"
  if [[ -z "$raw" ]]; then
    return 1
  fi

  SUMMARY_RAW="$raw" AGENT_NAME="$AGENT_NAME" node - <<'NODE'
const raw = process.env.SUMMARY_RAW ?? "";
const agentName = process.env.AGENT_NAME ?? "";

function extractJsonPayload(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

const parsed = extractJsonPayload(raw);
if (!parsed || typeof parsed.tick !== "number") {
  process.exit(1);
}

const agent = Array.isArray(parsed.agents)
  ? parsed.agents.find((entry) => entry?.name === agentName)
  : null;

const payload = {
  tick: parsed.tick,
  busy: Boolean(agent?.busy),
  busyLabel: typeof agent?.busyLabel === "string" ? agent.busyLabel : "",
};

process.stdout.write(JSON.stringify(payload));
NODE
}

if STEP_STATE="$(get_step_state)"; then
  BEFORE_TICK="$(STEP_STATE="$STEP_STATE" node -p 'JSON.parse(process.env.STEP_STATE).tick')"
fi

npx convex run rocklaw/engine:manualTick "{\"agentName\":\"$AGENT_NAME\"}"

echo "Waiting for persisted tick result..."
for _ in $(seq 1 120); do
  if [[ -f "$TICK_DEBUG" ]]; then
    AFTER_LINES="$(wc -l < "$TICK_DEBUG" | tr -d ' ')"
    if [[ "$AFTER_LINES" -gt "$BEFORE_LINES" ]]; then
      NEW_LINES="$(tail -n +"$((BEFORE_LINES + 1))" "$TICK_DEBUG")"
      if grep -Eq '"phase":"(completed|transport_failed|parse_failed|invalid_action)"' <<<"$NEW_LINES"; then
        print_terminal_summary "$NEW_LINES"
        exit 0
      fi
    fi
  fi

  if [[ -n "$BEFORE_TICK" ]] && STEP_STATE="$(get_step_state)"; then
    STEP_TICK="$(STEP_STATE="$STEP_STATE" node -p 'JSON.parse(process.env.STEP_STATE).tick')"
    if [[ "$STEP_TICK" -gt "$BEFORE_TICK" ]]; then
      STEP_BUSY="$(STEP_STATE="$STEP_STATE" node -p 'JSON.parse(process.env.STEP_STATE).busy ? "true" : "false"')"
      STEP_BUSY_LABEL="$(STEP_STATE="$STEP_STATE" node -p 'JSON.parse(process.env.STEP_STATE).busyLabel || ""')"
      if [[ "$STEP_BUSY" == "true" && -n "$STEP_BUSY_LABEL" ]]; then
        echo "No new ZeroClaw turn persisted; world advanced to tick $STEP_TICK and $AGENT_NAME is $STEP_BUSY_LABEL."
      else
        echo "No new ZeroClaw turn persisted; world advanced to tick $STEP_TICK."
      fi
      exit 0
    fi
  fi

  sleep 1
done

echo "Timed out waiting for tick-debug completion in $TICK_DEBUG" >&2
exit 1
