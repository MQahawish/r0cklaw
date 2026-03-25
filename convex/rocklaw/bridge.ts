/**
 * HTTP Bridge -- connects the action-driven agent loop to ZeroClaw gateways.
 *
 * Phase 6 change: tickAgent is now self-scheduling.
 *   - Arguments: just { agentName } (tick/day/timeOfDay read from world state at call time)
 *   - After committing the action, schedules the next tick at duration_ticks * TICK_INTERVAL_MS
 *   - Exits silently if isRunning = false (allows graceful shutdown)
 *   - _manual: true skips self-scheduling (used by manualTick in engine.ts)
 *
 * For each villager tick:
 *   1. Read current tick/day/timeOfDay from world state
 *   2. Refresh world/ files in the agent's workspace from Convex
 *   3. Check for unanswered letters and inject warnings if threshold exceeded
 *   4. POST minimal tick message to ZeroClaw gateway
 *   5. Parse the returned JSON action
 *   6. Validate and commit the action to Convex world state
 *   7. Append one line to agent's HEARTBEAT.md
 *   8. Self-schedule next tick in duration_ticks * TICK_INTERVAL_MS
 */

import { v } from 'convex/values';
import { internalAction, internalMutation, internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';
import { TICK_INTERVAL_MS } from './engine';

// ── Types ────────────────────────────────────────────────────────────────────

export type RocklawAction = {
  action: string;
  target: string | null;
  duration_ticks: number;
  message?: string;
  consumes: string[];
  produces: string[];
  memory_note?: string;
};

const VALID_ACTIONS = new Set([
  // Universal
  'talk', 'move', 'rest', 'sleep', 'eat', 'buy', 'sell', 'pay', 'give', 'trade',
  'observe', 'write', 'pray', 'leave_message', 'recall',
  // Blacksmith (Elena)
  'craft', 'repair', 'smelt', 'appraise',
  // Merchant (Marcus)
  'negotiate', 'post_price', 'bulk_buy',
  // Farmer (Finn)
  'harvest', 'plant', 'water', 'check_field',
  // Herbalist (Lena)
  'gather', 'brew', 'treat', 'identify',
  // Innkeeper (Sera)
  'serve', 'rent_room', 'eavesdrop', 'post_notice',
  // Priest (Aldric)
  'bless', 'counsel', 'preach', 'officiate',
  // Child (Cora)
  'play', 'run_errand',
  // Retired Soldier (Rook)
  'patrol', 'train', 'recall_war',
]);

// Effort costs per action (deducted from energy after completion)
const EFFORT_COSTS: Record<string, number> = {
  // Physical labour
  craft: 30, smelt: 40, repair: 20, mine: 45,
  harvest: 35, plant: 30, water: 15, check_field: 5,
  gather: 15, brew: 10, treat: 8, identify: 3,
  patrol: 25, train: 20,
  // Commerce & social
  negotiate: 5, bulk_buy: 3, post_price: 1, appraise: 2,
  serve: 5, rent_room: 3, eavesdrop: 2, post_notice: 2,
  bless: 3, counsel: 4, preach: 6, officiate: 8,
  play: -10,  // play restores child energy
  run_errand: 8, recall_war: 2,
  // Universal
  move: 5, talk: 2, buy: 2, sell: 2, pay: 1, give: 1,
  trade: 2, observe: 1, write: 2, pray: 0,
  leave_message: 2, recall: 0,
  eat: 0, rest: -40, sleep: -100,
};

// ── Main tick action ─────────────────────────────────────────────────────────

/**
 * Runs a single tick for one agent (action-driven, self-scheduling).
 *
 * Args:
 *   agentName  -- which agent to tick
 *   _manual    -- if true, skip self-scheduling (used by manualTick)
 */
export const tickAgent = internalAction({
  args: {
    agentName: v.string(),
    _manual: v.optional(v.boolean()),
  },
  handler: async (ctx, { agentName, _manual }) => {
    // 0. Check if the sim is still running (allows graceful stop without cancelling scheduled jobs)
    const worldState = await ctx.runQuery(internal.rocklaw.engine.getWorldState);
    if (!worldState) {
      console.error(`[bridge] No world state — ${agentName} tick aborted`);
      return;
    }
    if (!worldState.isRunning && !_manual) {
      console.log(`[bridge] ${agentName}: sim stopped, agent loop exiting`);
      return;
    }

    const { tick, day, timeOfDay } = worldState;

    // 1. Load agent state from Convex
    const agent = await ctx.runQuery(internal.rocklaw.bridge.getAgent, { agentName });
    if (!agent) {
      console.error(`[bridge] Agent not found: ${agentName}`);
      return;
    }
    // Pause check -- god-mode can suspend individual agents
    if (agent.paused && !_manual) {
      console.log(`[bridge] ${agentName} is paused — tick skipped`);
      return;
    }
    if (agent.busy) {
      // Agent was already re-scheduled but wasn't fully cleared yet — check again soon
      const waitMs = TICK_INTERVAL_MS / 2;
      if (!_manual) {
        await ctx.scheduler.runAfter(waitMs, internal.rocklaw.bridge.tickAgent, { agentName });
      }
      console.log(`[bridge] ${agentName} still busy, retrying in ${waitMs}ms`);
      return;
    }

    // 2. Refresh world/ files on disk before the tick fires
    await ctx.runAction(internal.rocklaw.worldRefreshNode.refreshWorldFiles, {
      agentName,
      tick,
      day,
      timeOfDay,
    });

    // 3. Check for unanswered letters, inject warning if > 3 ticks old
    const letterWarning = await ctx.runQuery(internal.rocklaw.bridge.checkUnreadLetters, {
      agentName,
      currentTick: tick,
    });

    // 4. Build tick message
    const tickMessage = buildTickMessage(day, timeOfDay, letterWarning ?? undefined);

    // 5. Call ZeroClaw gateway (with optional per-agent model override)
    let rawResponse: string;
    try {
      rawResponse = await callZeroClawGateway(agent.gatewayPort, tickMessage);
    } catch (err) {
      console.error(`[bridge] Gateway call failed for ${agentName}:`, err);
      // Retry after one tick interval — don't drop the agent loop
      if (!_manual) {
        await ctx.scheduler.runAfter(TICK_INTERVAL_MS, internal.rocklaw.bridge.tickAgent, { agentName });
      }
      return;
    }

    // 6. Parse JSON action from response (ZeroClaw may include prose before the JSON block)
    const action = extractAction(rawResponse);
    if (!action) {
      console.error(`[bridge] Could not parse action from ${agentName}'s response:\n${rawResponse}`);
      await ctx.runMutation(internal.rocklaw.bridge.setAgentPendingNote, {
        agentName,
        note: 'SYSTEM: Your last response could not be parsed as valid JSON. You MUST respond with a valid JSON action block. No prose outside the JSON.',
      });
      if (!_manual) {
        await ctx.scheduler.runAfter(TICK_INTERVAL_MS, internal.rocklaw.bridge.tickAgent, { agentName });
      }
      return;
    }

    // 7. Validate
    if (!validateAction(action)) {
      console.error(`[bridge] Invalid action from ${agentName}:`, action);
      await ctx.runMutation(internal.rocklaw.bridge.setAgentPendingNote, {
        agentName,
        note: `SYSTEM: Your last action JSON was structurally invalid (missing required fields or unknown action type). Valid action types: move, work, buy, sell, trade, sleep, rest, eat, talk, give, steal, pray, eavesdrop, leave_message, idle.`,
      });
      if (!_manual) {
        await ctx.scheduler.runAfter(TICK_INTERVAL_MS, internal.rocklaw.bridge.tickAgent, { agentName });
      }
      return;
    }

    // 8. Commit action to Convex world state
    const result = await ctx.runMutation(internal.rocklaw.bridge.commitAction, {
      agentName,
      action: JSON.stringify(action),
      tick,
      day,
    });

    // 9. Append to HEARTBEAT.md (world engine only -- agent never writes this)
    await ctx.runAction(internal.rocklaw.worldRefreshNode.appendHeartbeat, {
      agentName,
      line: summariseAction(action, day, timeOfDay, result?.outcome, result?.note),
    });

    const durationTicks = Math.max(1, action.duration_ticks ?? 1);
    const nextMs = durationTicks * TICK_INTERVAL_MS;

    console.log(`[bridge] ${agentName} tick ${tick}: ${action.action} → ${action.target ?? 'null'} [${result?.outcome ?? 'success'}] next in ${nextMs}ms`);

    // 10. Self-schedule next tick based on how long this action takes
    if (!_manual) {
      await ctx.scheduler.runAfter(nextMs, internal.rocklaw.bridge.tickAgent, { agentName });
    }
  },
});

// ── ZeroClaw gateway call ────────────────────────────────────────────────────

async function callZeroClawGateway(port: number, message: string): Promise<string> {
  const url = `http://127.0.0.1:${port}/webhook`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!response.ok) {
    throw new Error(`ZeroClaw gateway returned ${response.status}: ${await response.text()}`);
  }
  const data = (await response.json()) as { response: string; model?: string };
  return data.response;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildTickMessage(day: number, timeOfDay: string, letterWarning?: string): string {
  let msg = `It is ${timeOfDay}, Day ${day}. What do you do?`;
  if (letterWarning) {
    msg += `\n\n${letterWarning}`;
  }
  return msg;
}

/**
 * Extracts the JSON action block from ZeroClaw's response.
 * The LLM may include reasoning prose before the final JSON -- we want the last valid JSON object.
 */
function extractAction(response: string): RocklawAction | null {
  // Try to find a JSON block (```json ... ``` or bare {...})
  const jsonBlockMatch = response.match(/```json\s*([\s\S]*?)```/);
  if (jsonBlockMatch) {
    try { return JSON.parse(jsonBlockMatch[1].trim()); } catch { /* fall through */ }
  }

  // Try last JSON object in the response
  const jsonMatches = [...response.matchAll(/\{[\s\S]*?\}/g)];
  for (let i = jsonMatches.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(jsonMatches[i][0]);
      if (parsed.action) return parsed;
    } catch { /* keep looking */ }
  }
  return null;
}

