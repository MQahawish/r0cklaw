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
import { getRecipe, getService, hungerRestoreFor, isEdible } from './economy';

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
type InteractionPayload = {
  text?: string;
  message?: string;
  offer?: TransactionItem[];
  request?: TransactionItem[];
  deferredReplyText?: string;
  deferredReplyFrom?: string;
  deferredReplyTick?: number;
  deferredReplyDay?: number;
  lastNonResponseAction?: string;
  lastNonResponseTick?: number;
  lastNonResponseDay?: number;
};

type WorldValidation =
  | { ok: false; note: string }
  | {
      ok: true;
      resolvedLocation?: string;
      consumes?: Array<{ item: string; quantity: number }>;
      produces?: Array<{ item: string; quantity: number }>;
      fieldKey?: string;
      cropItem?: string;
      herbPatchKey?: string;
      note?: string;
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
  move: 5, chat: 2, leave_chat: 0, say: 1, message: 2, talk: 2, buy: 2, sell: 2, pay: 1, give: 1,
  trade: 2, accept_transaction: 1, reject_transaction: 1, wait: 0, observe: 1, write: 2, pray: 0,
  recall: 0,
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
  if ((action === 'chat' || action === 'say' || action === 'message' || action === 'talk' || action === 'write' || action === 'pray' || action === 'eavesdrop') && !normalized.text && parsed.message) {
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

function transferToRecipient(
  inventoryJson: string,
  coin: number,
  produces: Array<{ item: string; quantity: number }>,
): { newInventory: string; newCoin: number } {
  return applyInventoryChanges(inventoryJson, coin, [], produces, 'transfer');
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

function inventoryHasItems(inventoryJson: string, required: Array<{ item: string; quantity: number }>): boolean {
  const inv = JSON.parse(inventoryJson) as Record<string, number>;
  return required.every((entry) => (inv[entry.item] ?? 0) >= entry.quantity);
}

function formatRequirementShortfall(inventoryJson: string, required: Array<{ item: string; quantity: number }>): string | null {
  return formatInventoryShortfall(
    inventoryJson,
    required.map((entry) => ({ item: entry.item, quantity: entry.quantity })),
  );
}

async function getFieldsAtLocation(ctx: any, location: string) {
  const fields = await ctx.db
    .query('rl_fields')
    .withIndex('location', (q: any) => q.eq('location', location))
    .collect();
  return fields.slice().sort((a: any, b: any) => a.fieldKey.localeCompare(b.fieldKey));
}

async function getHerbPatchesAtLocation(ctx: any, location: string) {
  const patches = await ctx.db
    .query('rl_herb_patches')
    .withIndex('location', (q: any) => q.eq('location', location))
    .collect();
  return patches.slice().sort((a: any, b: any) => a.patchKey.localeCompare(b.patchKey));
}

function serviceRequirementsFor(item: string | null | undefined) {
  const service = getService(item);
  return service?.consumes ?? [];
}

function canProvideService(agentDoc: any, item: string | null | undefined) {
  const service = getService(item);
  if (!service) return false;
  if (agentDoc.role !== service.providerRole) return false;
  if (agentDoc.location !== service.location) return false;
  return inventoryHasItems(agentDoc.inventory, service.consumes);
}

async function targetAgentAtSameLocation(ctx: any, actorLocation: string, targetName: string) {
  const trimmedTarget = targetName.trim().toLowerCase();
  if (trimmedTarget === 'market' || trimmedTarget === 'inn' || trimmedTarget === 'forge' || trimmedTarget === 'farm' || trimmedTarget === 'shrine' || trimmedTarget === 'square' || trimmedTarget === 'gate') {
    return {
      ok: false,
      note: `${targetName} is a place, not a trading counterparty. Buy or sell only with a person who is here.`,
    };
  }
  const targetAgent = await ctx.db
    .query('rl_agents')
    .withIndex('name', (q: any) => q.eq('name', targetName))
    .unique();
  if (!targetAgent) return { ok: false, note: `Target agent not found: ${targetName}.` };
  if (targetAgent.location !== actorLocation) {
    return { ok: false, note: `${targetName} moved away earlier this tick and is no longer at your location (${actorLocation}). The local scene is no longer live.` };
  }
  return { ok: true, targetAgent };
}

function createChatThreadKey(agentA: string, agentB: string): string {
  return [agentA, agentB].sort((a, b) => a.localeCompare(b)).join('::');
}

function createChatSceneId(agentA: string, agentB: string, tick: number, day: number): string {
  const [left, right] = [agentA, agentB].sort((a, b) => a.localeCompare(b));
  const leftSlug = left.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const rightSlug = right.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `chat-${day}-${tick}-${leftSlug}-${rightSlug}-${Date.now()}`;
}

async function getAgentByName(ctx: any, agentName: string) {
  return ctx.db
    .query('rl_agents')
    .withIndex('name', (q: any) => q.eq('name', agentName))
    .unique();
}

async function listLiveChatScenesForAgent(ctx: any, agentName: string) {
  const [asA, asB] = await Promise.all([
    ctx.db
      .query('rl_chat_scenes')
      .withIndex('agentA_status', (q: any) => q.eq('agentA', agentName).eq('status', 'live'))
      .collect(),
    ctx.db
      .query('rl_chat_scenes')
      .withIndex('agentB_status', (q: any) => q.eq('agentB', agentName).eq('status', 'live'))
      .collect(),
  ]);
  return [...asA, ...asB];
}

async function getLiveChatSceneForAgent(ctx: any, agentName: string) {
  const scenes = await listLiveChatScenesForAgent(ctx, agentName);
  return scenes[0] ?? null;
}

function getScenePartner(scene: any, agentName: string) {
  return scene.agentA === agentName ? scene.agentB : scene.agentA;
}

async function advanceLiveChatSceneForSpeaker(ctx: any, agentName: string, tick: number, day: number) {
  const scene = await getLiveChatSceneForAgent(ctx, agentName);
  if (!scene) return null;
  await ctx.db.patch(scene._id, {
    nextSpeaker: getScenePartner(scene, agentName),
    lastSpeaker: agentName,
    lastActiveTick: tick,
    lastActiveDay: day,
  });
  return scene;
}

async function closeLiveChatSceneForAgent(
  ctx: any,
  agentName: string,
  tick: number,
  day: number,
  reason?: string,
) {
  const scene = await getLiveChatSceneForAgent(ctx, agentName);
  if (!scene) return null;
  await ctx.db.patch(scene._id, {
    status: 'closed',
    closeReason: reason ?? `${agentName} left the chat.`,
    closedTick: tick,
    closedDay: day,
    lastActiveTick: tick,
    lastActiveDay: day,
  });
  return {
    scene,
    partner: getScenePartner(scene, agentName),
  };
}

async function hasKnownContact(ctx: any, observerAgent: string, subjectAgent: string) {
  const existing = await ctx.db
    .query('rl_social_knowledge')
    .withIndex('observer_subject', (q: any) => q.eq('observerAgent', observerAgent).eq('subjectAgent', subjectAgent))
    .unique();
  return Boolean(existing);
}

async function markUnreadChatFromContactRead(
  ctx: any,
  recipientName: string,
  fromAgent: string,
  tick: number,
  day: number,
) {
  const unread = await ctx.db
    .query('rl_chat_messages')
    .withIndex('recipient_status', (q: any) => q.eq('toAgent', recipientName).eq('status', 'unread'))
    .collect();
  await Promise.all(
    unread
      .filter((message: any) => message.fromAgent === fromAgent)
      .map((message: any) =>
        ctx.db.patch(message._id, {
          status: 'read',
          readTick: tick,
          readDay: day,
        })),
  );
}

async function createChatMessage(
  ctx: any,
  args: {
    fromAgent: string;
    toAgent: string;
    text: string;
    deliveryMode: 'live' | 'deferred';
    tick: number;
    day: number;
  },
) {
  const threadKey = createChatThreadKey(args.fromAgent, args.toAgent);
  await ctx.db.insert('rl_chat_messages', {
    threadKey,
    fromAgent: args.fromAgent,
    toAgent: args.toAgent,
    text: args.text,
    deliveryMode: args.deliveryMode,
    status: 'unread',
    sentTick: args.tick,
    sentDay: args.day,
  });
  return threadKey;
}

async function createLocalSpeechNotes(
  ctx: any,
  args: {
    speaker: string;
    location: string;
    text: string;
    tick: number;
    day: number;
  },
) {
  const nearby = await ctx.db
    .query('rl_agents')
    .withIndex('location', (q: any) => q.eq('location', args.location))
    .collect();
  await Promise.all(
    nearby
      .filter((agent: any) => agent.name !== args.speaker)
      .map((agent: any) =>
        ctx.scheduler.runAfter(0, internal.rocklaw.bridge.setAgentPendingNote, {
          agentName: agent.name,
          note: `You heard ${args.speaker} say: "${args.text}"`,
        })),
  );
}

function parseOfferReference(rawTarget: string): number | null {
  const trimmed = rawTarget.trim().toLowerCase();
  const match = trimmed.match(/^offer-(\d+)$/) ?? trimmed.match(/^(\d+)$/);
  if (!match) return null;
  return Number(match[1]);
}

async function resolvePendingTransactionReference(ctx: any, recipientName: string, rawTarget: string) {
  const direct = await ctx.db
    .query('rl_transactions')
    .withIndex('txnId', (q: any) => q.eq('txnId', rawTarget))
    .unique();
  if (direct && direct.toAgent === recipientName) return direct;

  const offerNumber = parseOfferReference(rawTarget);
  if (!offerNumber || offerNumber < 1) return null;

  const pending = await ctx.db
    .query('rl_transactions')
    .withIndex('recipient_status', (q: any) => q.eq('toAgent', recipientName).eq('status', 'pending'))
    .collect();

  const ordered = pending
    .slice()
    .sort((a: any, b: any) =>
      a.createdDay - b.createdDay
      || a.createdTick - b.createdTick
      || a.fromAgent.localeCompare(b.fromAgent),
    );

  return ordered[offerNumber - 1] ?? null;
}

async function findTransactionByTargetReference(ctx: any, rawTarget: string) {
  const direct = await ctx.db
    .query('rl_transactions')
    .withIndex('txnId', (q: any) => q.eq('txnId', rawTarget))
    .unique();
  if (direct) return direct;

  const offerNumber = parseOfferReference(rawTarget);
  if (!offerNumber || offerNumber < 1) return null;

  const pending = await ctx.db
    .query('rl_transactions')
    .filter((q: any) => q.eq(q.field('status'), 'pending'))
    .collect();

  const ordered = pending
    .slice()
    .sort((a: any, b: any) =>
      a.createdDay - b.createdDay
      || a.createdTick - b.createdTick
      || a.fromAgent.localeCompare(b.fromAgent),
    );

  return ordered[offerNumber - 1] ?? null;
}

async function resolveLocationName(ctx: any, rawLocation: string | null | undefined) {
  if (!rawLocation) return null;
  const trimmed = rawLocation.trim();
  if (!trimmed) return null;

  const exact = await ctx.db
    .query('rl_locations')
    .withIndex('name', (q: any) => q.eq('name', trimmed))
    .unique();
  if (exact) return exact;

  const normaliseLocationToken = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/^the\s+/, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ');

  const normalised = normaliseLocationToken(trimmed);
  const locations = await ctx.db.query('rl_locations').collect();
  return locations.find((location: any) => normaliseLocationToken(location.name) === normalised) ?? null;
}

async function validateWorldExecution(ctx: any, agentDoc: any, parsed: RocklawAction, tick?: number): Promise<WorldValidation> {
  const destination = parsed.location ?? parsed.target ?? null;
  const activeChatScene = await getLiveChatSceneForAgent(ctx, agentDoc.name);

  if (activeChatScene) {
    const partner = getScenePartner(activeChatScene, agentDoc.name);
    if (parsed.action === 'leave_chat') {
      return { ok: true };
    }
    if (parsed.action !== 'chat') {
      return {
        ok: false,
        note: `You are currently in a live chat with ${partner}. Only chat or leave_chat are allowed until you leave that scene.`,
      };
    }
    if (parsed.target !== partner) {
      return {
        ok: false,
        note: `You are currently in a live chat with ${partner}. Continue chatting with them or use leave_chat.`,
      };
    }
    if (typeof tick === 'number' && activeChatScene.openedTick === tick) {
      if (!(parsed.text ?? parsed.message)) {
        return { ok: false, note: 'chat requires text.' };
      }
      return { ok: true };
    }
    if (activeChatScene.nextSpeaker !== agentDoc.name) {
      return {
        ok: false,
        note: `It is ${partner}'s turn in your live chat. Wait for their reply or leave_chat.`,
      };
    }
    if (!(parsed.text ?? parsed.message)) {
      return { ok: false, note: 'chat requires text.' };
    }
    return { ok: true };
  }

  if (Array.isArray(parsed.consumes) && parsed.consumes.length > 0) {
    const consumesForShortfall = parsed.consumes.filter((entry: any) => {
      const normalised = normaliseItemEntry(entry);
      if (!normalised) return false;
      const item = normalised.value.split(':')[0].trim();
      return !getService(item);
    });
    const missingInventory = formatInventoryShortfall(agentDoc.inventory, consumesForShortfall);
    if (missingInventory) return { ok: false, note: missingInventory };

    const needed = parseItemList(parsed.consumes);
    if (typeof needed.coin === 'number' && agentDoc.coin < needed.coin) {
      return { ok: false, note: `Not enough coin: need ${needed.coin}c, have ${agentDoc.coin}c.` };
    }
  }

  switch (parsed.action) {
    case 'move': {
      if (!destination) return { ok: false, note: 'Move requires a destination location.' };
      const locationDoc = await resolveLocationName(ctx, destination);
      if (!locationDoc) return { ok: false, note: `Unknown location: ${destination}.` };
      if (locationDoc.name === agentDoc.location) return { ok: false, note: `You are already at ${locationDoc.name}.` };
      return { ok: true, resolvedLocation: locationDoc.name };
    }
    case 'chat': {
      if (!parsed.target) {
        return { ok: false, note: 'chat requires a target agent. Use a known person from CHAT.md. Chats are one-to-one only.' };
      }
      if (parsed.target === agentDoc.name) return { ok: false, note: 'chat requires another agent, not yourself.' };
      const targetAgent = await getAgentByName(ctx, parsed.target);
      if (!targetAgent) return { ok: false, note: `Target agent not found: ${parsed.target}.` };
      const knownAlready = await hasKnownContact(ctx, agentDoc.name, parsed.target);
      const visibleNow = targetAgent.location === agentDoc.location;
      if (!knownAlready && !visibleNow) {
        return { ok: false, note: `You can only chat known contacts from CHAT.md. You have not met ${parsed.target} yet.` };
      }
      if (!(parsed.text ?? parsed.message)) {
        return { ok: false, note: 'chat requires text.' };
      }
      return { ok: true };
    }
    case 'say':
      if (parsed.target) return { ok: false, note: 'say is local speech and does not take a target. Use chat for one-to-one communication.' };
      if (!(parsed.text ?? parsed.message)) return { ok: false, note: 'say requires text.' };
      return { ok: true };
    case 'talk':
    case 'pay':
    case 'buy':
    case 'sell':
    case 'give':
    case 'trade': {
      if (!parsed.target) return { ok: false, note: `${parsed.action} requires a target agent.` };
      if (parsed.target === agentDoc.name) return { ok: false, note: `${parsed.action} requires another agent, not yourself.` };
      const targetCheck = await targetAgentAtSameLocation(ctx, agentDoc.location, parsed.target);
      if (!targetCheck.ok) return { ok: false, note: targetCheck.note ?? `${parsed.target} is not available here.` };

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
        if (parsed.item === 'meal') {
          if (targetCheck.targetAgent.role !== 'Innkeeper' || targetCheck.targetAgent.location !== 'inn') {
            return { ok: false, note: 'Meals can only be bought from the innkeeper at the inn.' };
          }
          if (!canProvideService(targetCheck.targetAgent, 'meal')) {
            return { ok: false, note: 'Meal service is unavailable right now because the inn lacks stock.' };
          }
        }
      }
      if (parsed.action === 'sell') {
        if (typeof parsed.amount !== 'number' || parsed.amount <= 0) {
          return { ok: false, note: 'Sell requires a positive amount.' };
        }
        if (parsed.item === 'meal') {
          if (!canProvideService(agentDoc, 'meal')) {
            return { ok: false, note: 'Meal service is unavailable here until you have bread and ale at the inn.' };
          }
        } else if (!inventoryHasAtLeast(agentDoc.inventory, parsed.item!, parsed.quantity!)) {
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
    case 'craft':
    case 'smelt':
    case 'brew': {
      const recipe = getRecipe(parsed.action, parsed.item ?? parsed.target);
      if (!recipe) {
        if (parsed.action === 'craft' && (parsed.item ?? parsed.target) === 'meal') {
          return { ok: false, note: 'Meals are offered through sell, not craft.' };
        }
        return { ok: false, note: `${parsed.action} requires a known output item.` };
      }
      if (agentDoc.location !== recipe.location) {
        return { ok: false, note: `${parsed.action} ${recipe.output} is unavailable here. Move to ${recipe.location}.` };
      }
      const shortfall = formatRequirementShortfall(agentDoc.inventory, recipe.consumes);
      if (shortfall) return { ok: false, note: shortfall };
      return { ok: true, consumes: recipe.consumes, produces: recipe.produces, note: recipe.note };
    }
    case 'check_field': {
      if (agentDoc.location !== 'farm') {
        return { ok: false, note: 'check_field is only useful at the farm.' };
      }
      return { ok: true };
    }
    case 'plant': {
      if (agentDoc.location !== 'farm') {
        return { ok: false, note: 'plant is only available at the farm.' };
      }
      const fields = await getFieldsAtLocation(ctx, agentDoc.location);
      const field = fields.find((entry: any) => entry.stage === 'fallow');
      if (!field) return { ok: false, note: 'No fallow field is available to plant right now.' };
      const cropItem = parsed.item ?? 'grain';
      if (!['grain', 'vegetables'].includes(cropItem)) {
        return { ok: false, note: 'plant currently supports grain or vegetables.' };
      }
      if (!inventoryHasAtLeast(agentDoc.inventory, cropItem, 1)) {
        const inv = JSON.parse(agentDoc.inventory) as Record<string, number>;
        return { ok: false, note: `Not enough ${cropItem}: need 1, have ${inv[cropItem] ?? 0}.` };
      }
      return { ok: true, fieldKey: field.fieldKey, cropItem, consumes: [{ item: cropItem, quantity: 1 }], note: `Plant ${cropItem} in ${field.fieldKey}.` };
    }
    case 'water': {
      if (agentDoc.location !== 'farm') {
        return { ok: false, note: 'water is only available at the farm.' };
      }
      const fields = await getFieldsAtLocation(ctx, agentDoc.location);
      const field = fields.find((entry: any) => entry.stage === 'growing');
      if (!field) return { ok: false, note: 'No growing field needs water right now.' };
      return { ok: true, fieldKey: field.fieldKey, note: `Water ${field.fieldKey}.` };
    }
    case 'harvest': {
      if (agentDoc.location !== 'farm') {
        return { ok: false, note: 'harvest is only available at the farm.' };
      }
      const fields = await getFieldsAtLocation(ctx, agentDoc.location);
      const field = fields.find((entry: any) => entry.stage === 'ready');
      if (!field || !field.cropItem) return { ok: false, note: 'No field is ready to harvest.' };
      const quantity = field.cropItem === 'grain' ? 4 : 3;
      return {
        ok: true,
        fieldKey: field.fieldKey,
        cropItem: field.cropItem,
        produces: [{ item: field.cropItem, quantity }],
        note: `Harvest ${field.cropItem} from ${field.fieldKey}.`,
      };
    }
    case 'gather': {
      const patches = await getHerbPatchesAtLocation(ctx, agentDoc.location);
      const patch = patches.find((entry: any) => entry.available > 0);
      if (!patch) {
        return { ok: false, note: 'No gatherable herbs are available here right now.' };
      }
      const quantity = Math.min(2, patch.available);
      return {
        ok: true,
        herbPatchKey: patch.patchKey,
        produces: [{ item: patch.herbItem, quantity }],
        note: `Gather ${quantity} ${patch.herbItem} from ${patch.patchKey}.`,
      };
    }
    case 'identify':
      if (!parsed.item) return { ok: false, note: 'identify requires an item.' };
      if (!inventoryHasAtLeast(agentDoc.inventory, parsed.item, 1)) {
        const inv = JSON.parse(agentDoc.inventory) as Record<string, number>;
        return { ok: false, note: `Not enough ${parsed.item}: need 1, have ${inv[parsed.item] ?? 0}.` };
      }
      return { ok: true };
    case 'accept_transaction':
    case 'reject_transaction':
      if (!parsed.target) return { ok: false, note: `${parsed.action} requires a pending offer reference.` };
      {
        const txn = await resolvePendingTransactionReference(ctx, agentDoc.name, parsed.target);
        if (!txn) {
          const referencedTxn = await findTransactionByTargetReference(ctx, parsed.target);
          if (referencedTxn?.fromAgent === agentDoc.name) {
            return { ok: false, note: 'You cannot accept or reject your own offer. Wait for the other person or make a new offer.' };
          }
          if (referencedTxn?.status && referencedTxn.status !== 'pending') {
            return { ok: false, note: `That offer is no longer pending (${referencedTxn.status}).` };
          }
          return { ok: false, note: `Unknown pending offer: ${parsed.target}.` };
        }
        const proposer = await ctx.db
          .query('rl_agents')
          .withIndex('name', (q: any) => q.eq('name', txn.fromAgent))
          .unique();
        if (!proposer) {
          return { ok: false, note: 'The other party no longer exists.' };
        }
        if (proposer.location !== agentDoc.location) {
          return { ok: false, note: `${proposer.name} is no longer here. In-person offers can only be answered while the local scene is still live.` };
        }
      }
      return { ok: true };
    case 'leave_chat':
      return { ok: false, note: 'You are not in a live chat right now.' };
    case 'wait':
      return { ok: false, note: 'There is no wait action in your current contract.' };
    case 'rest':
      return agentDoc.energy < 60
        ? { ok: true }
        : { ok: false, note: 'rest is only useful when you are meaningfully tired.' };
    case 'sleep': {
      const timeOfDay = typeof tick === 'number' ? timeOfDayForTick(tick) : null;
      return (timeOfDay === 'evening' || agentDoc.energy < 20)
        ? { ok: true }
        : { ok: false, note: 'sleep is only appropriate in the evening or when you are critically exhausted.' };
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
      if (!isEdible(parsed.item)) return { ok: false, note: `${parsed.item} is not edible.` };
      if (!inventoryHasAtLeast(agentDoc.inventory, parsed.item, parsed.quantity ?? 1)) {
        const inv = JSON.parse(agentDoc.inventory) as Record<string, number>;
        if (parsed.item === 'meal') {
          return {
            ok: false,
            note: `Not enough meal: need ${parsed.quantity ?? 1}, have ${inv[parsed.item] ?? 0}. Accept or buy one first.`,
          };
        }
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
    location: agentDoc.location,
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

async function createActiveInteraction(
  ctx: any,
  args: {
    kind: 'talk' | 'buy' | 'sell' | 'trade';
    fromAgent: string;
    toAgent: string;
    location: string;
    tick: number;
    day: number;
    payload: InteractionPayload;
    transactionId?: string;
  },
) {
  const interactionId = createInteractionId(args.kind, args.fromAgent, args.toAgent, args.tick, args.day);
  await ctx.db.insert('rl_interactions', {
    interactionId,
    kind: args.kind,
    fromAgent: args.fromAgent,
    toAgent: args.toAgent,
    location: args.location,
    payloadJson: JSON.stringify(args.payload),
    transactionId: args.transactionId,
    status: 'active',
    createdTick: args.tick,
    createdDay: args.day,
    expiresTick: args.tick + INTERACTION_EXPIRY_TICKS,
  });
  return interactionId;
}

async function markTalkInteractionResponded(
  ctx: any,
  fromAgent: string,
  toAgent: string,
  location: string,
  tick: number,
  day: number,
) {
  const received = await ctx.db
    .query('rl_interactions')
    .withIndex('recipient_status', (q: any) => q.eq('toAgent', fromAgent).eq('status', 'active'))
    .collect();
  const match = received.find((interaction: any) =>
    interaction.kind === 'talk'
    && interaction.fromAgent === toAgent
    && interaction.location === location,
  );
  if (!match) return;
  await ctx.db.patch(match._id, {
    status: 'responded',
    resolvedTick: tick,
    resolvedDay: day,
    outcomeNote: `${fromAgent} responded.`,
  });
}

async function agentHasActiveTalk(ctx: any, agentName: string) {
  const scene = await getLiveChatSceneForAgent(ctx, agentName);
  return Boolean(scene);
}

async function findReciprocalSameTickTalk(
  ctx: any,
  fromAgent: string,
  toAgent: string,
  location: string,
  tick: number,
  day: number,
) {
  const received = await ctx.db
    .query('rl_interactions')
    .withIndex('recipient_status', (q: any) => q.eq('toAgent', fromAgent).eq('status', 'active'))
    .collect();
  return received.find((interaction: any) =>
    interaction.kind === 'talk'
    && interaction.fromAgent === toAgent
    && interaction.location === location
    && interaction.createdTick === tick
    && interaction.createdDay === day,
  ) ?? null;
}

async function getActiveTalkPartnersForAgent(ctx: any, agentName: string) {
  const scenes = await listLiveChatScenesForAgent(ctx, agentName);
  return scenes.map((scene: any) => getScenePartner(scene, agentName));
}

async function agentHasLivePendingTransactionScene(ctx: any, agentDoc: any) {
  const incoming = await ctx.db
    .query('rl_transactions')
    .withIndex('recipient_status', (q: any) => q.eq('toAgent', agentDoc.name).eq('status', 'pending'))
    .collect();
  for (const txn of incoming) {
    const counterparty = await ctx.db
      .query('rl_agents')
      .withIndex('name', (q: any) => q.eq('name', txn.fromAgent))
      .unique();
    if (counterparty?.location === agentDoc.location) return true;
  }

  const outgoing = await ctx.db
    .query('rl_transactions')
    .withIndex('sender_status', (q: any) => q.eq('fromAgent', agentDoc.name).eq('status', 'pending'))
    .collect();
  for (const txn of outgoing) {
    const counterparty = await ctx.db
      .query('rl_agents')
      .withIndex('name', (q: any) => q.eq('name', txn.toAgent))
      .unique();
    if (counterparty?.location === agentDoc.location) return true;
  }

  return false;
}

async function agentHasLiveWaitScene(ctx: any, agentDoc: any) {
  if (await agentHasActiveTalk(ctx, agentDoc.name)) return true;
  return agentHasLivePendingTransactionScene(ctx, agentDoc);
}

async function noteTalkNonResponse(
  ctx: any,
  agentName: string,
  actionName: string,
  tick: number,
  day: number,
) {
  const received = await ctx.db
    .query('rl_interactions')
    .withIndex('recipient_status', (q: any) => q.eq('toAgent', agentName).eq('status', 'active'))
    .collect();

  for (const interaction of received) {
    if (interaction.kind !== 'talk') continue;
    const payload = interaction.payloadJson
      ? JSON.parse(interaction.payloadJson) as InteractionPayload
      : {};
    await ctx.db.patch(interaction._id, {
      payloadJson: JSON.stringify({
        ...payload,
        lastNonResponseAction: actionName,
        lastNonResponseTick: tick,
        lastNonResponseDay: day,
      } satisfies InteractionPayload),
    });
  }
}

async function setInteractionOutcomeByTransactionId(
  ctx: any,
  transactionId: string,
  patch: Record<string, unknown>,
) {
  const interaction = await ctx.db
    .query('rl_interactions')
    .withIndex('transactionId', (q: any) => q.eq('transactionId', transactionId))
    .unique();
  if (!interaction) return;
  await ctx.db.patch(interaction._id, patch);
}

async function failActiveInteractionsForDeparture(
  ctx: any,
  agentName: string,
  location: string,
  tick: number,
  day: number,
) {
  const received = await ctx.db
    .query('rl_interactions')
    .withIndex('recipient_status', (q: any) => q.eq('toAgent', agentName).eq('status', 'active'))
    .collect();
  const sent = await ctx.db
    .query('rl_interactions')
    .withIndex('sender_status', (q: any) => q.eq('fromAgent', agentName).eq('status', 'active'))
    .collect();
  const seen = new Set<string>();
  for (const interaction of [...received, ...sent]) {
    if (seen.has(interaction._id) || interaction.location !== location) continue;
    seen.add(interaction._id);
    const otherParty = interaction.fromAgent === agentName ? interaction.toAgent : interaction.fromAgent;
    const note = `${agentName} left ${location}, so the interaction ended.`;
    await ctx.db.patch(interaction._id, {
      status: 'failed',
      resolvedTick: tick,
      resolvedDay: day,
      outcomeNote: note,
    });
    if (interaction.transactionId) {
      const txn = await ctx.db
        .query('rl_transactions')
        .withIndex('txnId', (q: any) => q.eq('txnId', interaction.transactionId))
        .unique();
      if (txn && txn.status === 'pending') {
        await ctx.db.patch(txn._id, {
          status: 'failed',
          resolvedTick: tick,
          resolvedDay: day,
          outcomeNote: note,
        });
      }
    }
    await appendAgentHeartbeat(
      ctx,
      otherParty,
      `- Day ${day} ${timeOfDayForTick(tick)}: ${interaction.kind} with ${agentName} ended [FAILED] ⚠ ${note}`,
    );
    await appendPendingNote(ctx, otherParty, note);
  }
}

async function createTalkInteraction(
  ctx: any,
  agentDoc: any,
  parsed: RocklawAction,
  tick: number,
  day: number,
  newEnergy: number,
  newHealth: number,
  finalHunger: number,
) {
  const text = parsed.text ?? parsed.message ?? '';
  const reciprocalSameTick = await findReciprocalSameTickTalk(
    ctx,
    agentDoc.name,
    parsed.target!,
    agentDoc.location,
    tick,
    day,
  );

  if (reciprocalSameTick) {
    const existingPayload = reciprocalSameTick.payloadJson
      ? JSON.parse(reciprocalSameTick.payloadJson) as InteractionPayload
      : {};
    await ctx.db.patch(reciprocalSameTick._id, {
      payloadJson: JSON.stringify({
        ...existingPayload,
        deferredReplyText: text,
        deferredReplyFrom: agentDoc.name,
        deferredReplyTick: tick,
        deferredReplyDay: day,
      } satisfies InteractionPayload),
    });

    await ctx.db.insert('rl_actions_log', {
      agentName: agentDoc.name,
      action: parsed.action,
      target: parsed.target ?? undefined,
      location: agentDoc.location,
      message: text,
      tick,
      day,
      outcome: 'success',
      outcomeNote: `Deferred behind ${parsed.target}'s same-tick opener in interaction ${reciprocalSameTick.interactionId}.`,
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
      note: `${parsed.target} spoke first in the same tick. Your intended opener was deferred into the live exchange.`,
      interactionId: reciprocalSameTick.interactionId,
    };
  }

  await markTalkInteractionResponded(
    ctx,
    agentDoc.name,
    parsed.target!,
    agentDoc.location,
    tick,
    day,
  );
  const interactionId = await createActiveInteraction(ctx, {
    kind: 'talk',
    fromAgent: agentDoc.name,
    toAgent: parsed.target!,
    location: agentDoc.location,
    tick,
    day,
    payload: { text, message: parsed.message },
  });

  await ctx.db.insert('rl_actions_log', {
    agentName: agentDoc.name,
    action: parsed.action,
    target: parsed.target ?? undefined,
    location: agentDoc.location,
    message: text,
    tick,
    day,
    outcome: 'success',
    outcomeNote: `Interaction ${interactionId} created.`,
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
    note: `Interaction ${interactionId} created for ${parsed.target}.`,
    interactionId,
  };
}

async function sendChatAction(
  ctx: any,
  agentDoc: any,
  parsed: RocklawAction,
  tick: number,
  day: number,
  newEnergy: number,
  newHealth: number,
  finalHunger: number,
  deliveryOverride?: 'live' | 'deferred',
  deferredReason?: string,
) {
  const text = parsed.text ?? parsed.message ?? '';
  const targetAgent = await getAgentByName(ctx, parsed.target!);
  if (!targetAgent) {
    return recordFailedAction(ctx, agentDoc, agentDoc.name, parsed, tick, day, `Target agent not found: ${parsed.target}.`);
  }

  await markUnreadChatFromContactRead(ctx, agentDoc.name, parsed.target!, tick, day);
  const targetActivePartners = await getActiveTalkPartnersForAgent(ctx, parsed.target!);
  const targetAlreadyChattingWithOther = targetActivePartners.some((partner: string) => partner !== agentDoc.name);
  const deliveryMode: 'live' | 'deferred' = deliveryOverride
    ?? ((targetAgent.location === agentDoc.location && !targetAlreadyChattingWithOther) ? 'live' : 'deferred');
  await createChatMessage(ctx, {
    fromAgent: agentDoc.name,
    toAgent: parsed.target!,
    text,
    deliveryMode,
    tick,
    day,
  });

  if (deliveryMode === 'live') {
    await ctx.db.insert('rl_actions_log', {
      agentName: agentDoc.name,
      action: parsed.action,
      target: parsed.target ?? undefined,
      location: agentDoc.location,
      message: text,
      tick,
      day,
      outcome: 'success',
      outcomeNote: `Live chat message sent to ${parsed.target}.`,
    });

    await ctx.db.patch(agentDoc._id, {
      energy: newEnergy,
      health: newHealth,
      hunger: finalHunger,
      busy: false,
      busyUntilTick: undefined,
    });

    return {
      note: `Live chat sent to ${parsed.target}.`,
      outcome: 'success',
    };
  }

  await ctx.db.insert('rl_actions_log', {
    agentName: agentDoc.name,
    action: parsed.action,
    target: parsed.target ?? undefined,
    location: agentDoc.location,
    message: text,
    tick,
    day,
    outcome: 'success',
    outcomeNote: deferredReason ?? `Deferred chat sent to ${parsed.target}.`,
  });

  await ctx.db.patch(agentDoc._id, {
    energy: newEnergy,
    health: newHealth,
    hunger: finalHunger,
    busy: false,
    busyUntilTick: undefined,
  });

  await appendPendingNote(ctx, parsed.target!, `New chat from ${agentDoc.name}. Check CHAT.md.`);

  return {
    outcome: 'success',
    note: deferredReason ?? `${parsed.target} is not here. Your chat was sent to their thread.`,
  };
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
  await createActiveInteraction(ctx, {
    kind: parsed.action as 'buy' | 'sell' | 'trade',
    fromAgent: agentDoc.name,
    toAgent: parsed.target!,
    location: agentDoc.location,
    tick,
    day,
    payload: {
      offer: terms.offer,
      request: terms.request,
      message: parsed.text ?? parsed.message,
    },
    transactionId: txnId,
  });

  await ctx.db.insert('rl_actions_log', {
    agentName: agentDoc.name,
    action: parsed.action,
    target: parsed.target ?? undefined,
    location: agentDoc.location,
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
  const txn = await resolvePendingTransactionReference(ctx, agentDoc.name, parsed.target!);

  if (!txn) {
    const referencedTxn = await findTransactionByTargetReference(ctx, parsed.target!);
    if (referencedTxn?.fromAgent === agentDoc.name) {
      return recordFailedAction(
        ctx,
        agentDoc,
        agentDoc.name,
        parsed,
        tick,
        day,
        'You cannot accept or reject your own offer. Wait for the other person or make a new offer.',
      );
    }
    if (referencedTxn?.status && referencedTxn.status !== 'pending') {
      return recordFailedAction(
        ctx,
        agentDoc,
        agentDoc.name,
        parsed,
        tick,
        day,
        `That offer is no longer pending (${referencedTxn.status}).`,
      );
    }
    return recordFailedAction(ctx, agentDoc, agentDoc.name, parsed, tick, day, `Unknown pending offer: ${parsed.target}.`);
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
    await setInteractionOutcomeByTransactionId(ctx, txn.txnId, {
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
    await setInteractionOutcomeByTransactionId(ctx, txn.txnId, {
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
    await setInteractionOutcomeByTransactionId(ctx, txn.txnId, {
      status: 'responded',
      resolvedTick: tick,
      resolvedDay: day,
      outcomeNote: note,
    });
    await ctx.db.insert('rl_actions_log', {
      agentName: agentDoc.name,
      action: parsed.action,
      target: txn.txnId,
      location: agentDoc.location,
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
    await setInteractionOutcomeByTransactionId(ctx, txn.txnId, {
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
        await setInteractionOutcomeByTransactionId(ctx, txn.txnId, {
          status: 'failed',
          resolvedTick: tick,
          resolvedDay: day,
          outcomeNote: note,
        });
        await appendAgentHeartbeat(ctx, proposer.name, `- Day ${day} ${timeOfDayForTick(tick)}: your ${txn.kind} offer failed [FAILED] ⚠ ${note}`);
        await appendPendingNote(ctx, proposer.name, `Your ${txn.kind} offer (${txn.txnId}) failed: ${note}`);
        return recordFailedAction(ctx, agentDoc, agentDoc.name, parsed, tick, day, note);
      }
    } else if (getService(item.item)) {
      if (!canProvideService(proposer, item.item)) {
        const note = `${proposer.name} can no longer provide ${item.item} service right now.`;
        await ctx.db.patch(txn._id, { status: 'failed', resolvedTick: tick, resolvedDay: day, outcomeNote: note });
        await setInteractionOutcomeByTransactionId(ctx, txn.txnId, {
          status: 'failed',
          resolvedTick: tick,
          resolvedDay: day,
          outcomeNote: note,
        });
        await appendAgentHeartbeat(ctx, proposer.name, `- Day ${day} ${timeOfDayForTick(tick)}: your ${txn.kind} offer failed [FAILED] ⚠ ${note}`);
        await appendPendingNote(ctx, proposer.name, `Your ${txn.kind} offer (${txn.txnId}) failed: ${note}`);
        return recordFailedAction(ctx, agentDoc, agentDoc.name, parsed, tick, day, note);
      }
    } else if ((proposerInv[item.item] ?? 0) < item.quantity) {
      const note = `${proposer.name} no longer has enough ${item.item}: need ${item.quantity}, have ${proposerInv[item.item] ?? 0}.`;
      await ctx.db.patch(txn._id, { status: 'failed', resolvedTick: tick, resolvedDay: day, outcomeNote: note });
      await setInteractionOutcomeByTransactionId(ctx, txn.txnId, {
        status: 'failed',
        resolvedTick: tick,
        resolvedDay: day,
        outcomeNote: note,
      });
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
        await setInteractionOutcomeByTransactionId(ctx, txn.txnId, {
          status: 'failed',
          resolvedTick: tick,
          resolvedDay: day,
          outcomeNote: note,
        });
        await appendAgentHeartbeat(ctx, proposer.name, `- Day ${day} ${timeOfDayForTick(tick)}: your ${txn.kind} offer failed [FAILED] ⚠ ${note}`);
        await appendPendingNote(ctx, proposer.name, `Your ${txn.kind} offer (${txn.txnId}) failed: ${note}`);
        return recordFailedAction(ctx, agentDoc, agentDoc.name, parsed, tick, day, note);
      }
    } else if ((recipientInv[item.item] ?? 0) < item.quantity) {
      const note = `Not enough ${item.item} to accept: need ${item.quantity}, have ${recipientInv[item.item] ?? 0}.`;
      await ctx.db.patch(txn._id, { status: 'failed', resolvedTick: tick, resolvedDay: day, outcomeNote: note });
      await setInteractionOutcomeByTransactionId(ctx, txn.txnId, {
        status: 'failed',
        resolvedTick: tick,
        resolvedDay: day,
        outcomeNote: note,
      });
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
  for (const item of offer) {
    const service = getService(item.item);
    if (!service) continue;
    proposerApplied.newInventory = applyInventoryChanges(
      proposerApplied.newInventory,
      proposerApplied.newCoin,
      service.consumes,
      [],
      txn.kind,
    ).newInventory;
  }
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
  await setInteractionOutcomeByTransactionId(ctx, txn.txnId, {
    status: 'completed',
    resolvedTick: tick,
    resolvedDay: day,
    outcomeNote: `Completed: ${formatTransactionItems(offer)} for ${formatTransactionItems(request)}.`,
  });

  await ctx.db.insert('rl_actions_log', {
    agentName: proposer.name,
    action: txn.kind,
    target: agentDoc.name,
    location: proposer.location,
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
    location: agentDoc.location,
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

export const getActiveTalkPartners = internalQuery({
  args: { agentName: v.string() },
  handler: async (ctx, { agentName }) => {
    const scenes = await listLiveChatScenesForAgent(ctx, agentName);
    return Array.from(new Set(scenes.map((scene: any) => getScenePartner(scene, agentName))));
  },
});

export const getLiveChatScene = internalQuery({
  args: { agentName: v.string() },
  handler: async (ctx, { agentName }) => {
    const scene = await getLiveChatSceneForAgent(ctx, agentName);
    if (!scene) return null;
    return {
      ...scene,
      partner: getScenePartner(scene, agentName),
    };
  },
});

export const listLiveChatScenes = internalQuery({
  args: {},
  handler: async (ctx) => {
    const scenes = await ctx.db
      .query('rl_chat_scenes')
      .withIndex('status_location', (q: any) => q.eq('status', 'live'))
      .collect();
    return scenes;
  },
});

export const createLiveChatScene = internalMutation({
  args: {
    agentA: v.string(),
    agentB: v.string(),
    location: v.string(),
    nextSpeaker: v.string(),
    tick: v.number(),
    day: v.number(),
  },
  handler: async (ctx, { agentA, agentB, location, nextSpeaker, tick, day }) => {
    const existingA = await getLiveChatSceneForAgent(ctx, agentA);
    if (existingA) return existingA.sceneId;
    const existingB = await getLiveChatSceneForAgent(ctx, agentB);
    if (existingB) return existingB.sceneId;
    const sceneId = createChatSceneId(agentA, agentB, tick, day);
    await ctx.db.insert('rl_chat_scenes', {
      sceneId,
      agentA,
      agentB,
      location,
      status: 'live',
      nextSpeaker,
      openedTick: tick,
      openedDay: day,
      lastActiveTick: tick,
      lastActiveDay: day,
    });
    return sceneId;
  },
});

export const advanceLiveChatScene = internalMutation({
  args: {
    agentName: v.string(),
    tick: v.number(),
    day: v.number(),
  },
  handler: async (ctx, { agentName, tick, day }) => {
    const scene = await advanceLiveChatSceneForSpeaker(ctx, agentName, tick, day);
    return scene?.sceneId ?? null;
  },
});

export const closeLiveChatScene = internalMutation({
  args: {
    agentName: v.string(),
    tick: v.number(),
    day: v.number(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { agentName, tick, day, reason }) => {
    const closed = await closeLiveChatSceneForAgent(ctx, agentName, tick, day, reason);
    return closed
      ? {
          sceneId: closed.scene.sceneId,
          partner: closed.partner,
        }
      : null;
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
const INTERACTION_EXPIRY_TICKS = 2;

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

function createInteractionId(kind: string, fromAgent: string, toAgent: string, tick: number, day: number): string {
  const fromSlug = fromAgent.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const toSlug = toAgent.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `ix-${day}-${tick}-${kind}-${fromSlug}-${toSlug}-${Date.now()}`;
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
    chatDeliveryOverride: v.optional(v.union(v.literal('live'), v.literal('deferred'))),
    chatDeferredReason: v.optional(v.string()),
  },
  handler: async (ctx, { agentName, action, tick, day, chatDeliveryOverride, chatDeferredReason }) => {
    const parsed: RocklawAction = normaliseAction(JSON.parse(action) as RocklawAction);
    const agentDoc = await ctx.db
      .query('rl_agents')
      .withIndex('name', (q) => q.eq('name', agentName))
      .unique();
    if (!agentDoc) return { outcome: 'failed', note: 'Agent not found' };

    const worldValidation = await validateWorldExecution(ctx, agentDoc, parsed, tick);
    if (!worldValidation.ok) {
      const failNote = ('note' in worldValidation && typeof worldValidation.note === 'string')
        ? worldValidation.note
        : 'Action could not be executed.';
      return recordFailedAction(ctx, agentDoc, agentName, parsed, tick, day, failNote);
    }

    if (Array.isArray(worldValidation.consumes)) {
      parsed.consumes = worldValidation.consumes;
    }
    if (Array.isArray(worldValidation.produces)) {
      parsed.produces = worldValidation.produces;
      if (!parsed.item && worldValidation.produces.length === 1) {
        parsed.item = worldValidation.produces[0].item;
      }
    }
    if (worldValidation.cropItem && !parsed.item) {
      parsed.item = worldValidation.cropItem;
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
        location: agentDoc.location,
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

    // Apply movement
    let newLocation = agentDoc.location;
    if (parsed.action === 'move' && (parsed.location ?? parsed.target)) {
      newLocation = (worldValidation as { resolvedLocation?: string }).resolvedLocation
        ?? parsed.location
        ?? parsed.target
        ?? agentDoc.location;
      if (newLocation !== agentDoc.location) {
        await failActiveInteractionsForDeparture(ctx, agentDoc.name, agentDoc.location, tick, day);
      }
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
    const eatingHungerReduction = parsed.action === 'eat' ? hungerRestoreFor(parsed.item) : 0;
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

    if (parsed.action === 'leave_chat') {
      const closed = await closeLiveChatSceneForAgent(ctx, agentName, tick, day, `${agentName} left the live chat.`);
      const closingText = parsed.text ?? parsed.message ?? '';
      if (closed?.partner && closingText.trim() !== '') {
        await markUnreadChatFromContactRead(ctx, agentDoc.name, closed.partner, tick, day);
        await createChatMessage(ctx, {
          fromAgent: agentDoc.name,
          toAgent: closed.partner,
          text: closingText,
          deliveryMode: 'live',
          tick,
          day,
        });
      }
      await ctx.db.insert('rl_actions_log', {
        agentName,
        action: parsed.action,
        target: closed?.partner ?? undefined,
        location: agentDoc.location,
        message: closingText || undefined,
        tick,
        day,
        outcome: 'success',
        outcomeNote: closed?.partner
          ? closingText.trim() !== ''
            ? `Left live chat with ${closed.partner} after saying goodbye.`
            : `Left live chat with ${closed.partner}.`
          : 'Left live chat.',
      });
      await ctx.db.patch(agentDoc._id, {
        energy: newEnergy,
        health: newHealth,
        hunger: finalHunger,
        busy: false,
        busyUntilTick: undefined,
      });
      if (closed?.partner) {
        await appendPendingNote(
          ctx,
          closed.partner,
          closingText.trim() !== ''
            ? `${agentName} closed the live chat after saying: "${closingText}"`
            : `${agentName} left your live chat.`,
        );
      }
      return {
        outcome: 'success',
        note: closed?.partner
          ? closingText.trim() !== ''
            ? `You said goodbye and left the live chat with ${closed.partner}.`
            : `You left the live chat with ${closed.partner}.`
          : 'You left the live chat.',
      };
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

    if (parsed.action === 'chat') {
      const result = await sendChatAction(
        ctx,
        agentDoc,
        parsed,
        tick,
        day,
        newEnergy,
        newHealth,
        finalHunger,
        chatDeliveryOverride,
        chatDeferredReason,
      );
      if ((chatDeliveryOverride === 'live') && result?.outcome === 'success') {
        const scene = await getLiveChatSceneForAgent(ctx, agentName);
        if (scene) {
          await ctx.db.patch(scene._id, {
            nextSpeaker: getScenePartner(scene, agentName),
            lastSpeaker: agentName,
            lastActiveTick: tick,
            lastActiveDay: day,
          });
        }
      }
      return result;
    }

    if (parsed.action === 'say') {
      const speech = parsed.text ?? parsed.message ?? '';
      await createLocalSpeechNotes(ctx, {
        speaker: agentDoc.name,
        location: agentDoc.location,
        text: speech,
        tick,
        day,
      });
    }

    if (parsed.action === 'pay' || parsed.action === 'give') {
      if (!parsed.target) {
        return recordFailedAction(ctx, agentDoc, agentName, parsed, tick, day, `${parsed.action} requires a target agent.`);
      }
      const targetName = parsed.target;
      const recipient = await ctx.db
        .query('rl_agents')
        .withIndex('name', (q) => q.eq('name', targetName))
        .unique();
      if (!recipient) {
        return recordFailedAction(ctx, agentDoc, agentName, parsed, tick, day, `Target agent not found: ${targetName}.`);
      }

      const recipientProduces =
        parsed.action === 'pay'
          ? [{ item: 'coin', quantity: parsed.amount ?? 0 }]
          : parsed.item && typeof parsed.quantity === 'number'
          ? [{ item: parsed.item, quantity: parsed.quantity }]
          : [];

      const recipientApplied = transferToRecipient(
        recipient.inventory,
        recipient.coin,
        recipientProduces,
      );

      await ctx.db.patch(recipient._id, {
        inventory: recipientApplied.newInventory,
        coin: recipientApplied.newCoin,
      });
    }

    if (parsed.action === 'talk') {
      return createTalkInteraction(
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

    if (parsed.action === 'plant' && worldValidation.fieldKey) {
      const field = await ctx.db
        .query('rl_fields')
        .withIndex('fieldKey', (q: any) => q.eq('fieldKey', worldValidation.fieldKey!))
        .unique();
      if (field) {
        await ctx.db.patch(field._id, {
          cropItem: worldValidation.cropItem ?? parsed.item ?? 'grain',
          stage: 'growing',
          readyTick: tick + 4,
        });
      }
    }

    if (parsed.action === 'water' && worldValidation.fieldKey) {
      const field = await ctx.db
        .query('rl_fields')
        .withIndex('fieldKey', (q: any) => q.eq('fieldKey', worldValidation.fieldKey!))
        .unique();
      if (field && typeof field.readyTick === 'number') {
        await ctx.db.patch(field._id, {
          readyTick: Math.max(tick + 1, field.readyTick - 1),
        });
      }
    }

    if (parsed.action === 'harvest' && worldValidation.fieldKey) {
      const field = await ctx.db
        .query('rl_fields')
        .withIndex('fieldKey', (q: any) => q.eq('fieldKey', worldValidation.fieldKey!))
        .unique();
      if (field) {
        await ctx.db.patch(field._id, {
          cropItem: null,
          stage: 'fallow',
          readyTick: null,
        });
      }
    }

    if (parsed.action === 'gather' && worldValidation.herbPatchKey) {
      const patch = await ctx.db
        .query('rl_herb_patches')
        .withIndex('patchKey', (q: any) => q.eq('patchKey', worldValidation.herbPatchKey!))
        .unique();
      if (patch) {
        const gatheredQty = Array.isArray(worldValidation.produces) && worldValidation.produces.length > 0
          ? worldValidation.produces[0].quantity
          : 1;
        await ctx.db.patch(patch._id, {
          available: Math.max(0, patch.available - gatheredQty),
        });
      }
    }

    if (parsed.action !== 'wait') {
      await noteTalkNonResponse(ctx, agentDoc.name, parsed.action, tick, day);
    }

    // Log the action
    await ctx.db.insert('rl_actions_log', {
      agentName,
      action: parsed.action,
      target: parsed.target ?? parsed.location ?? parsed.item ?? undefined,
      location: newLocation,
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
    if (['buy', 'sell', 'craft', 'smelt', 'brew', 'give', 'trade', 'eat', 'plant', 'harvest', 'gather'].includes(parsed.action)) {
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
