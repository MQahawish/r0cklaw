# Rocklaw Architecture R&D

This document is the Rocklaw-specific architecture reference for the current two-repo setup.

Related docs:
- [README.md](/home/mahmoudqahawish/Github/r0cklaw/README.md)
- [LOCAL_DEV.md](/home/mahmoudqahawish/Github/r0cklaw/LOCAL_DEV.md)
- [ROCKLAW.MD](/home/mahmoudqahawish/Github/r0cklaw/ROCKLAW.MD)
- [README_AI_TOWN.md](/home/mahmoudqahawish/Github/r0cklaw/README_AI_TOWN.md)

## 1. System Boundary

```mermaid
flowchart LR
    R[Rocklaw Repo] --> Z[ZeroClaw Repo]
    Z --> LLM[Model Provider]
    R --> DB[(Convex DB)]
    R --> WS[Agent Workspaces]
    Z --> WS
```

### Ownership

| Concern | Owner |
|---|---|
| Tick scheduling | Rocklaw |
| World state | Rocklaw / Convex |
| Meaning of actions | Rocklaw |
| World file generation | Rocklaw |
| Bootstrap file source | Rocklaw |
| Session memory and tool runtime | ZeroClaw |
| Final action generation | ZeroClaw + model |
| Validation and commitment | Rocklaw |

## 2. One Tick

```mermaid
sequenceDiagram
    participant E as Rocklaw Engine
    participant W as World Refresh
    participant G as ZeroClaw Gateway
    participant M as Model
    participant B as Rocklaw Bridge
    participant D as Convex DB

    E->>W: refresh world files
    W->>D: read state
    W->>W: write workspace files
    E->>B: tickAgent(...)
    B->>G: ws/chat(prompt)
    G->>M: run turn
    M->>G: tools + final JSON
    G->>B: streamed events + final response
    B->>D: validate + commit or fail
    B->>W: heartbeat / next-tick continuity
```

## 3. What an Agent Has

| Layer | Contents | Owner |
|---|---|---|
| Convex row | location, inventory, energy, hunger, health, coin, pendingNote | Rocklaw |
| Workspace source files | `IDENTITY.md`, `SOUL.md`, `AGENTS.md`, `TOOLS.md`, `MEMORY.md` | Rocklaw |
| Workspace runtime files | `HEARTBEAT.md`, `world/*.md`, `self/*.md` | Rocklaw + agent |
| ZeroClaw runtime state | `memory/brain.db`, `sessions/sessions.db`, `state/*.jsonl` | ZeroClaw |

## 4. Workspace Structure

| Path | Purpose | Written by |
|---|---|---|
| `IDENTITY.md` | stable identity | Rocklaw source |
| `SOUL.md` | personality and inner framing | Rocklaw source |
| `AGENTS.md` | runtime contract | Rocklaw source |
| `TOOLS.md` | tool and action contract | Rocklaw source |
| `MEMORY.md` | curated long-term seed memory | Rocklaw source |
| `HEARTBEAT.md` | rolling continuity log | Rocklaw |
| `world/location.md` | current location, nearby people, active interactions, notes | Rocklaw |
| `world/inventory.md` | current inventory and coin | Rocklaw |
| `world/status.md` | current energy, health, hunger | Rocklaw |
| `world/market_prices.md` | current prices and shortages | Rocklaw |
| `world/village_news.md` | recent mentions and news | Rocklaw |
| `self/*.md` | goals, plans, beliefs, desires, secrets | agent |
| `self/social/*` | public/private relationship notes | agent |
| `self/messages/*` | personal correspondence logs | agent |
| `memory/brain.db` | deep memory store | ZeroClaw |
| `sessions/sessions.db` | session continuity | ZeroClaw |
| `state/runtime-trace.jsonl` | runtime trace | ZeroClaw |
| `state/tick-debug.jsonl` | Rocklaw turn debug | Rocklaw |

## 5. Bootstrap Files

Rocklaw now uses the ZeroClaw bootstrap file names directly as the source-of-truth.

| File | Role |
|---|---|
| `IDENTITY.md` | stable identity |
| `SOUL.md` | personality and inner framing |
| `AGENTS.md` | runtime behavior contract |
| `TOOLS.md` | tool and action contract |
| `MEMORY.md` | curated long-term memory seed |