function validateAction(action: RocklawAction): boolean {
  return (
    typeof action.action === 'string' &&
    VALID_ACTIONS.has(action.action) &&
    typeof action.duration_ticks === 'number' &&
    action.duration_ticks >= 1 &&
    Array.isArray(action.consumes) &&
    Array.isArray(action.produces)
  );
}

function summariseAction(
  action: RocklawAction,
  day: number,
  timeOfDay: string,
  outcome?: string,
  outcomeNote?: string | null,
): string {
  const target = action.target ? ` → ${action.target}` : '';
  const note = action.message ? ` (${action.message.slice(0, 60)})` : '';
  const failed = outcome === 'failed' ? ' [FAILED]' : '';
  const warning = outcomeNote ? ` ⚠ ${outcomeNote.slice(0, 80)}` : '';
  return `- Day ${day} ${timeOfDay}: ${action.action}${target}${note}${failed}${warning}`;
}

// ── Inventory helpers ─────────────────────────────────────────────────────────

/**
 * Parses a list of item strings (e.g. ["coal:3", "iron_ore", "coin:10"])
 * into a Record<itemName, quantity>.
 */
function parseItemList(items: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const entry of items) {
    const colonIdx = entry.lastIndexOf(':');
    let name: string;
    let qty: number;
    if (colonIdx > 0) {
      name = entry.slice(0, colonIdx).trim();
      qty = parseInt(entry.slice(colonIdx + 1), 10);
      if (isNaN(qty) || qty <= 0) qty = 1;
    } else {
      name = entry.trim();
      qty = 1;
    }
    result[name] = (result[name] ?? 0) + qty;
  }
  return result;
}

