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

wait_for_url() {
  local url=$1
  local retries=${2:-30}
  local delay=${3:-1}

  for _ in $(seq 1 "$retries"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay"
  done

  echo "Error: timed out waiting for $url"
  exit 1
}

configure_debug_observability() {
  local config_path=$1

  perl -0pi -e 's/\n\[observability\][\s\S]*?(?=\n\[|\z)//g' "$config_path"
  cat >>"$config_path" <<'EOF'

[observability]
backend = "log"
runtime_trace_mode = "full"
runtime_trace_path = "state/runtime-trace.jsonl"
runtime_trace_max_entries = 500
EOF
}
