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

Notes:

- this isolates one villager and stops the background multi-agent sim
- it enables ZeroClaw runtime traces for that one agent
- current Rocklaw integration still uses ZeroClaw gateway `/webhook` simple chat mode for ticks, not the full tool-loop runtime

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

and the world engine sends tick prompts to:

- `POST /webhook`

In current ZeroClaw, that path uses the simple gateway chat flow:

- workspace-aware system prompt injection
- one LLM call
- no real tool loop for the tick itself

That is why invalid prose / malformed JSON / tool-like output can still appear during Rocklaw ticks. This is a behavior-contract issue, not a local environment startup issue.