/**
 * Applies consumes/produces to inventory and coin.
 * Returns updated inventory (JSON string) and coin.
 * Never goes below zero for any item.
 */
function applyInventoryChanges(
  inventoryJson: string,
  coin: number,
  consumes: string[],
  produces: string[],
  _action: string,
): { newInventory: string; newCoin: number } {
  const inv = JSON.parse(inventoryJson) as Record<string, number>;
  let newCoin = coin;

  const toConsume = parseItemList(consumes);
  const toProduce = parseItemList(produces);

  for (const [item, qty] of Object.entries(toConsume)) {
    if (item === 'coin') {
      newCoin = Math.max(0, newCoin - qty);
    } else {
      inv[item] = Math.max(0, (inv[item] ?? 0) - qty);
      if (inv[item] === 0) delete inv[item];
    }
  }

  for (const [item, qty] of Object.entries(toProduce)) {
    if (item === 'coin') {
      newCoin += qty;
    } else {
      inv[item] = (inv[item] ?? 0) + qty;
    }
  }

  return { newInventory: JSON.stringify(inv), newCoin };
}

// ── Convex queries / mutations ───────────────────────────────────────────────

export const getAgent = internalQuery({
  args: { agentName: v.string() },
  handler: async (ctx, { agentName }) => {
    return ctx.db.query('rl_agents').withIndex('name', (q) => q.eq('name', agentName)).unique();
  },
});

