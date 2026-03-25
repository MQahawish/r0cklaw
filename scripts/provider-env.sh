#!/usr/bin/env bash

set -euo pipefail

provider_from_config() {
  local config_path=$1
  sed -n 's/^default_provider[[:space:]]*=[[:space:]]*"\(.*\)"$/\1/p' "$config_path" | head -n1
}

model_from_config() {
  local config_path=$1
  sed -n 's/^default_model[[:space:]]*=[[:space:]]*"\(.*\)"$/\1/p' "$config_path" | head -n1
}

config_has_explicit_api_key() {
  local config_path=$1
  [[ -n "$(sed -n 's/^api_key[[:space:]]*=[[:space:]]*"\(.*\)"$/\1/p' "$config_path" | head -n1)" ]]
}

provider_env_candidates() {
  local provider=${1,,}

  case "$provider" in
    openrouter) echo "OPENROUTER_API_KEY ZEROCLAW_API_KEY API_KEY" ;;
    openai) echo "OPENAI_API_KEY ZEROCLAW_API_KEY API_KEY" ;;
    anthropic) echo "ANTHROPIC_API_KEY ANTHROPIC_OAUTH_TOKEN ZEROCLAW_API_KEY API_KEY" ;;
    gemini|google|google-gemini) echo "GEMINI_API_KEY GOOGLE_API_KEY ZEROCLAW_API_KEY API_KEY" ;;
    groq) echo "GROQ_API_KEY ZEROCLAW_API_KEY API_KEY" ;;
    mistral) echo "MISTRAL_API_KEY ZEROCLAW_API_KEY API_KEY" ;;
    xai|grok) echo "XAI_API_KEY ZEROCLAW_API_KEY API_KEY" ;;
    deepseek) echo "DEEPSEEK_API_KEY ZEROCLAW_API_KEY API_KEY" ;;
    together|together-ai) echo "TOGETHER_API_KEY ZEROCLAW_API_KEY API_KEY" ;;
    fireworks|fireworks-ai) echo "FIREWORKS_API_KEY ZEROCLAW_API_KEY API_KEY" ;;
    cohere) echo "COHERE_API_KEY ZEROCLAW_API_KEY API_KEY" ;;
    perplexity) echo "PERPLEXITY_API_KEY ZEROCLAW_API_KEY API_KEY" ;;
    venice) echo "VENICE_API_KEY ZEROCLAW_API_KEY API_KEY" ;;
    openrouter|openai|anthropic|gemini|google|google-gemini|groq|mistral|xai|grok|deepseek|together|together-ai|fireworks|fireworks-ai|cohere|perplexity|venice) ;;
    ollama|lmstudio|lm-studio|llamacpp|llama.cpp|sglang|vllm|osaurus) echo "" ;;
    custom:*|anthropic-custom:*) echo "ZEROCLAW_API_KEY API_KEY" ;;
    *) echo "ZEROCLAW_API_KEY API_KEY" ;;
  esac
}

provider_credentials_ok() {
  local config_path=$1
  local provider
  provider=$(provider_from_config "$config_path")

  if config_has_explicit_api_key "$config_path"; then
    return 0
  fi

  local vars
  vars=$(provider_env_candidates "$provider")
  if [[ -z "$vars" ]]; then
    return 0
  fi

  local var
  for var in $vars; do
    if [[ -n "${!var:-}" ]]; then
      return 0
    fi
  done

  return 1
}

provider_credentials_message() {
  local config_path=$1
  local provider
  provider=$(provider_from_config "$config_path")
  local vars
  vars=$(provider_env_candidates "$provider")

  if [[ -z "$vars" ]]; then
    echo "Provider '$provider' does not require an API key for local mode."
  else
    echo "Provider '$provider' needs one of: $vars"
  fi
}
