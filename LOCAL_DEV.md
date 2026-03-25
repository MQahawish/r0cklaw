# Local Rocklaw Ops

Practical commands for running Rocklaw locally with:

- self-hosted Convex in Docker
- ZeroClaw agent gateways on the host
- remote model providers such as OpenRouter, OpenAI, Anthropic, Gemini

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

Stop local Rocklaw stack:

```bash
npm run stop:rocklaw
```

Stop local stack and wipe self-hosted Convex Docker data:

```bash
npm run clean:rocklaw
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

Warm up the first 5 world ticks automatically, then switch to manual approval:

```bash
npm run step:rocklaw -- --fresh --auto 5
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

After each tick it prints the watcher snapshot and prompts:

```text
Continue to next tick? [Y/n]
```

If you pass `--auto N`, the first `N` ticks run automatically before prompting.

Interactive full-world step loop:

```bash
npm run step:rocklaw -- --fresh
```

After each world tick it prints a compact per-agent summary and prompts:

```text
Continue to next world tick? [Y/n]
```

If you pass `--auto N`, the first `N` world ticks run automatically before prompting.

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