export const checkUnreadLetters = internalQuery({
  args: { agentName: v.string(), currentTick: v.number() },
  handler: async (ctx, { agentName, currentTick }) => {
    // Find outbound letters from this agent with no reply and sent > 3 ticks ago
    const oldUnreplied = await ctx.db
      .query('rl_messages')
      .withIndex('fromAgent', (q) => q.eq('fromAgent', agentName))
      .filter((q) =>
        q.and(
          q.eq(q.field('status'), 'unread'),
          q.lt(q.field('tickSent'), currentTick - 3),
        ),
      )
      .collect();

    if (oldUnreplied.length === 0) return null;

    const warnings = oldUnreplied.map((m) => {
      const waitDays = Math.floor((currentTick - m.tickSent) / 3); // ~3 ticks per day
      return `Your letter to ${m.toAgent} (Day ${m.daySent}) has not been answered. It has been ${waitDays} day${waitDays > 1 ? 's' : ''}.`;
    });
    return warnings.join('\n');
  },
});

// Actions requiring significant physical effort -- gated by energy.
// Low-effort actions (talk, pray, observe, write, eat, rest, sleep) always proceed.
const HIGH_EFFORT_ACTIONS = new Set([
  'craft', 'smelt', 'repair', 'mine', 'harvest', 'plant', 'water',
  'patrol', 'train', 'gather', 'brew', 'treat',
]);

// These fall back to the hardcoded defaults below if rl_systems_state has no override.
const DEFAULT_MIN_ENERGY_FOR_HARD_WORK = 15;
const DEFAULT_HEALTH_DRAIN_PER_ZERO_ENERGY_TICK = 10;

async function readSystemFloat(ctx: any, systemName: string, key: string, defaultVal: number) {
  const row = await ctx.db
    .query('rl_systems_state')
    .withIndex('system', (q: any) => q.eq('systemName', systemName).eq('key', key))
    .unique();
  if (!row) return defaultVal;
  const v = parseFloat(row.value);
  return isNaN(v) ? defaultVal : v;
}

export const setAgentPendingNote = internalMutation({
  args: { agentName: v.string(), note: v.string() },
  handler: async (ctx, { agentName, note }) => {
    const agent = await ctx.db
      .query('rl_agents')
      .withIndex('name', (q) => q.eq('name', agentName))
      .unique();
    if (agent) await ctx.db.patch(agent._id, { pendingNote: note });
  },
});

