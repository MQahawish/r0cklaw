#!/usr/bin/env bash

set -euo pipefail

agent_slug_to_name() {
  case "${1,,}" in
    elena) echo "Elena Voss" ;;
    marcus) echo "Marcus Hale" ;;
    finn) echo "Finn" ;;
    lena) echo "Lena Marsh" ;;
    sera) echo "Sera" ;;
    aldric) echo "Brother Aldric" ;;
    cora) echo "Cora" ;;
    rook) echo "Old Rook" ;;
    *)
      echo "Error: unknown agent slug '$1'" >&2
      exit 1
      ;;
  esac
}

AGENT=${1:-}

if [[ -z "$AGENT" ]]; then
  echo "Usage: $0 <agent-slug>"
  exit 1
fi

AGENT_NAME="$(agent_slug_to_name "$AGENT")"

exec npx convex run rocklaw/engine:manualTick "{\"agentName\":\"$AGENT_NAME\"}"
