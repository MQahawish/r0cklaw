#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MODE=${1:---continue}

if [[ "$MODE" != "--continue" && "$MODE" != "--fresh" ]]; then
  echo "Usage: $0 [--continue|--fresh]"
  exit 1
fi

cd "$ROOT_DIR"

"$SCRIPT_DIR/lab-rocklaw.sh" "$MODE"

tick_count=0

while true; do
  tick_count=$((tick_count + 1))
  echo ""
  echo "=== World Tick $tick_count ==="
  npx convex run rocklaw/engine:manualTick
  echo ""
  node "$SCRIPT_DIR/watch-rocklaw-step.mjs"
  echo ""
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
