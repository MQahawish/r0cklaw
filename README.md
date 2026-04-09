# Rocklaw

Rocklaw is a persistent village simulation built on top of this forked AI Town codebase.
It owns the world model, tick engine, Convex state, agent workspaces, local stepping tools, and frontend.

Rocklaw runs alongside a second repo in local development:
- `zeroclaw/` handles agent runtime, session behavior, and tool execution
- `r0cklaw/` handles what the world is and what actions mean

## Repo Boundary

Use this repo when you are working on:
- Rocklaw world logic
- Convex mutations, queries, and tick flow
- world file generation and heartbeat continuity
- action validation and commitment
- agent seed docs and skill docs
- local stepping/debug tooling
- frontend/UI for the simulation

Use ZeroClaw when you are working on:
- gateway/runtime behavior
- prompt assembly inside the runtime
- tool iteration behavior
- streamed tool/session handling

## Main Docs

- [LOCAL_DEV.md](/home/mahmoudqahawish/Github/r0cklaw/LOCAL_DEV.md)
  - how to run, reset, step, and inspect Rocklaw locally
- [LOCAL_LLAMA.md](/home/mahmoudqahawish/Github/r0cklaw/LOCAL_LLAMA.md)
  - local `llama.cpp` build, launch, tuning, and benchmark commands
- [ARCHITECTURE.md](/home/mahmoudqahawish/Github/r0cklaw/ARCHITECTURE.md)
  - canonical technical explanation of Rocklaw
- [ROADMAP.md](/home/mahmoudqahawish/Github/r0cklaw/ROADMAP.md)
  - current priorities, known gaps, and next work
- [README_AI_TOWN.md](/home/mahmoudqahawish/Github/r0cklaw/README_AI_TOWN.md)
  - preserved upstream AI Town README for the original base project

## Quick Start

```bash
cd /home/mahmoudqahawish/Github/r0cklaw
npm run step:rocklaw -- --fresh --auto 3
```

That boots a fresh local world, warms up a few ticks, then switches to manual stepping.

## Current Model

Rocklaw currently uses:
- strict JSON final actions from agents
- world-owned validation and commitment in Convex
- per-agent workspaces with generated runtime files and recent activity surfaced from world state
- local interaction handling for `chat` (live/deferred) and in-person commerce via chat intents
- dynamic runtime docs so only currently relevant actions are surfaced
- `--blank-self` mode for minimal starting self-state and world-driven first contact

## Notes

- Do not treat generated runtime files under `agents/*/workspace/` as source docs.
- The checked-in workspace files under each agent are the seed templates.
- `README_AI_TOWN.md` is reference material, not the primary Rocklaw doc.
