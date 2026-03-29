# Rocklaw Architecture

This is the canonical technical overview for Rocklaw.

## Purpose

Rocklaw is a village simulation where each villager is an autonomous agent with:
- a seeded identity and personality
- a runtime workspace
- a world-facing action contract
- world-owned validation and state mutation

The system is split across two repos:
- `r0cklaw/`: world engine, Convex state, workspace refresh, action validation, frontend, local tooling
- `zeroclaw/`: agent runtime, tool loop, prompt assembly, model calls

Rocklaw decides what the world is.
ZeroClaw decides how an agent reads context and returns one final action.

## System Boundary

| Concern | Owner |
|---|---|
| Tick scheduling | Rocklaw |
| World state | Rocklaw / Convex |
| Action semantics | Rocklaw |
| World/workspace refresh | Rocklaw |
| Runtime heartbeat continuity | Rocklaw |
| Tool execution inside a turn | ZeroClaw |
| Final action generation | ZeroClaw + model |

## One Tick

A Rocklaw agent tick works like this:

1. Rocklaw refreshes the agent workspace from Convex state.
2. Runtime docs are rewritten for the current situation.
3. Rocklaw sends the tick prompt to the agent gateway.
4. ZeroClaw runs tools internally and returns one final JSON action.
5. Rocklaw normalizes, validates, and commits that action.
6. Rocklaw appends heartbeat continuity and prepares next-tick context.

## Main Data Layers

### 1. Convex world state

Convex is the source of truth for:
- agents
- locations
- inventories
- prices
- messages
- interactions
- transactions
- world clock
- social first-contact knowledge

### 2. Agent seed docs

Checked-in files under each agent workspace define the baseline agent:
- `IDENTITY.md`
- `SOUL.md`
- `AGENTS.md`
- `TOOLS.md`
- `MEMORY.md`
- `skills/*/SKILL.md`

These are source templates, not live state.

### 3. Runtime workspace files

Refreshed/generated files provide current context:
- `world/location.md`
- `world/status.md`
- `world/inventory.md`
- `world/market_prices.md`
- `world/village_news.md`
- `HEARTBEAT.md`

Rocklaw also rewrites runtime `TOOLS.md`, `AGENTS.md`, and `skills/*/SKILL.md` to reflect the current action surface.

## Action Contract

Agents think with tools, but they finish a turn with one Rocklaw action.

Important boundaries:
- internal cognition stays inside ZeroClaw tools
- final actions are only outward, world-affecting actions
- observation, recall, and private note-writing are not final actions

Current contract rules include:
- `move` uses only currently reachable places
- `chat` appears in runtime docs for one-to-one communication (live if present, deferred if away)
- `wait`, `rest`, and `sleep` are surfaced dynamically when currently appropriate
- world validation still rejects misuse even if the model drifts

For content fields:
- `text` holds the actual spoken or written content for actions like `chat`, `say`, `pray`, and `eavesdrop`
- `message` is optional visible framing only when distinct from `text`

## Interaction Model

Rocklaw currently supports:
- colocated/live `chat` scenes
- in-person `buy`, `sell`, and `trade` offers
- short-handle references like `offer-1` for transaction follow-up
- same-tick reciprocal chat opening with interruption context carried into the scene
- heartbeat continuity when scenes stay open or lapse

## Blank-Self Mode

`--blank-self` is a runtime profile, not a different codepath.

It clears mutable self-state and removes seeded named social awareness from the runtime view, while keeping the underlying identity/personality seed docs intact.

From there:
- agents learn about other villagers through sight and contact
- first contact is tracked by a world-owned social knowledge table
- world files inject first-seen cues when agents meet

## Dynamic Runtime Docs

Rocklaw intentionally uses dynamic runtime docs so the agent sees a narrower, cleaner action surface.

Examples:
- live-chat affordances are constrained by who is nearby
- `move` is constrained to `Reachable places now`
- `wait`, `rest`, and `sleep` only appear when currently available
- skill docs can be trimmed at runtime so static role wording does not fight current context

This keeps the model focused on what is actually possible now, while Convex remains the hard validator.

## Local Tooling

The main operator flows are:
- world-level stepping
- single-agent stepping
- blank-self resets
- watch/peek/tail tools for runtime inspection

See [LOCAL_DEV.md](/home/mahmoudqahawish/Github/r0cklaw/LOCAL_DEV.md) for exact commands.

## Non-Goals

Rocklaw is not currently trying to be:
- a pure game-rules fork of upstream AI Town documentation
- a fully implemented deep sim for every specialist verb
- a static prompt system with one permanent action list

It is intentionally moving toward:
- cleaner world-owned semantics
- narrower runtime action surfaces
- less duplicated prompt logic
- better separation between seed docs, runtime docs, and human project docs