export const commitAction = internalMutation({
  args: {
    agentName: v.string(),
    action: v.string(),  // JSON-stringified RocklawAction
    tick: v.number(),
    day: v.number(),
  },
  handler: async (ctx, { agentName, action, tick, day }) => {
    const parsed: RocklawAction = JSON.parse(action);
    const agentDoc = await ctx.db
      .query('rl_agents')
      .withIndex('name', (q) => q.eq('name', agentName))
      .unique();
    if (!agentDoc) return { outcome: 'failed', note: 'Agent not found' };

    const energyCost = EFFORT_COSTS[parsed.action] ?? 5;

    // ── Reputation gating ───────────────────────────────────────────────────
    // Low-rep agents (<20) are refused service at social locations.
    const SOCIALLY_GATED_ACTIONS = new Set(['treat', 'counsel', 'serve', 'rent_room', 'buy', 'bless']);
    const GATED_LOCATIONS = new Set(['shrine', 'inn', 'market']);
    if (SOCIALLY_GATED_ACTIONS.has(parsed.action) && GATED_LOCATIONS.has(agentDoc.location)) {
      const rep = await ctx.db
        .query('rl_reputation')
        .withIndex('agentName', (q) => q.eq('agentName', agentName))
        .unique();
      if ((rep?.score ?? 50) < 20) {
        const failNote = `Refused service — your reputation (${rep?.score ?? 50}/100) is too low here.`;
        await ctx.db.insert('rl_actions_log', {
          agentName, action: parsed.action, target: parsed.target ?? undefined,
          message: parsed.message, tick, day, outcome: 'failed', outcomeNote: failNote,
        });
        await ctx.db.patch(agentDoc._id, { busy: false });
        return { outcome: 'failed', note: failNote };
      }
    }

    // Read live system knobs (fall back to defaults if not configured)
    const minEnergyForHardWork = await readSystemFloat(ctx, 'agents', 'min_energy_for_hard_work', DEFAULT_MIN_ENERGY_FOR_HARD_WORK);
    const healthDrainPerZeroTick = await readSystemFloat(ctx, 'agents', 'health_drain_per_zero_tick', DEFAULT_HEALTH_DRAIN_PER_ZERO_ENERGY_TICK);

    // ── Energy gate ────────────────────────────────────────────────────────
    // High-effort actions fail if the agent is too exhausted.
    const isExhausted = HIGH_EFFORT_ACTIONS.has(parsed.action) &&
      agentDoc.energy < minEnergyForHardWork;

    if (isExhausted) {
      const failNote = `Too exhausted to ${parsed.action}. Energy: ${agentDoc.energy}/100. Rest first.`;
      // Attempting still costs a small effort
      const penaltyEnergy = Math.max(0, agentDoc.energy - 3);
      const newHunger = Math.min(100, agentDoc.hunger + 5);

      await ctx.db.insert('rl_actions_log', {
        agentName,
        action: parsed.action,
        target: parsed.target ?? undefined,
        message: parsed.message,
        tick,
        day,
        outcome: 'failed',
        outcomeNote: failNote,
      });

      await ctx.db.patch(agentDoc._id, {
        energy: penaltyEnergy,
        hunger: newHunger,
      });

      // Failing on a targeted action is a broken promise — small rep hit
      if (parsed.target) {
        await ctx.scheduler.runAfter(0, internal.rocklaw.reputation.updateReputation, {
          agentName, delta: -3, note: `failed ${parsed.action} (exhausted)`, tick,
        });
      }

      return { outcome: 'failed', note: failNote };
    }

    // ── Normal path ────────────────────────────────────────────────────────
    const newEnergy = Math.max(0, Math.min(100, agentDoc.energy - energyCost));
    const newHunger = Math.min(100, agentDoc.hunger + 5); // hunger rises every tick

    // Health degradation: if energy was already zero before this tick, health suffers.
    const sustainedExhaustion = agentDoc.energy === 0 && parsed.action !== 'sleep' && parsed.action !== 'rest';
    const newHealth = sustainedExhaustion
      ? Math.max(0, agentDoc.health - healthDrainPerZeroTick)
      : agentDoc.health;

    // Handle prayer -- log it but apply no world changes
    if (parsed.action === 'pray' && parsed.message) {
      await ctx.db.insert('rl_prayers', { agentName, message: parsed.message, tick, day });
    }

    // Handle eavesdrop -- store overheard note for injection into next tick's world files
    if (parsed.action === 'eavesdrop' && parsed.message) {
      await ctx.db.patch(agentDoc._id, {
        pendingNote: `You overheard: "${parsed.message}"`,
      });
    }

    // Handle letter -- insert into rl_messages for delivery at current location
    if (parsed.action === 'leave_message' && parsed.target && parsed.message) {
      const locationDoc = await ctx.db
        .query('rl_locations')
        .withIndex('name', (q) => q.eq('name', agentDoc.location))
        .unique();
      await ctx.db.insert('rl_messages', {
        fromAgent: agentName,
        toAgent: parsed.target,
        content: parsed.message,
        status: 'unread',
        deliveryLocationId: locationDoc?._id ?? undefined,
        daySent: day,
        tickSent: tick,
      });
    }

    // Apply movement
    let newLocation = agentDoc.location;
    if (parsed.action === 'move' && parsed.target) {
      newLocation = parsed.target;
    }

    // ── Reputation coin modifier for trade actions ──────────────────────────
    // High rep (>70): 5% discount; low rep (<30): 10% markup on buy/sell.
    let repCoinModifier = 1.0;
    if (['buy', 'sell', 'trade'].includes(parsed.action)) {
      const rep = await ctx.db
        .query('rl_reputation')
        .withIndex('agentName', (q) => q.eq('agentName', agentName))
        .unique();
      const repScore = rep?.score ?? 50;
      if (repScore > 70) repCoinModifier = 0.95;
      else if (repScore < 30) repCoinModifier = 1.10;
    }

    // Apply inventory changes from consumes/produces
    const { newInventory, newCoin: rawCoin } = applyInventoryChanges(
      agentDoc.inventory,
      agentDoc.coin,
      parsed.consumes,
      parsed.produces,
      parsed.action,
    );
    // Apply rep modifier to coin delta only
    const coinDelta = rawCoin - agentDoc.coin;
    const newCoin = agentDoc.coin + Math.round(coinDelta * repCoinModifier);

    const outcomeNote = sustainedExhaustion
      ? 'Acting on zero energy -- health is degrading. Sleep urgently.'
      : undefined;

    // Log the action
    await ctx.db.insert('rl_actions_log', {
      agentName,
      action: parsed.action,
      target: parsed.target ?? undefined,
      message: parsed.message,
      tick,
      day,
      outcome: 'success',
      outcomeNote,
    });

    // Eating reduces hunger
    const eatingHungerReduction = parsed.action === 'eat' ? 40 : 0;
    const finalHunger = Math.max(0, newHunger - eatingHungerReduction);

    // Update agent state
    await ctx.db.patch(agentDoc._id, {
      energy: newEnergy,
      health: newHealth,
      hunger: finalHunger,
      location: newLocation,
      inventory: newInventory,
      coin: newCoin,
      busy: parsed.duration_ticks > 1,
      busyUntilTick: parsed.duration_ticks > 1 ? tick + parsed.duration_ticks : undefined,
    });

    // Recalculate market prices if inventory changed
    if (['buy', 'sell', 'craft', 'give', 'trade', 'eat'].includes(parsed.action)) {
      await ctx.scheduler.runAfter(0, internal.rocklaw.priceEngine.recalculate, {});
    }

    // ── Reputation changes ─────────────────────────────────────────────────
    const REP_DELTAS: Record<string, number> = {
      give: 2, treat: 2, counsel: 2, bless: 2, run_errand: 2,
      trade: 1, sell: 1, buy: 1,
    };
    const repDelta = REP_DELTAS[parsed.action] ?? 0;
    if (repDelta !== 0) {
      await ctx.scheduler.runAfter(0, internal.rocklaw.reputation.updateReputation, {
        agentName, delta: repDelta, note: parsed.action, tick,
      });
    }

    // ── Visual bridge: sync sprite position and activity emoji ─────────────
    const durationTicks = Math.max(1, parsed.duration_ticks ?? 1);
    const durationMs = durationTicks * TICK_INTERVAL_MS;

    if (parsed.action === 'move' && newLocation !== agentDoc.location) {
      await ctx.scheduler.runAfter(0, internal.rocklaw.visualBridge.syncAgentPosition, {
        agentName, newLocation,
      });
    }
    await ctx.scheduler.runAfter(0, internal.rocklaw.visualBridge.setAgentActivity, {
      agentName, action: parsed.action, durationMs,
    });

    return { outcome: 'success', note: outcomeNote };
  },
});
