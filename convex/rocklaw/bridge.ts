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

type TransactionItem = { item: string; quantity: number };

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
  trade: 2, accept_transaction: 1, reject_transaction: 1, observe: 1, write: 2, pray: 0,
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

function inventoryHasAtLeast(inventoryJson: string, item: string, required: number): boolean {
  const inv = JSON.parse(inventoryJson) as Record<string, number>;
  return (inv[item] ?? 0) >= required;
}

function formatInventoryShortfall(inventoryJson: string, consumes: unknown[]): string | null {
  const inv = JSON.parse(inventoryJson) as Record<string, number>;
  const needed = parseItemList(consumes);

  for (const [item, qty] of Object.entries(needed)) {
    if (item === 'coin') continue;
    const have = inv[item] ?? 0;
    if (have < qty) {
      return `Not enough ${item}: need ${qty}, have ${have}.`;
    }
  }

  return null;
}

async function targetAgentAtSameLocation(ctx: any, actorLocation: string, targetName: string) {
  const targetAgent = await ctx.db
    .query('rl_agents')
    .withIndex('name', (q: any) => q.eq('name', targetName))
    .unique();
  if (!targetAgent) return { ok: false, note: `Target agent not found: ${targetName}.` };
  if (targetAgent.location !== actorLocation) {
    return { ok: false, note: `${targetName} is not at your location (${actorLocation}).` };
  }
  return { ok: true, targetAgent };
}

async function validateWorldExecution(ctx: any, agentDoc: any, parsed: RocklawAction) {
  const destination = parsed.location ?? parsed.target ?? null;

  if (Array.isArray(parsed.consumes) && parsed.consumes.length > 0) {
    const missingInventory = formatInventoryShortfall(agentDoc.inventory, parsed.consumes);
    if (missingInventory) return { ok: false, note: missingInventory };

    const needed = parseItemList(parsed.consumes);
    if (typeof needed.coin === 'number' && agentDoc.coin < needed.coin) {
      return { ok: false, note: `Not enough coin: need ${needed.coin}c, have ${agentDoc.coin}c.` };
    }
  }

  switch (parsed.action) {
    case 'move': {
      if (!destination) return { ok: false, note: 'Move requires a destination location.' };
      const locationDoc = await ctx.db
        .query('rl_locations')
        .withIndex('name', (q: any) => q.eq('name', destination))
        .unique();
      if (!locationDoc) return { ok: false, note: `Unknown location: ${destination}.` };
      if (destination === agentDoc.location) return { ok: false, note: `You are already at ${destination}.` };
      return { ok: true };
    }
    case 'talk':
    case 'pay':
    case 'buy':
    case 'sell':
    case 'give':
    case 'trade': {
      if (!parsed.target) return { ok: false, note: `${parsed.action} requires a target agent.` };
      const targetCheck = await targetAgentAtSameLocation(ctx, agentDoc.location, parsed.target);
      if (!targetCheck.ok) return targetCheck;

      if ((parsed.action === 'buy' || parsed.action === 'sell' || parsed.action === 'give') && !parsed.item) {
        return { ok: false, note: `${parsed.action} requires an item.` };
      }
      if ((parsed.action === 'buy' || parsed.action === 'sell' || parsed.action === 'give') && (!parsed.quantity || parsed.quantity < 1)) {
        return { ok: false, note: `${parsed.action} requires a positive quantity.` };
      }
      if (parsed.action === 'pay' && (!parsed.amount || parsed.amount <= 0)) {
        return { ok: false, note: 'Pay requires a positive amount.' };
      }
      if (parsed.action === 'buy') {
        if (typeof parsed.amount !== 'number' || parsed.amount <= 0) {
          return { ok: false, note: 'Buy requires a positive amount.' };
        }
        if (agentDoc.coin < parsed.amount) {
          return { ok: false, note: `Not enough coin: need ${parsed.amount}c, have ${agentDoc.coin}c.` };
        }
      }
      if (parsed.action === 'sell') {
        if (typeof parsed.amount !== 'number' || parsed.amount <= 0) {
          return { ok: false, note: 'Sell requires a positive amount.' };
        }
        if (!inventoryHasAtLeast(agentDoc.inventory, parsed.item!, parsed.quantity!)) {
          const sellerInv = JSON.parse(agentDoc.inventory) as Record<string, number>;
          return {
            ok: false,
            note: `Not enough ${parsed.item}: need ${parsed.quantity}, have ${sellerInv[parsed.item!] ?? 0}.`,
          };
        }
      }
      if (parsed.action === 'trade') {
        if (!Array.isArray(parsed.offer) || parsed.offer.length === 0) {
          return { ok: false, note: 'Trade requires a non-empty offer.' };
        }
        if (!Array.isArray(parsed.request) || parsed.request.length === 0) {
          return { ok: false, note: 'Trade requires a non-empty request.' };
        }
        const proposerOffer = parseItemList(parsed.offer);
        for (const [item, qty] of Object.entries(proposerOffer)) {
          if (item === 'coin') {
            if (agentDoc.coin < qty) {
              return { ok: false, note: `Not enough coin: need ${qty}c, have ${agentDoc.coin}c.` };
            }
          } else if (!inventoryHasAtLeast(agentDoc.inventory, item, qty)) {
            const proposerInv = JSON.parse(agentDoc.inventory) as Record<string, number>;
            return { ok: false, note: `Not enough ${item}: need ${qty}, have ${proposerInv[item] ?? 0}.` };
          }
        }
      }
      return { ok: true };
    }
    case 'accept_transaction':
    case 'reject_transaction':
      if (!parsed.target) return { ok: false, note: `${parsed.action} requires a transaction id target.` };
      return { ok: true };
    case 'leave_message': {
      if (!parsed.target) return { ok: false, note: 'leave_message requires a target agent.' };
      if (!(parsed.text ?? parsed.message)) return { ok: false, note: 'leave_message requires text.' };
      const targetAgent = await ctx.db
        .query('rl_agents')
        .withIndex('name', (q: any) => q.eq('name', parsed.target))
        .unique();
      if (!targetAgent) return { ok: false, note: `Target agent not found: ${parsed.target}.` };
      return { ok: true };
    }
    case 'write':
    case 'pray':
    case 'eavesdrop':
      if (!(parsed.text ?? parsed.message)) {
        return { ok: false, note: `${parsed.action} requires text.` };
      }
      return { ok: true };
    case 'eat':
      if (!parsed.item) return { ok: false, note: 'Eat requires an item.' };
      if (!inventoryHasAtLeast(agentDoc.inventory, parsed.item, parsed.quantity ?? 1)) {
        const inv = JSON.parse(agentDoc.inventory) as Record<string, number>;
        return { ok: false, note: `Not enough ${parsed.item}: need ${parsed.quantity ?? 1}, have ${inv[parsed.item] ?? 0}.` };
      }
      return { ok: true };
    default:
      return { ok: true };
  }
}

