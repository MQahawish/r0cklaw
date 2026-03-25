#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

AGENT=${1:-}
MODE=${2:---continue}

if [[ -z "$AGENT" || "$AGENT" == "--help" || "$AGENT" == "-h" ]]; then
  echo "Usage: $0 <agent-slug> [--continue|--fresh]"
  exit 1
fi

if [[ "$MODE" != "--continue" && "$MODE" != "--fresh" ]]; then
  echo "Usage: $0 <agent-slug> [--continue|--fresh]"
  exit 1
fi

cd "$ROOT_DIR"

"$SCRIPT_DIR/lab-agent.sh" "$AGENT" "$MODE"

tick_count=0

while true; do
  tick_count=$((tick_count + 1))
  echo ""
  echo "=== Tick $tick_count ==="
  "$SCRIPT_DIR/tick-agent.sh" "$AGENT"
  echo ""
  node "$SCRIPT_DIR/watch-agent.mjs" "$AGENT" --once
  echo ""
  read -r -p "Continue to next tick? [Y/n] " reply
  case "${reply:-y}" in
    y|Y|yes|YES|"")
      continue
      ;;
    n|N|no|NO|q|Q|quit|QUIT|stop|STOP)
      echo "Stopped interactive tick loop. Agent lab is still running."
      echo "Use 'npm run stop:rocklaw' when you want to shut everything down."
      exit 0
      ;;
    *)
      echo "Unrecognized input. Continuing."
      ;;
  esac
done
