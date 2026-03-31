#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

AGENT=""
MODE="--continue"
PROFILE="--seeded"
AUTO_TICKS=0
VERBOSE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      echo "Usage: $0 <agent-slug> [--continue|--fresh] [--seeded|--blank-self] [--auto <ticks>] [--verbose]"
      exit 0
      ;;
    --continue|--fresh)
      MODE="$1"
      shift
      ;;
    --seeded|--blank-self)
      PROFILE="$1"
      shift
      ;;
    --auto)
      if [[ $# -lt 2 || ! "$2" =~ ^[0-9]+$ ]]; then
        echo "Usage: $0 <agent-slug> [--continue|--fresh] [--seeded|--blank-self] [--auto <ticks>]"
        exit 1
      fi
      AUTO_TICKS="$2"
      shift 2
      ;;
    --verbose)
      VERBOSE=1
      shift
      ;;
    *)
      if [[ -z "$AGENT" ]]; then
        AGENT="$1"
        shift
      else
        echo "Usage: $0 <agent-slug> [--continue|--fresh] [--seeded|--blank-self] [--auto <ticks>] [--verbose]"
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$AGENT" ]]; then
  echo "Usage: $0 <agent-slug> [--continue|--fresh] [--seeded|--blank-self] [--auto <ticks>] [--verbose]"
  exit 1
fi

cd "$ROOT_DIR"

"$SCRIPT_DIR/lab-agent.sh" "$AGENT" "$MODE" "$PROFILE"

tick_count=0

while true; do
  tick_count=$((tick_count + 1))
  echo ""
  echo "=== Tick $tick_count ==="
  "$SCRIPT_DIR/tick-agent.sh" "$AGENT"
  echo ""
  if [[ "$VERBOSE" -eq 1 ]]; then
    node "$SCRIPT_DIR/watch-agent.mjs" "$AGENT" --once
  else
    node "$SCRIPT_DIR/step-agent-summary.mjs" "$AGENT"
  fi
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