async function recordFailedAction(
  ctx: any,
  agentDoc: any,
  agentName: string,
  parsed: RocklawAction,
  tick: number,
  day: number,
  failNote: string,
) {
  await ctx.db.insert('rl_actions_log', {
    agentName,
    action: parsed.action,
    target: parsed.target ?? parsed.location ?? parsed.item ?? undefined,
    message: parsed.text ?? parsed.message,
    tick,
    day,
    outcome: 'failed',
    outcomeNote: failNote,
  });
  await ctx.db.patch(agentDoc._id, { busy: false });
  return { outcome: 'failed', note: failNote };
}

async function appendAgentHeartbeat(ctx: any, agentName: string, line: string) {
  await ctx.scheduler.runAfter(0, internal.rocklaw.worldRefreshNode.appendHeartbeat, {
    agentName,
    line,
  });
}

async function appendPendingNote(ctx: any, agentName: string, note: string) {
  await ctx.scheduler.runAfter(0, internal.rocklaw.bridge.setAgentPendingNote, {
    agentName,
    note,
  });
}

async function createPendingTransaction(
  ctx: any,
  agentDoc: any,
  parsed: RocklawAction,
  tick: number,
  day: number,
  newEnergy: number,
  newHealth: number,
  finalHunger: number,
) {
  const terms = buildTransactionTerms(parsed);
  const txnId = createTransactionId(parsed.action, agentDoc.name, tick, day);
  await ctx.db.insert('rl_transactions', {
    txnId,
    fromAgent: agentDoc.name,
    toAgent: parsed.target!,
    kind: parsed.action,
    offerJson: serialiseTransactionItems(terms.offer),
    requestJson: serialiseTransactionItems(terms.request),
    message: parsed.text ?? parsed.message,
    status: 'pending',
    createdTick: tick,
    createdDay: day,
    expiresTick: tick + OFFER_EXPIRY_TICKS,
  });

  await ctx.db.insert('rl_actions_log', {
    agentName: agentDoc.name,
    action: parsed.action,
    target: parsed.target ?? undefined,
    message: parsed.text ?? parsed.message,
    tick,
    day,
    outcome: 'success',
    outcomeNote: `Offer ${txnId} created.`,
  });

  await ctx.db.patch(agentDoc._id, {
    energy: newEnergy,
    health: newHealth,
    hunger: finalHunger,
    busy: false,
    busyUntilTick: undefined,
  });

  return {
    outcome: 'success',
    note: `Offer ${txnId} created for ${parsed.target}.`,
    transactionId: txnId,
  };
}

