#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

AGENT=${1:-}
MODE="--continue"
AUTO_TICKS=0

if [[ -z "$AGENT" || "$AGENT" == "--help" || "$AGENT" == "-h" ]]; then
  echo "Usage: $0 <agent-slug> [--continue|--fresh] [--auto <ticks>]"
  exit 1
fi

shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      echo "Usage: $0 <agent-slug> [--continue|--fresh] [--auto <ticks>]"
      exit 0
      ;;
    --continue|--fresh)
      MODE="$1"
      shift
      ;;
    --auto)
      if [[ $# -lt 2 || ! "$2" =~ ^[0-9]+$ ]]; then
        echo "Usage: $0 <agent-slug> [--continue|--fresh] [--auto <ticks>]"
        exit 1
      fi
      AUTO_TICKS="$2"
      shift 2
      ;;
    *)
      echo "Usage: $0 <agent-slug> [--continue|--fresh] [--auto <ticks>]"
      exit 1
      ;;
  esac
done

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

  if [[ "$tick_count" -le "$AUTO_TICKS" ]]; then
    echo "Auto-continue (${tick_count}/${AUTO_TICKS})"
    continue
  fi

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
