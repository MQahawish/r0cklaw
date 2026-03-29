# Dynamic MD Scenario Map + Compaction Plan

Date: 2026-03-28

## Goal

Start a concrete pass to:
- enumerate dynamic markdown scenarios,
- remove overlap across runtime files,
- compact repeated instruction blocks,
- keep one clear purpose per file.

## Current runtime docs touched by world refresh

- `TOOLS.md` (runtime-overwritten)
- `AGENTS.md` (runtime-overwritten)
- `skills/*/SKILL.md` (runtime-overwritten from seeded copies)
- `world/location.md`
- `world/status.md`
- `world/CHAT.md`
- `world/chat/<person>/CHAT.md`
- `world/OFFERS.md`

## Scenario matrix (what changes per situation)

### S0 — Baseline (not in live chat, no nearby people)
- `TOOLS.md`: no temporary chat-scene action block; world actions + economic section only.
- `AGENTS.md`: examples/valid actions include core movement/say/eat + role actions.
- `SKILL.md`: chat-present bullets are stripped where required.

### S1 — Nearby people available (can open chats)
- `TOOLS.md`: includes `chat` guidance/examples for one-to-one communication.
- `AGENTS.md`: includes `chat` example and chat/say distinction.
- `SKILL.md`: role guidance still present; chat wording normalized.

### S2 — Active live chat scene
- `TOOLS.md`: hard-constrained to `chat` and `leave_chat`, with progress rules.
- `AGENTS.md`: valid actions become `chat, leave_chat` only.
- `world/OFFERS.md`: used for `offer_ref` and pending offers in-scene.

### S3 — Pending offers but not currently in live chat
- `TOOLS.md`: marks accept/reject as unavailable until a live chat opens with sender.
- `AGENTS.md`: keeps global action surface; points to TOOLS for current availability.

## Overlaps to reduce

1. **Chat semantics repeated across TOOLS + AGENTS + skills**
   - Keep detailed syntax/examples in `TOOLS.md`.
   - Keep AGENTS concise: policy + where to look (`TOOLS.md`, world files).

2. **Economic availability repeated in multiple formats**
   - Keep the authoritative availability matrix in `TOOLS.md`.
   - Keep AGENTS at a high-level reminder only.

3. **Legacy term normalization repeated in multiple rewrite functions**
   - Centralize shared normalization helper and apply uniformly.

## Proposed ownership split

- `AGENTS.md` (runtime):
  - behavior policy, priorities, concise valid-action summary.
  - no long JSON examples except maybe 1 canonical pattern.

- `TOOLS.md` (runtime):
  - authoritative action contract and structured field requirements.
  - all rich examples and temporary action availability.

- `skills/*/SKILL.md` (runtime):
  - role tactics only; avoid re-documenting full action contract.
  - reference TOOLS for structured fields.

- `world/*` files:
  - factual state only (who/where/what), no policy duplication.

## First-pass compaction tasks

1. Keep one canonical chat-intent block template in code and inject where needed.
2. Trim AGENTS examples to a minimal set and move detailed JSON cases to TOOLS.
3. Keep skills focused on role heuristics; remove repeated generic chat contract text.
4. Add snapshot tests for S0–S3 to monitor accidental overlap growth.

## Success criteria

- Smaller AGENTS and SKILL runtime docs.
- TOOLS remains the single source for field-level action syntax.
- Reduced duplicate phrasing across runtime docs.
- Scenario snapshots are stable and intentional.
