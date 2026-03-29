# Audit: Dynamic MDS, chat scenes, and simulation/action gaps

Date: 2026-03-28

## What is currently solid

- Runtime `TOOLS.md`, `AGENTS.md`, and `skills/*/SKILL.md` are rewritten per-agent each refresh tick from seeded backups and current world data.
- Live chat scenes strictly constrain scene participants to `chat`/`leave_chat`; in-scene commerce is routed through `chat` + `intent`.
- Economic guidance is context-aware (available vs unavailable actions) and explicitly explains accept/reject constraints.

## Gaps and risks found

1. **Static docs still contain stale `talk` framing in places**
   - Top-level docs still reference `talk` in architectural summaries while runtime behavior is `chat`.
   - This can create contributor/operator confusion even if runtime files are corrected.

2. **Action-surface duplication between validator and runtime prompts**
   - Action availability rules are encoded in multiple places (runtime rewrite logic, bridge validation, bridge-node output schema and examples).
   - Drift risk remains if one layer changes and another is missed.

3. **`canRespondToOffers` parameter is currently unused in action-profile builder**
   - Indicates partial/unfinished branch intent in dynamic action surfacing.

4. **Legacy branches for top-level commerce verbs remain in commit path**
   - `pay/give/buy/sell/trade` branches exist in commit logic while final-action validator now centers commerce in `chat` intents.
   - Keeping both increases maintenance surface and ambiguity over canonical path.

5. **Scene-turn progression is strict but brittle for ambiguous turns**
   - The engine enforces progress language and turn ownership, but if model output drifts (e.g., weak/no-progress chat), failures are handled reactively rather than with a stronger structured “repair and retry in-scene” loop.

6. **Known-gap alignment: shallow/placeholder semantics still acknowledged**
   - Project roadmap explicitly notes shallow specialist verbs and conversation lifecycle maturity as active gaps.

## Lightweight / missing implementation notes

- Several world semantics are intentionally thin (by roadmap design), especially around specialist/deep simulation outcomes versus validation-only gating.
- Parse/tool-leak rejection exists and is explicit, but correction paths are still mostly reject-and-note rather than robust auto-repair.
- There is no single source-of-truth generator for action contracts across runtime docs + bridge validation + bridge-node schema text.

## Recommended next steps (small, high-leverage)

1. Canonicalize action contract metadata in one module and generate:
   - bridge-node validator allowlist,
   - runtime AGENTS/TOOLS action sections,
   - examples/snippets for chat-scene commerce.
2. Remove or hard-deprecate legacy top-level commerce branches where no longer needed.
3. Use/implement `canRespondToOffers` or remove it to eliminate dead-parameter confusion.
4. Add a focused test matrix for live-chat transitions:
   - mutual openers,
   - deferred fallback,
   - accept/reject with stale offer_ref,
   - leave_chat cleanup and partner notes.
5. Update project docs to consistently describe `chat` replacing `talk`.
