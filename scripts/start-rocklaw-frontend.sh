#!/usr/bin/env bash

set -euo pipefail

PORT="${1:-5173}"
HOST="${2:-127.0.0.1}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: required command not found: $1"
    exit 1
  fi
}

wait_until_bindable() {
  local host=$1
  local port=$2
  local retries=${3:-20}
  local delay=${4:-0.5}

  for _ in $(seq 1 "$retries"); do
    if node -e "
      const net = require('net');
      const host = process.argv[1];
      const port = Number(process.argv[2]);
      const server = net.createServer();
      server.once('error', () => process.exit(1));
      server.listen(port, host, () => server.close(() => process.exit(0)));
    " "$host" "$port" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay"
  done

  return 1
}

ensure_port_free() {
  local port=$1
  local pids
  pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
  [[ -n "$pids" ]] || return 0

  echo "Port $port is already in use. Stopping existing listener(s): $pids"
  for pid in $pids; do
    kill "$pid" 2>/dev/null || true
  done

  sleep 1

  pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "Port $port is still occupied. Forcing stop: $pids"
    for pid in $pids; do
      kill -9 "$pid" 2>/dev/null || true
    done
  fi

  lsof -ti tcp:"$port" >/dev/null 2>&1 && return 1
  return 0
}

require_cmd lsof
require_cmd npm
require_cmd node

ensure_port_free "$PORT" || {
  echo "Error: could not free port $PORT before frontend start"
  exit 1
}
wait_until_bindable "$HOST" "$PORT" || {
  echo "Error: port $PORT is not bindable on $HOST after cleanup"
  exit 1
}

if npm run dev:frontend -- --host "$HOST" --port "$PORT" --strictPort; then
  exit 0
fi

echo "Frontend failed to bind port $PORT on first attempt. Retrying once..."
ensure_port_free "$PORT" || {
  echo "Error: could not free port $PORT for retry"
  exit 1
}
wait_until_bindable "$HOST" "$PORT" || {
  echo "Error: port $PORT is not bindable on $HOST before retry"
  exit 1
}

exec npm run dev:frontend -- --host "$HOST" --port "$PORT" --strictPort
