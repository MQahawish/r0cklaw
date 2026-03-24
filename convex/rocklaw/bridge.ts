/**
 * HTTP Bridge -- connects AI Town's tick scheduler to ZeroClaw agent gateways.
 *
 * For each villager tick:
 *   1. Refresh world/ files in the agent's workspace from Convex
 *   2. Check for unanswered letters and inject warnings if threshold exceeded
 *   3. POST minimal tick message to ZeroClaw gateway
 *   4. Parse the returned JSON action
 *   5. Validate and commit the action to Convex world state
 *   6. Append one line to agent's HEARTBEAT.md
 */

import { v } from 'convex/values';
import { internalAction, internalMutation, internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';

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
 * Runs a single tick for one agent.
 * Called by the Convex scheduler (see crons / main engine).
 */
export const tickAgent = internalAction({
  args: {
    agentName: v.string(),
    tick: v.number(),
    day: v.number(),
    timeOfDay: v.string(),
  },
  handler: async (ctx, args) => {
    const { agentName, tick, day, timeOfDay } = args;

    // 1. Load agent state from Convex
    const agent = await ctx.runQuery(internal.rocklaw.bridge.getAgent, { agentName });
    if (!agent) {
      console.error(`[bridge] Agent not found: ${agentName}`);
      return;
    }
    if (agent.busy) {
      console.log(`[bridge] ${agentName} is busy until tick ${agent.busyUntilTick}, skipping`);
      return;
    }

    // 2. Refresh world/ files on disk before the tick fires
    await ctx.runAction(internal.rocklaw.worldRefresh.refreshWorldFiles, {
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

    // 5. Call ZeroClaw gateway
    let rawResponse: string;
    try {
      rawResponse = await callZeroClawGateway(agent.gatewayPort, tickMessage);
    } catch (err) {
      console.error(`[bridge] Gateway call failed for ${agentName}:`, err);
      return;
    }

    // 6. Parse JSON action from response (ZeroClaw may include prose before the JSON block)
    const action = extractAction(rawResponse);
    if (!action) {
      console.error(`[bridge] Could not parse action from ${agentName}'s response:\n${rawResponse}`);
      return;
    }

    // 7. Validate
    if (!validateAction(action)) {
      console.error(`[bridge] Invalid action from ${agentName}:`, action);
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
    await ctx.runAction(internal.rocklaw.worldRefresh.appendHeartbeat, {
      agentName,
      line: summariseAction(action, day, timeOfDay, result?.outcome, result?.note),
    });

    console.log(`[bridge] ${agentName} tick ${tick} complete: ${action.action} → ${action.target ?? 'null'} [${result?.outcome ?? 'success'}]`);
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

// Minimum energy required to attempt a high-effort action.
const MIN_ENERGY_FOR_HARD_WORK = 15;

// Health lost per tick when energy is at zero (sustained exhaustion).
const HEALTH_DRAIN_PER_ZERO_ENERGY_TICK = 10;

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

    // ── Energy gate ────────────────────────────────────────────────────────
    // High-effort actions fail if the agent is too exhausted.
    const isExhausted = HIGH_EFFORT_ACTIONS.has(parsed.action) &&
      agentDoc.energy < MIN_ENERGY_FOR_HARD_WORK;

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

      return { outcome: 'failed', note: failNote };
    }

    // ── Normal path ────────────────────────────────────────────────────────
    const newEnergy = Math.max(0, Math.min(100, agentDoc.energy - energyCost));
    const newHunger = Math.min(100, agentDoc.hunger + 5); // hunger rises every tick

    // Health degradation: if energy was already zero before this tick, health suffers.
    const sustainedExhaustion = agentDoc.energy === 0 && parsed.action !== 'sleep' && parsed.action !== 'rest';
    const newHealth = sustainedExhaustion
      ? Math.max(0, agentDoc.health - HEALTH_DRAIN_PER_ZERO_ENERGY_TICK)
      : agentDoc.health;

    // Handle prayer -- log it but apply no world changes
    if (parsed.action === 'pray' && parsed.message) {
      await ctx.db.insert('rl_prayers', { agentName, message: parsed.message, tick, day });
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

    // Update agent state
    await ctx.db.patch(agentDoc._id, {
      energy: newEnergy,
      health: newHealth,
      hunger: newHunger,
      location: newLocation,
      busy: parsed.duration_ticks > 1,
      busyUntilTick: parsed.duration_ticks > 1 ? tick + parsed.duration_ticks : undefined,
    });

    // Recalculate market prices if inventory changed
    if (['buy', 'sell', 'craft', 'give', 'trade', 'eat'].includes(parsed.action)) {
      await ctx.scheduler.runAfter(0, internal.rocklaw.priceEngine.recalculate, {});
    }

    return { outcome: 'success', note: outcomeNote };
  },
});
