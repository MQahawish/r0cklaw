# Rocklaw

Rocklaw is the simulation/game repo.
It owns the world state, tick engine, agent workspaces, market rules, world files, and local debug tooling.

This project currently runs with a second repo:
- [ZeroClaw](/home/mahmoudqahawish/Github/zeroclaw)

Use this repo when you are working on:
- Rocklaw world logic
- Convex mutations, queries, and tick flow
- agent prompts and workspace files
- local stepping and debug tooling
- UI / frontend for the simulation

Use the ZeroClaw repo when you are working on:
- the gateway/runtime that serves each agent
- ZeroClaw bootstrap/system-prompt behavior
- WebSocket session behavior
- tool execution behavior inside the agent runtime

## Repo Boundary

Rocklaw depends on ZeroClaw locally, but they are separate codebases.

- `r0cklaw/`
  - world engine
  - Convex backend
  - frontend
  - agent workspace files
  - scripts for local labs and stepping
- `zeroclaw/`
  - agent runtime / gateway
  - session handling
  - prompt assembly
  - tool execution layer

In practice:
- Rocklaw decides **what the world is** and **what actions mean**.
- ZeroClaw decides **how the agent reads files/tools and returns an action**.

## Main Docs

Start here depending on what you need:
- [LOCAL_DEV.md](/home/mahmoudqahawish/Github/r0cklaw/LOCAL_DEV.md)
  - practical local commands
- [ARCHITECTURE.md](/home/mahmoudqahawish/Github/r0cklaw/ARCHITECTURE.md)
  - project structure and system design
- [ARCHITECTURE_RND.md](/home/mahmoudqahawish/Github/r0cklaw/ARCHITECTURE_RND.md)
  - Rocklaw-specific architecture diagrams and runtime flows
- [ROCKLAW.MD](/home/mahmoudqahawish/Github/r0cklaw/ROCKLAW.MD)
  - Rocklaw design notes / domain rules
- [README_AI_TOWN.md](/home/mahmoudqahawish/Github/r0cklaw/README_AI_TOWN.md)
  - preserved upstream AI Town README

## Local Setup

Prerequisites:
- Node/npm installed
- Docker installed
- `zeroclaw` available on your machine
- provider keys in [`.env.local`](/home/mahmoudqahawish/Github/r0cklaw/.env.local) if needed

Typical local commands:

```bash
cd /home/mahmoudqahawish/Github/r0cklaw
npm run dev:rocklaw
```

Fresh local world:

```bash
npm run dev:rocklaw:fresh
```

Interactive full-world stepping:

```bash
npm run step:rocklaw -- --fresh
```

Interactive single-agent stepping:

```bash
npm run step:agent -- elena --fresh
```

For the full command reference, use [LOCAL_DEV.md](/home/mahmoudqahawish/Github/r0cklaw/LOCAL_DEV.md).

## Current Local Workflow

For this setup, Rocklaw usually runs against the sibling ZeroClaw checkout at:
- [zeroclaw](/home/mahmoudqahawish/Github/zeroclaw)

That means if something looks wrong, first decide which repo owns the bug:

- Rocklaw bug examples:
  - invalid world validation
  - wrong inventory/coin mutation
  - tick prompt wording
  - heartbeat continuity
  - location/world file rendering
  - transaction or interaction semantics

- ZeroClaw bug examples:
  - session carry-over issues
  - prompt assembly issues inside the runtime
  - tool iteration limits
  - tool event streaming problems
  - hidden system-prompt/runtime behavior

## Current Interaction Model

Rocklaw currently supports:
- strict JSON-only final action responses
- internal observation and private writing stay inside ZeroClaw tool use, not final world actions
- per-agent heartbeat continuity
- in-person commerce offers for `buy`, `sell`, `trade`
- shared local interactions for colocated `talk` and commerce
- `wait` for staying available in the current local scene
- interactive stepping for one agent or the whole world

## Notes

- Do not treat the old AI Town README as the primary doc for this fork.
- Do not edit generated runtime state under `agents/*/workspace/world/` as if it were source.
- Source-of-truth agent bootstrap files are the checked-in workspace files such as:
  - `IDENTITY.md`
  - `SOUL.md`
  - `AGENTS.md`
  - `TOOLS.md`
  - `MEMORY.md`

## Quick Orientation

If you just want to run the current local setup:

```bash
cd /home/mahmoudqahawish/Github/r0cklaw
npm run step:rocklaw -- --fresh --auto 3
```

That warms up a few ticks, then lets you approve the world tick-by-tick.
