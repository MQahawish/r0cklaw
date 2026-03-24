# ROCKLAW -- Dev Status Journal

> Running log of what has been built, what decisions were made, and what remains.
> Updated at the end of each build session.

---

## Status at a Glance

| Phase | Name | Status |
|---|---|---|
| 1 | Skeleton | ✅ Complete (pending live verify) |
| 2 | Full Village | ✅ Complete (pending live verify) |
| 3 | Economy and Energy | ✅ Complete (pending live verify) |
| 4 | Memory and Social | ✅ Complete (pending live verify) |
| 5 | God-Mode Dashboard | 🔲 Not started |
| 6 | Compaction and Stability | 🔲 Not started |
| 7 | Observation Layer | 🔲 Not started |
| 8 | Systems Layer | 🔲 Not started |

---

## Phase 1 -- Skeleton ✅

**What was built:**

- `convex/rocklaw/schema.ts` -- all Rocklaw tables: `rl_agents`, `rl_market_prices`, `rl_messages`, `rl_locations`, `rl_world_events`, `rl_actions_log`, `rl_prayers`, `rl_reputation`, `rl_world_state`, `rl_systems_state`
- `convex/rocklaw/init.ts` -- `initRocklaw` mutation (seeds world state, all 8 agents, 7 locations, triggers price recalc). `advanceTick` internalMutation (morning → afternoon → evening → next day).
- `convex/rocklaw/priceEngine.ts` -- supply/demand price recalculation for 10 items. Called after inventory-changing actions.
- `convex/rocklaw/worldRefresh.ts` -- `refreshWorldFiles` internalAction: writes 5 world/ files (inventory, location, village_news, market_prices, status) from Convex state before each agent tick. `appendHeartbeat` internalAction: appends one line to agent's HEARTBEAT.md after each tick.
- `convex/rocklaw/bridge.ts` -- `tickAgent` internalAction: full tick pipeline (refresh world → check letters → POST to ZeroClaw → parse JSON action → validate → commit → append HEARTBEAT).
- `convex/rocklaw/engine.ts` -- `startRocklaw` / `stopRocklaw` public mutations; `runRocklawTick` self-scheduling internalAction (30s interval); `manualTick` public action for single-tick testing.
- `agents/elena/` -- config.toml (port 42617, OpenRouter, gemini-flash), full workspace (IDENTITY, SOUL, AGENTS, TOOLS, MEMORY, HEARTBEAT, self/, skills/blacksmith/).
- `scripts/start-agent.sh` -- starts a single ZeroClaw gateway by agent name.

**Decisions made:**
- `workspacePath` stored relative to project root in Convex DB. `path.resolve()` in worldRefresh uses process CWD. Works in local dev where CWD = project root.
- ZeroClaw gateway endpoint: `POST /webhook` with `{ message }`. Returns `{ response, model }`.
- Tick interval: 30 seconds per time-of-day period (morning/afternoon/evening) for dev. ~90s per simulated day.
- Action format: agent returns a single JSON block. Bridge extracts last valid JSON object from response, allowing prose before the action.

---

## Phase 2 -- Full Village ✅

**What was built:**

- `agents/marcus/`, `agents/finn/`, `agents/lena/`, `agents/sera/`, `agents/aldric/`, `agents/cora/`, `agents/rook/` -- complete agent directories with:
  - `config.toml` (ports 42618-42624)
  - `workspace/00_IDENTITY.md` -- unique character biography per agent
  - `workspace/01_SOUL.md` -- inner world, personality, speech style
  - `workspace/02_AGENTS.md` -- how to operate in Rocklaw (name-adapted from Elena)
  - `workspace/03_TOOLS.md` -- universal tools + occupation-specific skills
  - `workspace/05_MEMORY.md` -- starting memories and relationship notes
  - `workspace/06_HEARTBEAT.md` -- empty activity log (Day 1 start)
  - `workspace/self/{goals,plans,beliefs,desires,secrets}.md` -- unique starting inner state
  - `workspace/skills/<occupation>/SKILL.md` -- occupation rules and economic context
  - Seed social/ stubs for key relationships
- `scripts/start-all-agents.sh` -- launches all 8 gateways in background with PID tracking
- `scripts/stop-all-agents.sh` -- stops all by PID file
- `.gitignore` -- excludes generated `world/` files and runtime pid/log files

**Agents and their roles:**
| Agent | Role | Port | Starting location |
|---|---|---|---|
| Elena Voss | Blacksmith | 42617 | forge |
| Marcus Hale | Merchant | 42618 | market |
| Finn | Farmer | 42619 | farm |
| Lena Marsh | Herbalist | 42620 | shrine |
| Sera | Innkeeper | 42621 | inn |
| Brother Aldric | Priest | 42622 | shrine |
| Cora | Child | 42623 | square |
| Old Rook | Retired Soldier | 42624 | square |

**Decisions made:**
- `02_AGENTS.md` is structurally identical for all agents; only the name is substituted. The return JSON format is universal.
- `03_TOOLS.md` uses a shared core (recall, economic, world, message tools) + a per-occupation skills section appended at the end.
- `05_MEMORY.md` is seeded with starting knowledge including relationship opinions, to give agents a non-blank social foundation from Day 1.
- Social/ files seeded only for the most narratively interesting starting relationships (Elena↔Marcus, Finn↔Marcus, Rook↔Lena).

---

## Phase 3 -- Economy and Energy ✅

