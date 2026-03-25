/**
 * Rocklaw bridge queries and mutations.
 *
 * The live ZeroClaw transport now lives in bridgeNode.ts because Convex only
 * allows Node.js runtime modules to export actions. This file remains the
 * stateful half of the bridge: queries, mutations, validation-adjacent helpers,
 * and world-state commits.
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';
import { TICK_INTERVAL_MS } from './engine';

// ── Types ────────────────────────────────────────────────────────────────────

export type RocklawAction = {
  action: string;
  target?: string | null;
  location?: string | null;
  text?: string;
  topic?: string;
  item?: string | null;
  quantity?: number | null;
  amount?: number | null;
  offer?: unknown[];
  request?: unknown[];
  duration_ticks: number;
  thought?: string;
  message?: string;
  consumes: unknown[];
  produces: unknown[];
  memory_note?: string;
};

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

// ── Inventory helpers ─────────────────────────────────────────────────────────

/**
 * Parses a list of item strings (e.g. ["coal:3", "iron_ore", "coin:10"])
 * into a Record<itemName, quantity>.
 */
function parseItemList(items: unknown[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const entry of items) {
    const normalised = normaliseItemEntry(entry);
    if (!normalised) continue;
    let name: string;
    let qty: number;
    if (normalised.colonIdx > 0) {
      name = normalised.value.slice(0, normalised.colonIdx).trim();
      qty = parseInt(normalised.value.slice(normalised.colonIdx + 1), 10);
      if (isNaN(qty) || qty <= 0) qty = 1;
    } else {
      name = normalised.value.trim();
      qty = normalised.qty;
    }
    result[name] = (result[name] ?? 0) + qty;
  }
  return result;
}

function normaliseItemEntry(entry: unknown): { value: string; qty: number; colonIdx: number } | null {
  if (typeof entry === 'string') {
    return { value: entry, qty: 1, colonIdx: entry.lastIndexOf(':') };
  }
  if (typeof entry === 'object' && entry !== null) {
    const record = entry as Record<string, unknown>;
    const itemName = record.item ?? record.name ?? record.target;
    if (typeof itemName === 'string' && itemName.trim() !== '') {
      const qtyValue = record.qty ?? record.quantity ?? record.amount;
      const qty = typeof qtyValue === 'number'
        ? qtyValue
        : typeof qtyValue === 'string'
        ? parseInt(qtyValue, 10)
        : 1;
      return {
        value: itemName,
        qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
        colonIdx: -1,
      };
    }
  }
  return null;
}

function dedupeStringList(items: string[]): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return Array.from(counts.entries()).flatMap(([item, qty]) =>
    qty <= 1 ? [item] : [`${item}:${qty}`],
  );
}

function normaliseEntityList(entries: unknown[] | undefined): Array<{ item: string; quantity: number }> | undefined {
  if (!Array.isArray(entries)) return undefined;
  const parsed = parseItemList(entries);
  const out = Object.entries(parsed).map(([item, quantity]) => ({ item, quantity }));
  return out.length > 0 ? out : [];
}

function normaliseScalarString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed === 'null') return null;
  return trimmed;
}

function normaliseNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normaliseAction(parsed: RocklawAction): RocklawAction {
  const parsedRecord = parsed as RocklawAction & { intent?: unknown };
  const action = parsed.action;
  const target = normaliseScalarString(parsed.target);
  const location = normaliseScalarString(parsed.location);
  const item = normaliseScalarString(parsed.item);
  const text = typeof parsed.text === 'string' ? parsed.text.trim() : undefined;
  const topic = typeof parsed.topic === 'string' ? parsed.topic.trim() : undefined;
  const legacyIntent = typeof parsedRecord.intent === 'string' ? parsedRecord.intent.trim() : undefined;
  const thought = typeof parsed.thought === 'string' ? parsed.thought.trim() : legacyIntent;
  const quantity = normaliseNumber(parsed.quantity);
  const amount = normaliseNumber(parsed.amount);
  const consumes = dedupeStringList(
    (parsed.consumes ?? [])
      .map((entry) => normaliseItemEntry(entry))
      .filter((entry): entry is { value: string; qty: number; colonIdx: number } => entry !== null)
      .flatMap((entry) => Array.from({ length: entry.qty }, () => entry.value)),
  );
  const produces = dedupeStringList(
    (parsed.produces ?? [])
      .map((entry) => normaliseItemEntry(entry))
      .filter((entry): entry is { value: string; qty: number; colonIdx: number } => entry !== null)
      .flatMap((entry) => Array.from({ length: entry.qty }, () => entry.value)),
  );

  const normalized: RocklawAction = {
    ...parsed,
    target,
    location,
    text,
    topic,
    thought,
    item,
    quantity,
    amount,
    duration_ticks: Math.max(1, parsed.duration_ticks ?? 1),
    consumes,
    produces,
  };

  if (action === 'move' && !normalized.location && target) {
    normalized.location = target;
  }
  if ((action === 'talk' || action === 'leave_message' || action === 'write' || action === 'pray') && !normalized.text && parsed.message) {
    normalized.text = parsed.message;
  }
  if ((action === 'craft' || action === 'repair' || action === 'smelt' || action === 'eat' || action === 'buy' || action === 'sell' || action === 'give') && !normalized.item && target) {
    normalized.item = target;
  }
  if ((action === 'buy' || action === 'sell' || action === 'give' || action === 'eat' || action === 'craft' || action === 'smelt') && normalized.quantity == null && normalized.item) {
    normalized.quantity = 1;
  }
  if (action === 'pay' && normalized.amount == null && parsed.consumes?.length) {
    const consumed = parseItemList(parsed.consumes);
    if (typeof consumed.coin === 'number') normalized.amount = consumed.coin;
  }
  if (action === 'trade') {
    normalized.offer = Array.isArray(parsed.offer) ? normaliseEntityList(parsed.offer) : undefined;
    normalized.request = Array.isArray(parsed.request) ? normaliseEntityList(parsed.request) : undefined;
  }

  const hasInventoryDelta = normalized.consumes.length > 0 || normalized.produces.length > 0;
  if (!hasInventoryDelta) {
    switch (action) {
      case 'pay':
        if (typeof normalized.amount === 'number' && normalized.amount > 0) {
          normalized.consumes = [{ item: 'coin', quantity: normalized.amount }];
        }
        break;
      case 'buy':
        if (normalized.item && typeof normalized.quantity === 'number' && normalized.quantity > 0) {
          normalized.produces = [{ item: normalized.item, quantity: normalized.quantity }];
        }
        if (typeof normalized.amount === 'number' && normalized.amount > 0) {
          normalized.consumes = [{ item: 'coin', quantity: normalized.amount }];
        }
        break;
      case 'sell':
        if (normalized.item && typeof normalized.quantity === 'number' && normalized.quantity > 0) {
          normalized.consumes = [{ item: normalized.item, quantity: normalized.quantity }];
        }
        if (typeof normalized.amount === 'number' && normalized.amount > 0) {
          normalized.produces = [{ item: 'coin', quantity: normalized.amount }];
        }
        break;
      case 'give':
      case 'eat':
        if (normalized.item && typeof normalized.quantity === 'number' && normalized.quantity > 0) {
          normalized.consumes = [{ item: normalized.item, quantity: normalized.quantity }];
        }
        break;
      case 'trade':
        if (Array.isArray(normalized.offer) && normalized.offer.length > 0) {
          normalized.consumes = normalized.offer;
        }
        if (Array.isArray(normalized.request) && normalized.request.length > 0) {
          normalized.produces = normalized.request;
        }
        break;
    }
  }

  return normalized;
}

/**
 * Applies consumes/produces to inventory and coin.
 * Returns updated inventory (JSON string) and coin.
 * Never goes below zero for any item.
 */
function applyInventoryChanges(
  inventoryJson: string,
  coin: number,
  consumes: unknown[],
  produces: unknown[],
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
    const parsed: RocklawAction = normaliseAction(JSON.parse(action) as RocklawAction);
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
          agentName, action: parsed.action, target: parsed.target ?? parsed.location ?? undefined,
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
        target: parsed.target ?? parsed.location ?? undefined,
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
      if (parsed.target ?? parsed.location) {
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
    if (parsed.action === 'pray' && (parsed.text || parsed.message)) {
      const prayerText = parsed.text ?? parsed.message;
      if (prayerText) {
        await ctx.db.insert('rl_prayers', { agentName, message: prayerText, tick, day });
      }
    }

    // Handle eavesdrop -- store overheard note for injection into next tick's world files
    if (parsed.action === 'eavesdrop' && (parsed.text || parsed.message)) {
      const overheard = parsed.text ?? parsed.message;
      if (!overheard) {
        return { outcome: 'failed', note: 'Missing eavesdrop text' };
      }
      await ctx.db.patch(agentDoc._id, {
        pendingNote: `You overheard: "${overheard}"`,
      });
    }

    // Handle letter -- insert into rl_messages for delivery at current location
    if (parsed.action === 'leave_message' && parsed.target && (parsed.text || parsed.message)) {
      const locationDoc = await ctx.db
        .query('rl_locations')
        .withIndex('name', (q) => q.eq('name', agentDoc.location))
        .unique();
      await ctx.db.insert('rl_messages', {
        fromAgent: agentName,
        toAgent: parsed.target,
        content: parsed.text ?? parsed.message ?? '',
        status: 'unread',
        deliveryLocationId: locationDoc?._id ?? undefined,
        daySent: day,
        tickSent: tick,
      });
    }

    // Apply movement
    let newLocation = agentDoc.location;
    if (parsed.action === 'move' && (parsed.location ?? parsed.target)) {
      newLocation = parsed.location ?? parsed.target ?? agentDoc.location;
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
      target: parsed.target ?? parsed.location ?? parsed.item ?? undefined,
      message: parsed.text ?? parsed.message,
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
