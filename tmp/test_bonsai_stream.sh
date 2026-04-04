#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RENDERER="$ROOT_DIR/tmp/show_bonsai_stream.py"

curl -Ns http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"Bonsai-8B.gguf","stream":true,"messages":[{"role":"system","content":"Think carefully before answering. Keep the final answer short."},{"role":"user","content":"If a shop sells 3 apples for $5 and 8 apples for $12, which deal is better per apple, and by how much?"}],"temperature":0,"top_p":1,"top_k":0}' \
  | python3 "$RENDERER"
