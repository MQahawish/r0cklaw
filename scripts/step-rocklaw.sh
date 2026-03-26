#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MODE="--continue"
PROFILE="--seeded"
AUTO_TICKS=0

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
    --auto)
      if [[ $# -lt 2 || ! "$2" =~ ^[0-9]+$ ]]; then
        echo "Usage: $0 [--continue|--fresh] [--seeded|--blank-self] [--auto <ticks>]"
        exit 1
      fi
      AUTO_TICKS="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: $0 [--continue|--fresh] [--seeded|--blank-self] [--auto <ticks>]"
      exit 0
      ;;
    *)
      echo "Usage: $0 [--continue|--fresh] [--seeded|--blank-self] [--auto <ticks>]"
      exit 1
      ;;
  esac
done

cd "$ROOT_DIR"

"$SCRIPT_DIR/lab-rocklaw.sh" "$MODE" "$PROFILE"

tick_count=0

while true; do
  tick_count=$((tick_count + 1))
  echo ""
  echo "=== World Tick $tick_count ==="
  npx convex run rocklaw/engine:manualTick
  echo ""
  node "$SCRIPT_DIR/watch-rocklaw-step.mjs"
  echo ""

  if [[ "$tick_count" -le "$AUTO_TICKS" ]]; then
    echo "Auto-continue (${tick_count}/${AUTO_TICKS})"
    continue
  fi

  read -r -p "Continue to next world tick? [Y/n] " reply
  case "${reply:-y}" in
    y|Y|yes|YES|"")
      continue
      ;;
    n|N|no|NO|q|Q|quit|QUIT|stop|STOP)
      echo "Stopped interactive world tick loop. Rocklaw lab is still running."
      echo "Use 'npm run stop:rocklaw' when you want to shut everything down."
      exit 0
      ;;
    *)
      echo "Unrecognized input. Continuing."
      ;;
  esac
done
