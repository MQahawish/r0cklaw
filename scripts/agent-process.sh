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

agent_pid_matches() {
  local pid=$1
  local agent=$2
  local args=''
  local comm=''

  comm="$(ps -p "$pid" -o comm= 2>/dev/null | awk '{print $1}' || true)"
  [[ "$comm" == "zeroclaw" ]] || return 1
  args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  [[ -n "$args" ]] || return 1
  grep -Eq "$(agent_pattern "$agent")" <<<"$args"
}

agent_running_pid() {
  local agent=$1
  local pid_file
  pid_file="$(agent_pid_file "$agent")"

  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && agent_pid_matches "$pid" "$agent"; then
      echo "$pid"
      return 0
    fi
    rm -f "$pid_file"
  fi

  local found=''
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    if agent_pid_matches "$pid" "$agent"; then
      found="$pid"
      break
    fi
  done < <(pgrep -x zeroclaw || true)

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
