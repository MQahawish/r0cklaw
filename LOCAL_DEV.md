# Local Rocklaw Ops

Practical commands for running Rocklaw locally with:

- self-hosted Convex in Docker
- ZeroClaw agent gateways on the host
- remote model providers such as OpenRouter, OpenAI, Anthropic, Gemini
- optional local GGUF inference through `llama.cpp`

## Prerequisites

- `docker`
- `npx` / Node dependencies installed
- `zeroclaw` in `PATH`
- provider credentials in an ignored local env file:
  - [`.env.local`](/home/mahmoudqahawish/Github/r0cklaw/.env.local)
  - or [`.env.rocklaw.local`](/home/mahmoudqahawish/Github/r0cklaw/.env.rocklaw.local)

Example:

```env
OPENROUTER_API_KEY=...
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GEMINI_API_KEY=...
```

Only set the keys you actually need.

## Main Commands

Continue current local world:

```bash
npm run dev:rocklaw
```

Start fresh local world:

```bash
npm run dev:rocklaw:fresh
```

Prepare the whole world in the background without starting the continuous sim:

```bash
npm run lab:rocklaw -- --continue
```

Prepare a fresh world and all agent gateways for interactive stepping:

```bash
npm run lab:rocklaw -- --fresh
```

Prepare a fresh world with blank self-state files for all agents:

```bash
npm run lab:rocklaw:blank
```

Stop local Rocklaw stack:

```bash
npm run stop:rocklaw
```

Stop local stack and wipe self-hosted Convex Docker data:

```bash
npm run clean:rocklaw
```

## Local llama.cpp

Detailed local-model workflow:

- [LOCAL_LLAMA.md](/home/mahmoudqahawish/Github/r0cklaw/LOCAL_LLAMA.md)

Most reused commands:

Check local CUDA visibility from `llama-server`:

```bash
cd /home/mahmoudqahawish/Github/llama.cpp/build/bin
export LD_LIBRARY_PATH=$PWD:/usr/local/cuda/targets/x86_64-linux/lib:/usr/local/cuda/lib64${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
./llama-server --list-devices
```

Run the current local baseline model:

```bash
cd /home/mahmoudqahawish/Github/llama.cpp/build/bin
export LD_LIBRARY_PATH=$PWD:/usr/local/cuda/targets/x86_64-linux/lib:/usr/local/cuda/lib64${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}

./llama-server \
  --model /home/mahmoudqahawish/Models/Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf \
  --host 127.0.0.1 \
  --port 8080 \
  --ctx-size 8192 \
  --gpu-layers all \
  --parallel 1 \
  --flash-attn auto \
  --reasoning off
```

Health check:

```bash
curl http://127.0.0.1:8080/health
```

Quick OpenAI-compatible chat test:

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "Qwen3-4B-Q4_K_M",
    "messages": [
      {"role":"system","content":"You are concise."},
      {"role":"user","content":"Reply with exactly: local llama works"}
    ],
    "temperature": 0
  }'