Rule:
- edit `IDENTITY.md`, `SOUL.md`, `AGENTS.md`, `TOOLS.md`, and `MEMORY.md` directly
- these are the source-of-truth bootstrap files

## 6. What the Agent Sees

The agent does not directly see Convex rows.
It sees only prompt inputs and files.

```mermaid
flowchart TD
    P[Agent-visible context]
    P --> B[Bootstrap files]
    P --> T[Tick prompt]
    P --> F[Files read during the turn]
```

### Concretely

| Source | Examples |
|---|---|
| Bootstrap files | `IDENTITY.md`, `SOUL.md`, `AGENTS.md`, `TOOLS.md`, `MEMORY.md` |
| Tick prompt | day, time, last tick, output contract |
| Runtime reads | heartbeat, status, inventory, location, prices, goals, plans |

## 7. Action Resolution

```mermaid
flowchart LR
    J[Final JSON action] --> S[Shape validation]
    S --> F[Feasibility validation]
    F --> C[Commit or fail]
    C --> H[Heartbeat + continuity]
```

### Action Classes

| Class | Examples | Resolution |
|---|---|---|
| Solo immediate | `move`, `rest`, `sleep`, `eat`, `craft`, `smelt` | validate and commit now |
| Local social interaction | `talk` | create shared local interaction |
| Local commerce offer | `buy`, `sell`, `trade` | create pending offer + local interaction |
| Commerce response | `accept_transaction`, `reject_transaction` | resolve pending offer |
| Scene-preserving | `wait` | remain present with minimal change |

## 8. Local Interaction Model

```mermaid
sequenceDiagram
    participant A as Agent A
    participant R as Rocklaw
    participant B as Agent B

    A->>R: talk / buy / sell / trade
    R->>R: create active local interaction
    R->>B: next tick, show Active interactions here
    B->>R: respond / wait / move / ignore
    alt moved away
        R->>R: fail interaction with reason
    else ignored too long
        R->>R: expire interaction
    else answered
        R->>R: mark responded or continue scene
    end
```

## 9. Commerce Protocol

```mermaid
sequenceDiagram
    participant A as Proposer
    participant R as Rocklaw
    participant B as Recipient

    A->>R: buy / sell / trade
    R->>R: validate colocation + proposer feasibility
    R->>R: create pending transaction
    R->>B: next tick, show pending local offer
    B->>R: accept_transaction / reject_transaction
    R->>R: revalidate both sides at settlement time
    alt valid now
        R->>R: settle atomically
    else invalid now
        R->>R: fail with concrete reason
    end
```

## 10. Failure and Continuity

```mermaid
flowchart TD
    X[Failure] --> H[Heartbeat entry]
    H --> L[Last tick in next prompt]
    H --> N[pendingNote when needed]
    L --> NEXT[Next agent turn]
    N --> NEXT
```

### Failure Sources

| Failure type | Example |
|---|---|
| Output format | prose before JSON |
| Structural invalidity | wrong action schema |
| World invalidity | not enough ore, wrong location, target absent |
| Runtime failure | transport or gateway failure |

## 11. World Files Per Tick

| File | Purpose |
|---|---|
| `world/location.md` | where you are, who is nearby, active interactions, letters, carry-over note |
| `world/inventory.md` | items and coin |
| `world/status.md` | energy, health, hunger |
| `world/market_prices.md` | prices, shortages, recent trades |
| `world/village_news.md` | broader mentions and recent world context |
| `HEARTBEAT.md` | recent personal continuity |

## 12. Agent Lifecycle

```mermaid
flowchart LR
    A[Defined in repo] --> B[Workspace scaffolded]
    B --> C[Bootstrap files available]
    C --> D[Runs ticks]
    D --> E[Builds memory + heartbeat over time]
    E --> D
```

## 13. Rocklaw vs Inherited AI Town

| Inherited AI Town layer | Current Rocklaw reality |
|---|---|
| generic town starter | persistent village simulation |
| internal agent stack | external ZeroClaw runtime |
| conversation-heavy model | file-driven per-tick agent runtime |
| upstream architecture docs | Rocklaw-specific runtime documented here |

Use this document for current Rocklaw architecture.
Use [README_AI_TOWN.md](/home/mahmoudqahawish/Github/r0cklaw/README_AI_TOWN.md) only as upstream historical reference.