**What was built:**

`convex/rocklaw/bridge.ts` changes:
- `commitAction` now returns `{ outcome, note }` so tickAgent can write meaningful HEARTBEAT lines.
- **Energy gate**: high-effort actions (craft, smelt, repair, mine, harvest, plant, water, patrol, train, gather, brew, treat) fail when `energy < 15`. Failure logged as `outcome: 'failed'` with note. Small penalty (−3 energy) for attempting.
- **Health degradation**: if agent's energy was 0 going into a tick (and action isn't rest/sleep), health decreases by 10.
- `summariseAction` includes `[FAILED]` and `⚠ warning` text in the HEARTBEAT line.

`convex/rocklaw/worldRefresh.ts` changes:
- `buildStatusMd` adds `EXHAUSTED` threshold at energy < 15 (distinct from CRITICAL at < 30).
- `Conditions:` section is now dynamic: lists sustained exhaustion, poor health, starvation as `! Warning` lines when active.

**Decisions made:**
- `MIN_ENERGY_FOR_HARD_WORK = 15` -- below this, physically demanding work fails. Agents can still talk, write, pray, observe, move, eat, rest, sleep.
- `HEALTH_DRAIN_PER_ZERO_ENERGY_TICK = 10` -- significant enough to force sleep urgency; 10 ticks at zero energy = dead.
- Energy costs for occupation skills: craft=30, smelt=40, harvest=35, brew=10, play=−10 (restores child energy), sleep=−100 (full restore), rest=−40 (partial).

---

## Phase 4 -- Memory and Social ✅

**What was built:**

`convex/rocklaw/bridge.ts` changes:
- **VALID_ACTIONS expanded** from 16 to 30+ entries. Previously all occupation skills (harvest, gather, brew, bless, patrol, play, run_errand, etc.) were failing validation silently.
- **`leave_message` action** added: inserts a row into `rl_messages` with `fromAgent`, `toAgent`, `content`, `status: 'unread'`, and `deliveryLocationId` (the sender's current location). Agent writes a letter by choosing this action with `target = recipient name` and `message = letter content`.
- **`recall` action** added as a no-op (logs to actions_log, no state change). ZeroClaw auto-recalls memory as part of every turn's context building, making an explicit recall action unnecessary.

`convex/rocklaw/worldRefresh.ts` changes:
- **`deliverLetters` internalMutation**: queries `rl_messages` for unread letters addressed to the agent at their current location (or direct-delivery letters with no location). Marks them `status: 'read'`, `dayRead: day`. Returns the letter objects.
- **`refreshWorldFiles`** calls `deliverLetters` before building files, passes results to `buildLocationMd`.
- **`buildLocationMd`** now renders a `Letters waiting for you here:` section showing sender name, day sent, and full letter content. This is the agent's inbox -- they read it at the start of each tick.

**Decisions made:**
- Letters are delivered at the sender's location, not the recipient's. If Marcus leaves a letter for Elena at the forge, Elena reads it when she's at the forge. This creates a natural reason to move to specific locations.
- `recall.sh` is not a separate HTTP call -- ZeroClaw automatically retrieves relevant memories when building its system prompt each turn. The "recall" action type still exists for agents who explicitly want to note they searched their memory.
- Letter content is stored directly in `rl_messages.content` (not as a file reference). File-based letters (the `leave_message.sh` file path pattern in TOOLS.md) are an agent-side convention; the bridge reads the `message` field of the action JSON.

---

## Open Items / Known Gaps

### Functional gaps (will affect live runs)
- **`replace AI Town LLM calls`** -- AI Town's default agents still use OpenAI. For Phase 2 standalone Rocklaw (no AI Town rendering), this doesn't matter. Defer to Phase 7 (Observation Layer) when we wire the visual layer.
- **Inventory mutations** -- `buy`, `sell`, `craft`, `give`, `trade`, `eat` don't currently update inventory in Convex (no item transfer logic). The price engine recalculates after these actions, but the actual inventory numbers don't change. Fix in Phase 5 or as a standalone patch.
- **`busyUntilTick` cleanup** -- if an agent sets `duration_ticks > 1`, they're marked busy. But when `busyUntilTick <= tick`, `getNonBusyAgents` should flip `busy = false`. Currently it just filters; the flag stays set. Could cause a permanently-busy agent if the engine restarts between ticks. Minor.
- **worldRefresh path resolution** -- `path.resolve(workspacePath, 'world')` resolves relative to Convex process CWD. Works in local dev (CWD = project root). Will break in production Convex cloud. Fix: store absolute paths, or use an environment variable.

### Design decisions still open
- **Letter file path convention** -- TOOLS.md tells agents to call `leave_message.sh marcus "self/messages/outbox/to_marcus_day6.md"`. The bridge reads the `message` field of the JSON action, not a file. Agents may try to write to outbox files first. This is fine -- ZeroClaw's write tool will create the file, but the bridge will still use the inline `message` field. May want to align the TOOLS.md description.
- **Social file writes** -- agents can choose `write` action to update `self/social/<name>/private.md`. ZeroClaw's built-in write tool handles the actual file write. The bridge doesn't need to do anything special for `write` actions. Social state evolves purely on disk.
- **`eavesdrop` action** -- currently just logged. Should it write to HEARTBEAT or inject a context note next tick? Defer to Phase 4 polish.

---

## Branch

All development on: `claude/start-rocklaw-build-bknBO`
