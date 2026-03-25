#!/usr/bin/env bash

set -euo pipefail

agent_pid_file() {
  echo "/tmp/zeroclaw-$1.pid"
}

agent_log_file() {
  echo "/tmp/zeroclaw-$1.log"
}

agent_pattern() {
  echo "zeroclaw --config-dir .*/agents/$1 gateway start"
}

agent_running_pid() {
  local agent=$1
  local pid_file
  pid_file="$(agent_pid_file "$agent")"

  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
  fi

  local found
  found="$(pgrep -af "$(agent_pattern "$agent")" | awk 'NR==1 {print $1}')"
  if [[ -n "$found" ]]; then
    echo "$found" > "$pid_file"
    echo "$found"
    return 0
  fi

  return 1
}

stop_agent_process() {
  local agent=$1
  local pid_file
  pid_file="$(agent_pid_file "$agent")"
  local pid=''

  if pid="$(agent_running_pid "$agent" 2>/dev/null)"; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
    echo "$pid"
    return 0
  fi

  rm -f "$pid_file"
  return 1
}
