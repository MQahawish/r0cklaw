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
| 5 | God-Mode Dashboard | ✅ Complete (pending live verify) |
| 6 | Compaction and Stability | ✅ Complete (pending live verify) |
| 7 | Observation Layer | ✅ Complete (pending live verify) |
| 8 | Systems Layer | ✅ Complete (pending live verify) |

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

## Phase 5 -- God-Mode Dashboard ✅

**What was built:**

`convex/rocklaw/god.ts` -- new file:
- `getDashboard` public query -- returns full world snapshot: agents, activeEvents, recentActions, prices, recentPrayers, tension object, worldState
- `injectEvent` public mutation -- inserts into `rl_world_events` with `source: 'god'`; shows in all agents' `village_news.md` next tick automatically
- `resolveEvent` public mutation -- marks an event resolved
- `startSim` / `stopSim` public mutations -- god controls the engine from the dashboard
- `suggestEvents` public action -- calls OpenRouter (gemini-flash-1.5) with full world snapshot, returns 5 event suggestions as structured JSON; falls back to 5 hardcoded suggestions if `OPENROUTER_API_KEY` not set or call fails
- `computeTension` internal helper -- scores world tension 0-100 from: agent physical stress (energy/health/hunger), economic shortages, stale unanswered letters, active high-severity events

`src/components/GodDashboard.tsx` -- new file:
- Modal overlay triggered by ⚡ God Mode button in footer
- Three-column layout: agents | events + injection | world log + economy + prayers
- Agent cards: click to expand inventory; energy/health/hunger mini bars; busy indicator
- Active events list with one-click resolve
- Event injection: AI suggestions panel (calls `suggestEvents`) + custom event form with type/description/severity
- World log: scrolling feed of recent actions with outcome colours
- Economy panel: all prices, shortage highlights
- Prayers panel: private god-only feed of agent prayers

`src/App.tsx`:
- Added `GodDashboard` import
- Added `godModeOpen` state
- Added ⚡ God Mode button to footer
- Dashboard renders as overlay when open

**Decisions made:**
- `injectEvent` writes directly to `rl_world_events`. No extra plumbing needed -- `buildVillageNewsMd` already reads active events every tick.
- Tension score is a simple additive formula capped at 100. Enough to be a meaningful signal without overcalibrating.
- `suggestEvents` uses gemini-flash-1.5 for cost. One call per button press, not automatic.
- Suggestions fall back to 5 hardcoded events if no API key or call fails. Dashboard works offline.
- Start/stop wired directly into god.ts to avoid needing the footer buttons.

---

## Phase 6 -- Compaction and Stability ✅

**What was built:**

`convex/rocklaw/compact.ts` (new):
- `runCompaction` internalAction -- loops all agents sequentially; triggered by the world clock every 10 ticks
- `compactAgent` internalAction -- checks each file for one agent; compacts if over threshold
- `compactIfOver` helper -- reads file, counts lines, calls compact fn if threshold exceeded, writes result
- `compactSentLog` helper -- keeps last 5 sent_log entries verbatim, LLM-summarises older ones
- `summariseWithLLM` helper -- calls OpenRouter (gemini-flash-1.5, temp 0.3) for summarisation; falls back to line truncation if no API key
- File thresholds: `05_MEMORY.md` > 150 lines, `self/beliefs.md` > 60 lines, `self/messages/sent_log.md` > 20 entries, `self/social/*/private.md` > 80 lines
- `06_HEARTBEAT.md` -- already managed inline in `appendHeartbeat` (max 7 entries), not touched by compact
- Social private files: gracefully skipped if `self/social/` doesn't exist yet (requires agents to have formed relationships first)

`convex/rocklaw/engine.ts` (refactored -- action-driven ticks):
- `runRocklawTick` no longer fires agents. It is now purely the **world clock**: advance time, clear busy flags, trigger compaction every 10 ticks, reschedule itself
- `startRocklaw` now starts the world clock AND kicks off one `bridge.tickAgent` per agent
- `manualTick` passes `_manual: true` to skip self-scheduling
- Exported `TICK_INTERVAL_MS` so bridge can import it

`convex/rocklaw/bridge.ts` (refactored -- self-scheduling):
- `tickAgent` args: `{ agentName, _manual? }` -- tick/day/timeOfDay read from world state at call time, not passed in
- After committing an action with `duration_ticks: N`, schedules next `tickAgent` in `N * TICK_INTERVAL_MS` ms
- Graceful shutdown: checks `worldState.isRunning` at start; exits loop if false
- Gateway failure / parse failure: retries after one tick interval rather than dropping the agent loop permanently
- Busy at call time: retries in `TICK_INTERVAL_MS / 2` (handles edge case where scheduling fires before `busyUntilTick` cleared)

`convex/rocklaw/god.ts` (updated):
- `startSim` / `stopSim` now correctly start all agent loops (not just the world clock)

**Decisions made:**
- Compaction uses LLM (gemini-flash-1.5) for all summary types. temp 0.3 to keep summaries coherent and consistent. Falls back to line truncation if no API key.
- Agents run truly asynchronously now. Sera doing `serve` (1 tick) ticks every 30s; Finn doing `harvest` (3 ticks) ticks every 90s. World time still advances globally.
- `_manual` flag avoids self-scheduling in test/manual mode so one `manualTick` call doesn't accidentally start a production loop.
- Agent loop never dies permanently on errors — gateway failures and parse failures reschedule rather than dropping.

---

## Open Items / Known Gaps

### Functional gaps (will affect live runs)
- **`replace AI Town LLM calls`** -- AI Town's default agents still use OpenAI. For Phase 2 standalone Rocklaw (no AI Town rendering), this doesn't matter. Defer to Phase 7 (Observation Layer) when we wire the visual layer.
- **worldRefresh path resolution** -- `path.resolve(workspacePath, 'world')` resolves relative to Convex process CWD. Works in local dev (CWD = project root). Will break in production Convex cloud. Fix: store absolute paths, or use an environment variable.

### Fixed in pre-Phase-5 patch
- ✅ **Inventory mutations** -- buy/sell/craft/give/trade/eat now apply consumes/produces to inventory and coin
- ✅ **`busyUntilTick` cleanup** -- clearStaleBusy mutation runs each tick
- ✅ **leave_message TOOLS.md** -- all 8 agents now show inline message content, not file path
- ✅ **eavesdrop context** -- overheard note stored as pendingNote, injected into location.md next tick

---

## Branch

All development on: `claude/multi-agent-village-sim-CT24z`