async function resolveTransactionResponse(
  ctx: any,
  agentDoc: any,
  parsed: RocklawAction,
  tick: number,
  day: number,
  newEnergy: number,
  newHealth: number,
  finalHunger: number,
) {
  const txn = await ctx.db
    .query('rl_transactions')
    .withIndex('txnId', (q: any) => q.eq('txnId', parsed.target!))
    .unique();

  if (!txn) {
    return recordFailedAction(ctx, agentDoc, agentDoc.name, parsed, tick, day, `Unknown transaction id: ${parsed.target}.`);
  }
  if (txn.toAgent !== agentDoc.name) {
    return recordFailedAction(ctx, agentDoc, agentDoc.name, parsed, tick, day, 'This transaction is not addressed to you.');
  }
  if (txn.status !== 'pending') {
    return recordFailedAction(ctx, agentDoc, agentDoc.name, parsed, tick, day, `Transaction is no longer pending (${txn.status}).`);
  }
  if (txn.expiresTick < tick) {
    await ctx.db.patch(txn._id, {
      status: 'expired',
      resolvedTick: tick,
      resolvedDay: day,
      outcomeNote: 'Offer expired before acceptance.',
    });
    return recordFailedAction(ctx, agentDoc, agentDoc.name, parsed, tick, day, 'Transaction has expired.');
  }

  const proposer = await ctx.db
    .query('rl_agents')
    .withIndex('name', (q: any) => q.eq('name', txn.fromAgent))
    .unique();
  if (!proposer) {
    await ctx.db.patch(txn._id, {
      status: 'failed',
      resolvedTick: tick,
      resolvedDay: day,
      outcomeNote: 'The other party no longer exists.',
    });
    return recordFailedAction(ctx, agentDoc, agentDoc.name, parsed, tick, day, 'The other party no longer exists.');
  }

  if (parsed.action === 'reject_transaction') {
    const note = parsed.message
      ? `Offer rejected: ${parsed.message}`
      : 'Offer rejected.';
    await ctx.db.patch(txn._id, {
      status: 'rejected',
      resolvedTick: tick,
      resolvedDay: day,
      outcomeNote: note,
    });
    await ctx.db.insert('rl_actions_log', {
      agentName: agentDoc.name,
      action: parsed.action,
      target: txn.txnId,
      message: parsed.message,
      tick,
      day,
      outcome: 'success',
      outcomeNote: note,
    });
    await ctx.db.patch(agentDoc._id, {
      energy: newEnergy,
      health: newHealth,
      hunger: finalHunger,
      busy: false,
      busyUntilTick: undefined,
    });
    await appendAgentHeartbeat(
      ctx,
      proposer.name,
      `- Day ${day} ${timeOfDayForTick(tick)}: ${agentDoc.name} rejected your ${txn.kind} offer [FAILED]${parsed.message ? ` ⚠ ${parsed.message}` : ''}`,
    );
    await appendPendingNote(ctx, proposer.name, `${agentDoc.name} rejected your ${txn.kind} offer (${txn.txnId}).`);
    return { outcome: 'success', note: note };
  }

  if (proposer.location !== agentDoc.location) {
    const note = `${proposer.name} is no longer at ${agentDoc.location}.`;
    await ctx.db.patch(txn._id, {
      status: 'failed',
      resolvedTick: tick,
      resolvedDay: day,
      outcomeNote: note,
    });
    await appendAgentHeartbeat(ctx, proposer.name, `- Day ${day} ${timeOfDayForTick(tick)}: your ${txn.kind} offer failed [FAILED] ⚠ ${note}`);
    await appendPendingNote(ctx, proposer.name, `Your ${txn.kind} offer (${txn.txnId}) failed: ${note}`);
    return recordFailedAction(ctx, agentDoc, agentDoc.name, parsed, tick, day, note);
  }

  const offer = parseTransactionItems(txn.offerJson);
  const request = parseTransactionItems(txn.requestJson);
  const proposerInv = JSON.parse(proposer.inventory) as Record<string, number>;
  const recipientInv = JSON.parse(agentDoc.inventory) as Record<string, number>;

  for (const item of offer) {
    if (item.item === 'coin') {
      if (proposer.coin < item.quantity) {
        const note = `${proposer.name} no longer has enough coin: need ${item.quantity}c, have ${proposer.coin}c.`;
        await ctx.db.patch(txn._id, { status: 'failed', resolvedTick: tick, resolvedDay: day, outcomeNote: note });
        await appendAgentHeartbeat(ctx, proposer.name, `- Day ${day} ${timeOfDayForTick(tick)}: your ${txn.kind} offer failed [FAILED] ⚠ ${note}`);
        await appendPendingNote(ctx, proposer.name, `Your ${txn.kind} offer (${txn.txnId}) failed: ${note}`);
        return recordFailedAction(ctx, agentDoc, agentDoc.name, parsed, tick, day, note);
      }
    } else if ((proposerInv[item.item] ?? 0) < item.quantity) {
      const note = `${proposer.name} no longer has enough ${item.item}: need ${item.quantity}, have ${proposerInv[item.item] ?? 0}.`;
      await ctx.db.patch(txn._id, { status: 'failed', resolvedTick: tick, resolvedDay: day, outcomeNote: note });
      await appendAgentHeartbeat(ctx, proposer.name, `- Day ${day} ${timeOfDayForTick(tick)}: your ${txn.kind} offer failed [FAILED] ⚠ ${note}`);
      await appendPendingNote(ctx, proposer.name, `Your ${txn.kind} offer (${txn.txnId}) failed: ${note}`);
      return recordFailedAction(ctx, agentDoc, agentDoc.name, parsed, tick, day, note);
    }
  }
  for (const item of request) {
    if (item.item === 'coin') {
      if (agentDoc.coin < item.quantity) {
        const note = `Not enough coin to accept: need ${item.quantity}c, have ${agentDoc.coin}c.`;
        await ctx.db.patch(txn._id, { status: 'failed', resolvedTick: tick, resolvedDay: day, outcomeNote: note });
        await appendAgentHeartbeat(ctx, proposer.name, `- Day ${day} ${timeOfDayForTick(tick)}: your ${txn.kind} offer failed [FAILED] ⚠ ${note}`);
        await appendPendingNote(ctx, proposer.name, `Your ${txn.kind} offer (${txn.txnId}) failed: ${note}`);
        return recordFailedAction(ctx, agentDoc, agentDoc.name, parsed, tick, day, note);
      }
    } else if ((recipientInv[item.item] ?? 0) < item.quantity) {
      const note = `Not enough ${item.item} to accept: need ${item.quantity}, have ${recipientInv[item.item] ?? 0}.`;
      await ctx.db.patch(txn._id, { status: 'failed', resolvedTick: tick, resolvedDay: day, outcomeNote: note });
      await appendAgentHeartbeat(ctx, proposer.name, `- Day ${day} ${timeOfDayForTick(tick)}: your ${txn.kind} offer failed [FAILED] ⚠ ${note}`);
      await appendPendingNote(ctx, proposer.name, `Your ${txn.kind} offer (${txn.txnId}) failed: ${note}`);
      return recordFailedAction(ctx, agentDoc, agentDoc.name, parsed, tick, day, note);
    }
  }

  const proposerApplied = applyInventoryChanges(
    proposer.inventory,
    proposer.coin,
    offer,
    request,
    txn.kind,
  );
  const recipientApplied = applyInventoryChanges(
    agentDoc.inventory,
    agentDoc.coin,
    request,
    offer,
    txn.kind,
  );

  await ctx.db.patch(proposer._id, {
    inventory: proposerApplied.newInventory,
    coin: proposerApplied.newCoin,
  });
  await ctx.db.patch(agentDoc._id, {
    inventory: recipientApplied.newInventory,
    coin: recipientApplied.newCoin,
    energy: newEnergy,
    health: newHealth,
    hunger: finalHunger,
    busy: false,
    busyUntilTick: undefined,
  });
  await ctx.db.patch(txn._id, {
    status: 'completed',
    resolvedTick: tick,
    resolvedDay: day,
    outcomeNote: `Completed: ${formatTransactionItems(offer)} for ${formatTransactionItems(request)}.`,
  });

  await ctx.db.insert('rl_actions_log', {
    agentName: proposer.name,
    action: txn.kind,
    target: agentDoc.name,
    message: txn.message,
    tick,
    day,
    outcome: 'success',
    outcomeNote: `Completed transaction ${txn.txnId}.`,
  });
  await ctx.db.insert('rl_actions_log', {
    agentName: agentDoc.name,
    action: parsed.action,
    target: txn.txnId,
    message: parsed.message,
    tick,
    day,
    outcome: 'success',
    outcomeNote: `Accepted ${txn.kind} offer ${txn.txnId}.`,
  });

  await ctx.scheduler.runAfter(0, internal.rocklaw.priceEngine.recalculate, {});
  await ctx.scheduler.runAfter(0, internal.rocklaw.reputation.updateReputation, {
    agentName: proposer.name, delta: 1, note: txn.kind, tick,
  });
  await ctx.scheduler.runAfter(0, internal.rocklaw.reputation.updateReputation, {
    agentName: agentDoc.name, delta: 1, note: txn.kind, tick,
  });
  await appendAgentHeartbeat(
    ctx,
    proposer.name,
    `- Day ${day} ${timeOfDayForTick(tick)}: ${txn.kind} offer completed with ${agentDoc.name} (${formatTransactionItems(offer)} for ${formatTransactionItems(request)})`,
  );
  await appendPendingNote(ctx, proposer.name, `${agentDoc.name} accepted your ${txn.kind} offer (${txn.txnId}).`);

  return { outcome: 'success', note: `Accepted ${txn.kind} offer ${txn.txnId}.` };
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
const OFFER_EXPIRY_TICKS = 3;

function entityListToItems(entries: unknown[] | undefined): TransactionItem[] {
  return normaliseEntityList(entries) ?? [];
}

function buildTransactionTerms(parsed: RocklawAction): { offer: TransactionItem[]; request: TransactionItem[] } {
  switch (parsed.action) {
    case 'buy':
      return {
        offer: typeof parsed.amount === 'number' && parsed.amount > 0 ? [{ item: 'coin', quantity: parsed.amount }] : [],
        request: parsed.item && typeof parsed.quantity === 'number' && parsed.quantity > 0 ? [{ item: parsed.item, quantity: parsed.quantity }] : [],
      };
    case 'sell':
      return {
        offer: parsed.item && typeof parsed.quantity === 'number' && parsed.quantity > 0 ? [{ item: parsed.item, quantity: parsed.quantity }] : [],
        request: typeof parsed.amount === 'number' && parsed.amount > 0 ? [{ item: 'coin', quantity: parsed.amount }] : [],
      };
    case 'trade':
      return {
        offer: entityListToItems(parsed.offer),
        request: entityListToItems(parsed.request),
      };
    default:
      return { offer: [], request: [] };
  }
}

function serialiseTransactionItems(items: TransactionItem[]): string {
  return JSON.stringify(items);
}

function parseTransactionItems(itemsJson: string): TransactionItem[] {
  try {
    const parsed = JSON.parse(itemsJson) as TransactionItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatTransactionItems(items: TransactionItem[]): string {
  if (items.length === 0) return 'nothing';
  return items.map((entry) => `${entry.quantity} ${entry.item}`).join(', ');
}

function createTransactionId(kind: string, fromAgent: string, tick: number, day: number): string {
  const slug = fromAgent.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `txn-${day}-${tick}-${kind}-${slug}-${Date.now()}`;
}

function timeOfDayForTick(tick: number): 'morning' | 'afternoon' | 'evening' {
  const order: Array<'morning' | 'afternoon' | 'evening'> = ['morning', 'afternoon', 'evening'];
  return order[((tick % 3) + 3) % 3];
}

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

    const worldValidation = await validateWorldExecution(ctx, agentDoc, parsed);
    if (!worldValidation.ok) {
      const failNote = ('note' in worldValidation && typeof worldValidation.note === 'string')
        ? worldValidation.note
        : 'Action could not be executed.';
      return recordFailedAction(ctx, agentDoc, agentName, parsed, tick, day, failNote);
    }

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
        return recordFailedAction(ctx, agentDoc, agentName, parsed, tick, day, failNote);
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
        target: parsed.target ?? parsed.location ?? parsed.item ?? undefined,
        message: parsed.text ?? parsed.message,
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

    // Eating reduces hunger
    const eatingHungerReduction = parsed.action === 'eat' ? 40 : 0;
    const finalHunger = Math.max(0, newHunger - eatingHungerReduction);

    // In-person commerce is two-phase: create an offer now, settle only on explicit acceptance.
    if (parsed.action === 'buy' || parsed.action === 'sell' || parsed.action === 'trade') {
      return createPendingTransaction(
        ctx,
        agentDoc,
        parsed,
        tick,
        day,
        newEnergy,
        newHealth,
        finalHunger,
      );
    }

    if (parsed.action === 'accept_transaction' || parsed.action === 'reject_transaction') {
      return resolveTransactionResponse(
        ctx,
        agentDoc,
        parsed,
        tick,
        day,
        newEnergy,
        newHealth,
        finalHunger,
      );
    }

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
