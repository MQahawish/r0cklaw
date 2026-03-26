# Rocklaw Roadmap

This file tracks the current direction of the project.
It replaces the old build-journal style status doc.

## Current Priorities

### 1. Tighten the action contract
- remove or implement remaining shallow specialist verbs
- keep runtime docs aligned with the actual validator
- reduce model drift into tool actions or malformed final actions

### 2. Keep dynamic action surfacing coherent
- continue moving situational action availability into runtime docs
- avoid duplicated contract rules across prompt layers
- keep `TOOLS.md`, `AGENTS.md`, and skill docs consistent with current context

### 3. Improve conversation and local-scene behavior
- reduce stale `wait` loops
- improve cross-tick conversation closure semantics
- keep same-tick reciprocal talk handling deterministic and readable

### 4. Deepen world semantics where it matters
- stronger location semantics for work actions
- better resource and recipe enforcement where needed
- richer commerce semantics only when the action surface is stable enough

## Known Gaps

- Some specialized verbs still succeed with shallow semantics rather than deep world effects.
- Parse-failed turns and tool-action leakage still need tighter correction paths.
- Runtime doc rewriting is useful but still needs discipline so static docs do not leak stale affordances.
- Conversation lifecycle behavior is improved but not fully mature.

## Recent Direction

Recent work has focused on:
- true fresh resets for local testing
- `--blank-self` and world-driven first contact
- dynamic runtime action surfacing
- pruning unsupported verbs from the visible action set
- aligning skill docs to real Rocklaw actions
- standardizing `text` vs `message`

## Next Likely Work

1. Audit remaining shallow verbs and either deepen or remove them.
2. Tighten corrective handling for invalid final actions like tool leakage.
3. Keep reducing duplicated prompt/doc logic in favor of cleaner runtime surfaces.
4. Continue simplifying the top-level documentation set.