```

## Single-Agent Debug

Prepare one agent only in the background, keep current world:

```bash
npm run lab:agent -- elena --continue
```

Prepare one agent only in the background from a fresh world:

```bash
npm run lab:agent -- elena --fresh
```

Prepare one agent from a fresh world with blank `MEMORY.md`, `self/goals.md`, and `self/plans.md`:

```bash
npm run lab:agent:blank -- elena
```

Prepare one agent and step through ticks interactively in one terminal:

```bash
npm run step:agent -- elena --fresh
```

Warm up the first 3 ticks automatically, then switch to manual approval:

```bash
npm run step:agent -- elena --fresh --auto 3
```

Step the whole Rocklaw world interactively in one terminal:

```bash
npm run step:rocklaw -- --fresh
```

Step the whole world from a fresh run with blank self-state files:

```bash
npm run step:rocklaw:blank
```

Warm up the first 5 world ticks automatically, then switch to manual approval:

```bash
npm run step:rocklaw -- --fresh --auto 5
```

Blank-self profile with warmup ticks:

```bash
npm run step:rocklaw -- --fresh --blank-self --auto 5
```

Start one agent only, keep current world:

```bash
npm run debug:agent -- elena --continue
```

Start one agent only from a fresh world:

```bash
npm run debug:agent -- elena --fresh
```

Fire exactly one manual tick for one agent:

```bash
npm run tick:agent -- elena
```

Peek current state, trace tail, and gateway logs:

```bash
npm run peek:agent -- elena
```

Structured live view of the latest tick context, streamed tool events, parsed action, and current world files:

```bash
npm run watch:agent -- elena
```

Live-tail gateway log + runtime trace:

```bash
npm run tail:agent -- elena
```

Debug flow:

One-terminal lab loop:

1. Prepare the agent lab:

```bash
npm run lab:agent -- elena --fresh
```

2. Fire one tick:

```bash
npm run tick:agent -- elena
```

3. Inspect current state:

```bash
npm run peek:agent -- elena
```

Or use the structured live watcher:

```bash
npm run watch:agent -- elena
```

Interactive one-terminal step loop:

```bash
npm run step:agent -- elena --fresh
```

Blank-self single-agent step loop:

```bash
npm run step:agent:blank -- elena
```

After each tick it prints the watcher snapshot and prompts:

```text
Continue to next tick? [Y/n]
```

If you pass `--auto N`, the first `N` ticks run automatically before prompting.

If you also pass `--blank-self`, the reset path clears mutable per-agent self-state under `workspace/self/`, then recreates minimal placeholders for `MEMORY.md`, `self/goals.md`, `self/plans.md`, and message-log files. It also strips named-agent references from the runtime `IDENTITY.md` and `SOUL.md` view for that run, while preserving the underlying seeded versions for later restoration.

The reset path now also sanitizes runtime `AGENTS.md` and `TOOLS.md` so `--blank-self` does not carry over stale live-chat state from a previous run. Stable seed templates now live under repo-side `agents/shared/seed_docs/` for shared docs, plus `agents/*/seed_skills/` for role-specific skills, rather than inside the mutable agent workspace.

Fresh reset already clears `world/*.md` for every profile. Those files are regenerated from Convex state before ticks run, so they do not need a separate blanking mode.

Interactive full-world step loop:

```bash
npm run step:rocklaw -- --fresh
```

After each world tick it prints a compact per-agent summary and prompts:

```text
Continue to next world tick? [Y/n]
```

If you pass `--auto N`, the first `N` world ticks run automatically before prompting.

The same loops also accept `--blank-self` when you want agents to begin from near-empty self-state and let memory, goals, plans, and other mutable private notes evolve in play.

Foreground deep-debug flow:

1. In terminal 1:

```bash
npm run debug:agent -- elena --fresh
```

2. In terminal 2:

```bash
npm run tick:agent -- elena
```

3. Inspect traces:

```bash
zeroclaw --config-dir /home/mahmoudqahawish/Github/r0cklaw/agents/elena doctor traces --limit 20
```

4. Tail raw runtime trace file:

```bash
tail -f /home/mahmoudqahawish/Github/r0cklaw/agents/elena/workspace/state/runtime-trace.jsonl
```

5. Tail persisted Rocklaw tick debug:

```bash
tail -f /home/mahmoudqahawish/Github/r0cklaw/agents/elena/workspace/state/tick-debug.jsonl
```

Notes:

- this isolates one villager and stops the background multi-agent sim
- it enables ZeroClaw runtime traces for that one agent
- Rocklaw ticks now use ZeroClaw `ws/chat` sessions, persist tool-stream events to `tick-debug.jsonl`, and parse only the final `done.full_response` as the world action
- `--fresh` now resets both the Rocklaw world state and the local ZeroClaw session history for the selected agent(s)
- startup helpers now sync the self-hosted Convex admin key and deploy local Convex functions automatically
- startup helpers also loosen local `agents/` workspace permissions so the self-hosted Convex container can write shared world/debug files
- startup helpers also patch absolute `workspacePath` values into Convex so local Node actions write to the host-visible workspace tree

## Agent Provider / Model Overrides

Set a provider and optional model for one agent:

```bash
npm run agent:set-provider -- elena openai gpt-4.1
```

Examples:

```bash
npm run agent:set-provider -- elena openrouter google/gemini-2.5-flash
npm run agent:set-provider -- elena openai gpt-4.1
npm run agent:set-provider -- elena anthropic claude-sonnet-4-6
npm run agent:set-provider -- elena gemini gemini-2.5-pro
```

Expected env vars by provider:

- `openrouter` -> `OPENROUTER_API_KEY`
- `openai` -> `OPENAI_API_KEY`
- `anthropic` -> `ANTHROPIC_API_KEY` or `ANTHROPIC_OAUTH_TOKEN`
- `gemini` -> `GEMINI_API_KEY` or `GOOGLE_API_KEY`

The startup scripts now validate credentials against each agent's configured provider instead of assuming OpenRouter.

For local `llama.cpp`, keep using an OpenAI-compatible provider profile in ZeroClaw and point it at:

```text
http://127.0.0.1:8080/v1
```

For a keyless local setup, use the ZeroClaw provider alias `llamacpp` and set `api_url` in the agent config:

```toml
default_provider = "llamacpp"
default_model = "Qwen3-4B-Q4_K_M"
api_url = "http://127.0.0.1:8080/v1"
```

For ZeroClaw agent turns on the local Qwen 3 4B GGUF, a simple `--ctx-size 8192` server is not enough. The injected agent prompt can exceed 8k tokens even on a clean session. The current working local-agent server shape on the RTX 2060 Max-Q is:

```bash
cd /home/mahmoudqahawish/Github/llama.cpp/build/bin
export LD_LIBRARY_PATH=$PWD:/usr/local/cuda/targets/x86_64-linux/lib:/usr/local/cuda/lib64${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}

./llama-server \
  --model /home/mahmoudqahawish/Models/Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf \
  --host 127.0.0.1 \
  --port 8080 \
  --ctx-size 32768 \
  --gpu-layers 16 \
  --parallel 1 \
  --flash-attn auto \
  --reasoning off
```

Tradeoff:

- lower GPU offload than the simple chat baseline
- much larger context budget so ZeroClaw prompt assembly fits
- slower per-tick latency, but viable for real local agent turns

Recommended one-agent flow for local `llama-server`:

1. Start `llama-server` on `127.0.0.1:8080`.
2. Update one agent config, for example [agents/elena/config.toml](/home/mahmoudqahawish/Github/r0cklaw/agents/elena/config.toml), to use `default_provider = "llamacpp"` and `api_url = "http://127.0.0.1:8080/v1"`.
3. Start an isolated agent lab:

```bash
npm run lab:agent -- elena --fresh
```

4. Tick the agent manually:

```bash
npm run tick:agent -- elena
```

5. Benchmark recent ticks:

```bash
npm run bench:agent -- elena --limit 10
```

The benchmark reads `agents/<name>/workspace/state/tick-debug.jsonl` and computes per-tick wall-clock duration from the persisted start and completion timestamps.

Recommended isolated single-agent flow:

1. Re-seed Rocklaw with only the target agent:

```bash
npx convex run rocklaw/init:initRocklaw '{"force":true,"agentNames":["Elena Voss"]}'
```

2. Reset the local workspace to blank-self:

```bash
./scripts/reset-agent-session.sh elena --blank-self
npx convex run rocklaw/init:setAgentBlankProfile '{"agentName":"Elena Voss","blankSelf":true}'
```

3. Start the one-agent lab and fire one tick:

```bash
npm run lab:agent -- elena --fresh --blank-self
npm run tick:agent -- elena
```

4. Inspect the exact persisted run:

```bash
npm run watch:agent -- elena --once
```

Observed clean isolated result after the reset fix:

- Elena in a one-agent world no longer hallucinated stale chat partners from `AGENTS.md` / `TOOLS.md`
- the next local tick produced a valid non-chat action:
  `{"action":"work","item":"horseshoe",...}`
- Rocklaw accepted it and marked the work as started until tick 4

## Useful URLs

- frontend: `http://127.0.0.1:5173/ai-town`
- Convex backend: `http://127.0.0.1:3210`
- Convex dashboard: `http://127.0.0.1:6791`
- ZeroClaw agent dashboards:
  - Elena: `http://127.0.0.1:42617/`
  - Marcus: `http://127.0.0.1:42618/`
  - Finn: `http://127.0.0.1:42619/`
  - Lena: `http://127.0.0.1:42620/`
  - Sera: `http://127.0.0.1:42621/`
  - Aldric: `http://127.0.0.1:42622/`
  - Cora: `http://127.0.0.1:42623/`
  - Rook: `http://127.0.0.1:42624/`

## Current Integration Reality

Rocklaw currently starts each villager as:

```bash
zeroclaw --config-dir agents/<name> gateway start
```

and the world engine sends each tick through:

- `GET /ws/chat?session_id=rocklaw-<agent>`

Rocklaw waits for streamed ZeroClaw events, persists them to `state/tick-debug.jsonl`, and only parses the final `done.full_response` into a Rocklaw action.
