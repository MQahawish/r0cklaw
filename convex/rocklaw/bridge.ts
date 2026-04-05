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
import {
  ROLE_ECONOMIC_ACTIONS,
  canonicalizeItemEntries,
  canonicalizeItemId,
  canonicalizeItemQuantities,
  formatItemLabel,
  formatItemQuantity,
  getRecipes,
  getRecipe,
  getService,
  healthRestoreFor,
  hungerRestoreFor,
  isEdible,
  isUsable,
} from './economy';
import { describeActionForHumans, getActionDuration } from './actionTiming';
import { isSleepPeriod, timeOfDayForTick } from './dayCycle';
import { derivePlaceQuote } from './placeMarkets';

// ── Types ────────────────────────────────────────────────────────────────────

export type RocklawAction = {
  action: string;
  target?: string | null;
  location?: string | null;
  text?: string;
  intent?: string | null;
  offer_ref?: string | null;
  topic?: string;
  item?: string | null;
  quantity?: number | null;
  amount?: number | null;
  offer?: unknown[];
  request?: unknown[];
  duration_ticks?: number;
  thought?: string;
  message?: string;
  journal?: string;
  consumes: unknown[];
  produces: unknown[];
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
      workKind?: 'blacksmith' | 'plant' | 'water' | 'harvest' | 'gather' | 'brew' | 'mill' | 'bake';
      resolvedLocation?: string;
      resolvedTarget?: string;
      consumes?: Array<{ item: string; quantity: number }>;
      produces?: Array<{ item: string; quantity: number }>;
      fieldKey?: string;
      cropItem?: string;
      herbPatchKey?: string;
      placeStockId?: any;
      placeMarketId?: any;
      settledAmount?: number;
      settledItem?: string;
      stockDelta?: number;
      placeTreasuryDelta?: number;
      note?: string;
    };

// Effort costs per action (deducted from energy after completion)
const EFFORT_COSTS: Record<string, number> = {
  // Physical labour
  work: 16,
  craft: 16, smelt: 18, repair: 20, mine: 45,
  harvest: 14, plant: 12, water: 5, check_field: 2,
  gather: 6, brew: 8, treat: 8, identify: 3,
  patrol: 25, train: 20,
  // Commerce & social
  negotiate: 5, bulk_buy: 3, post_price: 1, appraise: 2,
  serve: 5, rent_room: 3, eavesdrop: 2, post_notice: 2,
  bless: 3, counsel: 4, preach: 6, officiate: 8,
  play: 4,
  run_errand: 8, recall_war: 2,
  // Universal
  move: 3, chat: 2, leave_chat: 0, say: 1, message: 2, talk: 2, buy: 2, sell: 2, pay: 1, give: 1,
  buy_place: 1, sell_place: 1, deliver_place: 2,
  trade: 2, accept_transaction: 1, reject_transaction: 1, wait: 0, observe: 1, write: 2, pray: 0,
  recall: 0,
  eat: 0, use: 1, rest: -18, sleep: -70,
};

const BLACKSMITH_WORK_PRIORITY = ['horseshoe', 'tool', 'knife', 'iron_ingot'] as const;
const FARMER_WORK_CROPS = ['grain', 'vegetable'] as const;
const HERBALIST_WORK_OUTPUTS = ['herb', 'medicine'] as const;
const INNKEEPER_WORK_OUTPUTS = ['bread', 'flour'] as const;
const PROMPT_ACTION_HINT_MAX_LINES = 8;
const PROMPT_ACTION_HINT_MAX_OPTIONS_PER_GROUP = 3;
const LIVE_CHAT_FULL_TRANSCRIPT_MAX_LINES = 8;
const LIVE_CHAT_RECENT_TRANSCRIPT_MAX_LINES = 6;
const SCENE_OPENING_OFFER_REF = 'scene-offer-1';
const SCENE_OPENING_OFFER_INTENTS = new Set(['buy', 'sell', 'trade', 'give', 'pay']);

function trimPromptPreview(text: string, maxLength = 48): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

function capPromptOptions(values: string[]): string[] {
  return Array.from(new Set(values)).slice(0, PROMPT_ACTION_HINT_MAX_OPTIONS_PER_GROUP);
}

function formatPromptHintLine(label: string, values: string[]): string | null {
  const capped = capPromptOptions(values);
  if (capped.length === 0) return null;
  return `- ${label}: ${capped.join(', ')}`;
}

function formatBoundedQuantityHint(base: string, maxQuantity: number): string | null {
  if (!Number.isFinite(maxQuantity) || maxQuantity < 1) return null;
  if (maxQuantity === 1) return `${base} x1`;
  return `${base} x1-${maxQuantity}`;
}

function isSceneOpeningOfferRef(rawTarget: string | null | undefined) {
  return (rawTarget ?? '').trim().toLowerCase() === SCENE_OPENING_OFFER_REF;
}

function canonicalizeTransactionItemId(item: string | null | undefined): string | null | undefined {
  const canonical = canonicalizeItemId(item ?? undefined);
  if (canonical === 'coin_purse') return 'coin';
  return canonical;
}

function applyProducedItemBonus(
  produces: Array<{ item: string; quantity: number }> | undefined,
  item: string,
  bonus: number,
) {
  if (!Array.isArray(produces) || bonus <= 0) return produces;
  return produces.map((entry) =>
    entry.item === item ? { ...entry, quantity: entry.quantity + bonus } : entry,
  );
}

function hasInventoryItem(agentDoc: any, item: string, quantity = 1): boolean {
  return inventoryHasAtLeast(agentDoc.inventory, item, quantity);
}

function feasibleBlacksmithOutputs(agentDoc: any): string[] {
  if (agentDoc.role !== 'Blacksmith') return [];
  const feasible: string[] = [];
  for (const output of BLACKSMITH_WORK_PRIORITY) {
    const recipes = getRecipes('work', output);
    if (recipes.length === 0) continue;
    const feasibleRecipe = recipes.find((recipe) =>
      agentDoc.location === recipe.location && !formatRequirementShortfall(agentDoc.inventory, recipe.consumes),
    );
    if (feasibleRecipe) feasible.push(output);
  }
  return feasible;
}

async function feasibleFarmerWorkOutputs(ctx: any, agentDoc: any): Promise<string[]> {
  if (agentDoc.role !== 'Farmer' || agentDoc.location !== 'farm') return [];
  const fields = await getFieldsAtLocation(ctx, agentDoc.location);
  const feasible: string[] = [];
  for (const field of fields) {
    if (field.stage === 'ready' && field.cropItem) feasible.push(field.cropItem);
  }
  if (fields.some((field: any) => field.stage === 'growing')) feasible.push('field_maintenance');
  for (const crop of FARMER_WORK_CROPS) {
    const hasFallowField = fields.some((field: any) => field.stage === 'fallow');
    if (hasFallowField && inventoryHasAtLeast(agentDoc.inventory, crop, 1)) feasible.push(crop);
  }
  return Array.from(new Set(feasible));
}

async function feasibleHerbalistWorkOutputs(ctx: any, agentDoc: any): Promise<string[]> {
  if (agentDoc.role !== 'Herbalist') return [];
  const feasible: string[] = [];
  const patches = await getHerbPatchesAtLocation(ctx, agentDoc.location);
  if (patches.some((entry: any) => entry.available > 0)) feasible.push('herb');
  const medicineRecipe = getRecipe('brew', 'medicine');
  if (medicineRecipe && agentDoc.location === medicineRecipe.location && !formatRequirementShortfall(agentDoc.inventory, medicineRecipe.consumes)) {
    feasible.push('medicine');
  }
  return feasible;
}

async function feasibleInnkeeperWorkOutputs(agentDoc: any): Promise<string[]> {
  if (agentDoc.role !== 'Innkeeper' || agentDoc.location !== 'bakery') return [];
  const feasible: string[] = [];
  for (const output of INNKEEPER_WORK_OUTPUTS) {
    const recipes = getRecipes('work', output);
    if (recipes.some((recipe) => recipe.location === 'bakery' && !formatRequirementShortfall(agentDoc.inventory, recipe.consumes))) {
      feasible.push(output);
    }
  }
  return feasible;
}

async function getPendingTalkInvitation(ctx: any, agentDoc: any) {
  const received = await ctx.db
    .query('rl_interactions')
    .withIndex('recipient_status', (q: any) => q.eq('toAgent', agentDoc.name).eq('status', 'active'))
    .collect();

  const invitations: Array<{ fromAgent: string; text: string; createdDay: number; createdTick: number }> = [];
  for (const interaction of received) {
    if (interaction.kind !== 'talk') continue;
    const fromAgent = await getAgentByName(ctx, interaction.fromAgent);
    if (!fromAgent || fromAgent.location !== agentDoc.location) continue;
    const payload = interaction.payloadJson ? JSON.parse(interaction.payloadJson) as { text?: string; message?: string } : {};
    invitations.push({
      fromAgent: interaction.fromAgent,
      text: (payload.text ?? payload.message ?? '').trim(),
      createdDay: interaction.createdDay ?? 0,
      createdTick: interaction.createdTick ?? 0,
    });
  }

  invitations.sort((a, b) => a.createdDay - b.createdDay || a.createdTick - b.createdTick || a.fromAgent.localeCompare(b.fromAgent));
  return invitations[0] ?? null;
}

async function getScenePartnerPendingTransactions(ctx: any, agentName: string, partner: string) {
  const incoming = await ctx.db
    .query('rl_transactions')
    .withIndex('recipient_status', (q: any) => q.eq('toAgent', agentName).eq('status', 'pending'))
    .collect();

  return incoming
    .filter((txn: any) => txn.fromAgent === partner)
    .sort((a: any, b: any) => a.createdDay - b.createdDay || a.createdTick - b.createdTick || a.txnId.localeCompare(b.txnId))
    .map((txn: any, index: number) => ({
      ...txn,
      responseRef: `offer-${index + 1}`,
    }));
}

async function supersedePendingTransactionsBetweenAgents(
  ctx: any,
  agentA: string,
  agentB: string,
  tick: number,
  day: number,
  reason: string,
) {
  const pending = await ctx.db
    .query('rl_transactions')
    .filter((q: any) =>
      q.and(
        q.eq(q.field('status'), 'pending'),
        q.or(
          q.and(q.eq(q.field('fromAgent'), agentA), q.eq(q.field('toAgent'), agentB)),
          q.and(q.eq(q.field('fromAgent'), agentB), q.eq(q.field('toAgent'), agentA)),
        ),
      ),
    )
    .collect();

  for (const txn of pending) {
    await ctx.db.patch(txn._id, {
      status: 'superseded',
      resolvedTick: tick,
      resolvedDay: day,
      outcomeNote: reason,
    });
    await setInteractionOutcomeByTransactionId(ctx, txn.txnId, {
      status: 'failed',
      resolvedTick: tick,
      resolvedDay: day,
      outcomeNote: reason,
    });
  }
}

async function buildPromptActionHints(ctx: any, agentDoc: any, tick?: number): Promise<string[]> {
  const lines: string[] = [];
  const liveScene = await getLiveChatSceneForAgent(ctx, agentDoc.name);

  if (liveScene) {
    const partner = getScenePartner(liveScene, agentDoc.name);
    const canSpeakNow = typeof tick === 'number'
      ? liveScene.openedTick === tick || liveScene.nextSpeaker === agentDoc.name
      : liveScene.nextSpeaker === agentDoc.name;
    if (canSpeakNow) {
      lines.push(`- chat: continue with ${partner}`);
      const openingOffer = await getSceneOpeningOfferForRecipient(ctx, liveScene, agentDoc);
      if (openingOffer) {
        lines.push(`- chat: accept_transaction or reject_transaction (${openingOffer.offerRef})`);
      }
      const actionableOffers = await getScenePartnerPendingTransactions(ctx, agentDoc.name, partner);
      if (actionableOffers.length > 0) {
        const offerRefs = actionableOffers
          .slice(0, PROMPT_ACTION_HINT_MAX_OPTIONS_PER_GROUP)
          .map((txn: any) => txn.responseRef);
        lines.push(`- chat: accept_transaction or reject_transaction (${offerRefs.join(', ')})`);
      }
    }
    lines.push('- leave_chat');
    return lines.slice(0, PROMPT_ACTION_HINT_MAX_LINES);
  }

  const opener = await getPendingTalkInvitation(ctx, agentDoc);
  if (opener) {
    const preview = opener.text ? ` ("${trimPromptPreview(opener.text)}")` : '';
    lines.push(`- chat: respond to ${opener.fromAgent}${preview}`);
  }

  if (agentDoc.role === 'Blacksmith') {
    const outputs = feasibleBlacksmithOutputs(agentDoc);
    const line = formatPromptHintLine('work', outputs.length > 0 ? ['best available', ...outputs] : []);
    if (line) lines.push(line);
  } else if (agentDoc.role === 'Farmer') {
    const outputs = await feasibleFarmerWorkOutputs(ctx, agentDoc);
    const cropOutputs = outputs.filter((entry) => entry !== 'field_maintenance');
    const hints = outputs.includes('field_maintenance') ? ['best available', ...cropOutputs] : cropOutputs;
    const line = formatPromptHintLine('work', hints);
    if (line) lines.push(line);
  } else if (agentDoc.role === 'Herbalist') {
    const outputs = await feasibleHerbalistWorkOutputs(ctx, agentDoc);
    const line = formatPromptHintLine('work', outputs.length > 0 ? ['best available', ...outputs] : []);
    if (line) lines.push(line);
  } else if (agentDoc.role === 'Innkeeper') {
    const outputs = await feasibleInnkeeperWorkOutputs(agentDoc);
    const line = formatPromptHintLine('work', outputs.length > 0 ? ['best available', ...outputs] : []);
    if (line) lines.push(line);
  }

  const usableInventoryHints = Object.entries(parseInventoryRecord(agentDoc.inventory))
    .filter(([item, quantity]) => quantity > 0 && isUsable(item))
    .map(([item]) => item);
  const useLine = formatPromptHintLine('use', usableInventoryHints);
  if (useLine) lines.push(useLine);

  const nearbyPlaceStocks = await ctx.db
    .query('rl_place_stocks')
    .withIndex('place', (q: any) => q.eq('placeName', agentDoc.location))
    .collect();
  const nearbyPlaceMarket = await ctx.db
    .query('rl_place_markets')
    .withIndex('placeName', (q: any) => q.eq('placeName', agentDoc.location))
    .unique();
  const prices = await ctx.db.query('rl_market_prices').collect();
  const priceByItem = new Map(prices.map((price: any) => [price.item, price.price]));
  const inventory = parseInventoryRecord(agentDoc.inventory);
  const buyPlaceHints: string[] = [];
  const sellPlaceHints: string[] = [];
  const deliverPlaceHints: string[] = [];

  for (const stock of nearbyPlaceStocks) {
    const market = nearbyPlaceMarket ?? {
      placeName: stock.placeName,
      treasury: 0,
      buySpreadPct: 0.15,
      sellSpreadPct: 0.15,
      targetStockRatio: 0.5,
    };
    const quotedPrice = priceByItem.get(stock.item);
    const quote = derivePlaceQuote(stock, market, typeof quotedPrice === 'number' ? quotedPrice : undefined);
    if (stock.sells && quote.canCurrentlySell && typeof quote.askPrice === 'number' && quote.askPrice > 0 && agentDoc.coin >= quote.askPrice && stock.quantity > 0) {
      const maxAffordable = Math.floor(agentDoc.coin / quote.askPrice);
      const maxBuyQuantity = Math.min(stock.quantity, maxAffordable);
      const hint = formatBoundedQuantityHint(`${stock.item} from ${stock.placeName}`, maxBuyQuantity);
      if (hint) buyPlaceHints.push(hint);
    }
    if (stock.buys && quote.canCurrentlyBuy && typeof quote.bidPrice === 'number' && quote.bidPrice > 0 && (inventory[stock.item] ?? 0) > 0 && quote.maxAffordableQuantity >= 1) {
      const inventoryQuantity = inventory[stock.item] ?? 0;
      const capacityLimit = quote.remainingCapacity === null ? Number.POSITIVE_INFINITY : quote.remainingCapacity;
      const maxSellQuantity = Math.min(inventoryQuantity, quote.maxAffordableQuantity, capacityLimit);
      const hint = formatBoundedQuantityHint(`${stock.item} to ${stock.placeName}`, maxSellQuantity);
      if (hint) sellPlaceHints.push(hint);
    }
    const remainingCapacity = quote.remainingCapacity;
    if ((inventory[stock.item] ?? 0) > 0 && (remainingCapacity === null || remainingCapacity > 0)) {
      const inventoryQuantity = inventory[stock.item] ?? 0;
      const maxDeliverQuantity = remainingCapacity === null
        ? inventoryQuantity
        : Math.min(inventoryQuantity, remainingCapacity);
      const hint = formatBoundedQuantityHint(`${stock.item} to ${stock.placeName}`, maxDeliverQuantity);
      if (hint) deliverPlaceHints.push(hint);
    }
  }

  const buyLine = formatPromptHintLine('buy_place', buyPlaceHints);
  if (buyLine) lines.push(buyLine);
  const sellLine = formatPromptHintLine('sell_place', sellPlaceHints);
  if (sellLine) lines.push(sellLine);
  const deliverLine = formatPromptHintLine('deliver_place', deliverPlaceHints);
  if (deliverLine) lines.push(deliverLine);

  const visibleAgents = await ctx.db
    .query('rl_agents')
    .withIndex('location', (q: any) => q.eq('location', agentDoc.location))
    .collect();
  const socialKnowledge = await ctx.db
    .query('rl_social_knowledge')
    .withIndex('observer', (q: any) => q.eq('observerAgent', agentDoc.name))
    .collect();
  const sentMessages = await ctx.db
    .query('rl_chat_messages')
    .withIndex('sender_sent', (q: any) => q.eq('fromAgent', agentDoc.name))
    .collect();
  const receivedMessages = await ctx.db
    .query('rl_chat_messages')
    .withIndex('recipient_sent', (q: any) => q.eq('toAgent', agentDoc.name))
    .collect();
  const knownTargets = new Set<string>();
  for (const other of visibleAgents) {
    if (other.name !== agentDoc.name) knownTargets.add(other.name);
  }
  for (const entry of socialKnowledge) {
    if (entry.subjectAgent !== agentDoc.name) knownTargets.add(entry.subjectAgent);
  }
  for (const entry of [...sentMessages, ...receivedMessages]) {
    knownTargets.add(entry.fromAgent === agentDoc.name ? entry.toAgent : entry.fromAgent);
  }
  if (opener) knownTargets.delete(opener.fromAgent);
  const chatLine = formatPromptHintLine('chat', Array.from(knownTargets).sort((a, b) => a.localeCompare(b)));
  if (chatLine) lines.push(chatLine);

  const locations = await ctx.db.query('rl_locations').collect();
  const moveLine = formatPromptHintLine(
    'move',
    locations
      .map((entry: any) => entry.name)
      .filter((name: string) => name !== agentDoc.location)
      .sort((a: string, b: string) => a.localeCompare(b)),
  );
  if (moveLine) lines.push(moveLine);

  if (agentDoc.energy < 60) {
    lines.push('- rest');
  }
  const currentTimeOfDay = typeof tick === 'number' ? timeOfDayForTick(tick) : null;
  if ((currentTimeOfDay !== null && isSleepPeriod(currentTimeOfDay)) || agentDoc.energy < 20) {
    lines.push('- sleep');
  }
  lines.push('- say');

  return lines.slice(0, PROMPT_ACTION_HINT_MAX_LINES);
}

function buildTradeableInventoryHints(agentDoc: any): string[] {
  const inventory = parseInventoryRecord(agentDoc.inventory);
  return Object.entries(inventory)
    .filter(([item, quantity]) => item !== 'coin' && quantity > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0]))
    .slice(0, PROMPT_ACTION_HINT_MAX_OPTIONS_PER_GROUP)
    .map(([item, quantity]) => formatItemQuantity(item, quantity));
}

async function evaluateTransactionAcceptability(ctx: any, txn: any, recipientAgent: any) {
  const offer = parseTransactionItems(txn.offerJson);
  const request = parseTransactionItems(txn.requestJson);
  return evaluateExchangeAcceptability(ctx, txn.fromAgent, offer, request, recipientAgent);
}

async function evaluateExchangeAcceptability(
  ctx: any,
  proposerName: string,
  offer: TransactionItem[],
  request: TransactionItem[],
  recipientAgent: any,
) {
  const proposer = await getAgentByName(ctx, proposerName);
  if (!proposer) {
    return { ok: false, reason: `${proposerName} is no longer available.` };
  }

  const proposerInv = parseInventoryRecord(proposer.inventory);
  const recipientInv = parseInventoryRecord(recipientAgent.inventory);

  for (const item of offer) {
    if (item.item === 'coin') {
      if (proposer.coin < item.quantity) {
        return { ok: false, reason: `${proposerName} no longer has ${item.quantity}c available.` };
      }
      continue;
    }
    if (getService(item.item)) {
      if (!canProvideService(proposer, item.item)) {
        return { ok: false, reason: `${proposerName} cannot currently provide ${item.item}.` };
      }
      continue;
    }
    if ((proposerInv[item.item] ?? 0) < item.quantity) {
      return { ok: false, reason: `${proposerName} no longer has enough ${item.item}.` };
    }
  }

  for (const item of request) {
    if (item.item === 'coin') {
      if (recipientAgent.coin < item.quantity) {
        return { ok: false, reason: `You only have ${recipientAgent.coin}c, not ${item.quantity}c.` };
      }
      continue;
    }
    if ((recipientInv[item.item] ?? 0) < item.quantity) {
      return { ok: false, reason: `You only have ${formatItemQuantity(item.item, recipientInv[item.item] ?? 0)}.` };
    }
  }

  return { ok: true, reason: 'yes' };
}

function buildOfferAndRequestForIntent(parsed: RocklawAction): { offer: TransactionItem[]; request: TransactionItem[] } {
      const chatIntent = getChatCommerceIntent(parsed);
  switch (chatIntent) {
    case 'give':
      return {
        offer: parsed.item && typeof parsed.quantity === 'number' && parsed.quantity > 0
          ? [{ item: parsed.item, quantity: parsed.quantity }]
          : [],
        request: [],
      };
    case 'pay':
      return {
        offer: typeof parsed.amount === 'number' && parsed.amount > 0
          ? [{ item: 'coin', quantity: parsed.amount }]
          : [],
        request: [],
      };
    default:
      return buildTransactionTerms(parsed);
  }
}

function getSceneOpeningOfferParsed(scene: any): RocklawAction | null {
  if (!scene?.openingOfferPayloadJson) return null;
  try {
    return normaliseAction(JSON.parse(scene.openingOfferPayloadJson) as RocklawAction);
  } catch {
    return null;
  }
}

async function getSceneOpeningOfferForRecipient(ctx: any, scene: any, recipientAgent: any) {
  const parsed = getSceneOpeningOfferParsed(scene);
  if (!parsed) return null;
  const proposerName = scene.openingSpeaker;
  if (!proposerName || proposerName === recipientAgent.name) return null;
  if (scene.nextSpeaker !== recipientAgent.name) return null;
  const intent = getChatCommerceIntent(parsed);
  if (!intent || !SCENE_OPENING_OFFER_INTENTS.has(intent)) return null;
  const { offer, request } = buildOfferAndRequestForIntent(parsed);
  return {
    proposerName,
    offerRef: scene.openingOfferRef ?? SCENE_OPENING_OFFER_REF,
    parsed,
    offer,
    request,
  };
}

async function clearSceneOpeningOffer(ctx: any, scene: any) {
  if (!scene) return;
  await ctx.db.patch(scene._id, {
    openingOfferRef: undefined,
    openingOfferPayloadJson: undefined,
  });
}

async function createPendingTransactionFromParsedOffer(
  ctx: any,
  proposerName: string,
  recipientName: string,
  location: string,
  parsed: RocklawAction,
  tick: number,
  day: number,
) {
  const intent = getChatCommerceIntent(parsed);
  const terms = buildOfferAndRequestForIntent(parsed);
  const kind = intent === 'buy' || intent === 'sell' ? intent : 'trade';
  const txnId = createTransactionId(kind, proposerName, tick, day);
  await ctx.db.insert('rl_transactions', {
    txnId,
    fromAgent: proposerName,
    toAgent: recipientName,
    kind,
    offerJson: serialiseTransactionItems(terms.offer),
    requestJson: serialiseTransactionItems(terms.request),
    message: parsed.text ?? parsed.message,
    status: 'pending',
    createdTick: tick,
    createdDay: day,
    expiresTick: tick + OFFER_EXPIRY_TICKS,
  });
  await createActiveInteraction(ctx, {
    kind: kind as 'buy' | 'sell' | 'trade',
    fromAgent: proposerName,
    toAgent: recipientName,
    location,
    tick,
    day,
    payload: {
      offer: terms.offer,
      request: terms.request,
      message: parsed.text ?? parsed.message,
    },
    transactionId: txnId,
  });
  return txnId;
}

async function buildLiveChatTradeFacts(ctx: any, agentDoc: any): Promise<string[]> {
  const liveScene = await getLiveChatSceneForAgent(ctx, agentDoc.name);
  if (!liveScene) return [];
  const partner = getScenePartner(liveScene, agentDoc.name);
  const lines: string[] = [];

  lines.push('Live trade facts now:');
  lines.push(`- you have now: ${buildTradeableInventoryHints(agentDoc).join(', ') || 'no goods available'}, ${agentDoc.coin}c`);
  lines.push(`- you can pay now: up to ${agentDoc.coin}c total`);
  lines.push('- you cannot offer more goods or coin than you currently hold');

  const openingOffer = await getSceneOpeningOfferForRecipient(ctx, liveScene, agentDoc);
  if (openingOffer) {
    const acceptability = await evaluateExchangeAcceptability(
      ctx,
      openingOffer.proposerName,
      openingOffer.offer,
      openingOffer.request,
      agentDoc,
    );
    lines.push(
      `- opening live offer from ${openingOffer.proposerName}: ${openingOffer.offerRef} -> offers ${formatTransactionItems(openingOffer.offer)} for ${formatTransactionItems(openingOffer.request)}`,
    );
    lines.push(`- you can accept it now: ${acceptability.ok ? 'yes' : `no (${acceptability.reason})`}`);
  }

  const actionableOffers = await getScenePartnerPendingTransactions(ctx, agentDoc.name, partner);
  const currentOffer = actionableOffers[actionableOffers.length - 1];
  if (currentOffer) {
    const acceptability = await evaluateTransactionAcceptability(ctx, currentOffer, agentDoc);
    lines.push(
      `- current actionable offer from ${partner}: ${currentOffer.responseRef} -> offers ${formatTransactionItems(parseTransactionItems(currentOffer.offerJson))} for ${formatTransactionItems(parseTransactionItems(currentOffer.requestJson))}`,
    );
    lines.push(`- you can accept it now: ${acceptability.ok ? 'yes' : `no (${acceptability.reason})`}`);
  }

  return lines;
}

function isAtOrAfterSceneOpen(message: any, scene: any): boolean {
  if (message.sentDay > scene.openedDay) return true;
  if (message.sentDay < scene.openedDay) return false;
  return message.sentTick >= scene.openedTick;
}

function formatSceneTranscriptLine(entry: any): string {
  const speaker = entry.fromAgent === '[system]' ? '[system]' : entry.fromAgent;
  return `- ${speaker}: ${entry.text}`;
}

function pickLiveSceneTranscriptEntries(messages: any[]): { lines: string[]; truncated: boolean } {
  const formatted = messages.map((entry) => ({
    key: `${entry.sentDay}:${entry.sentTick}:${entry.fromAgent}:${entry.text}`,
    line: formatSceneTranscriptLine(entry),
    day: entry.sentDay,
    tick: entry.sentTick,
  }));

  if (formatted.length <= LIVE_CHAT_FULL_TRANSCRIPT_MAX_LINES) {
    return { lines: formatted.map((entry) => entry.line), truncated: false };
  }

  const recent = formatted.slice(-LIVE_CHAT_RECENT_TRANSCRIPT_MAX_LINES);
  const recentKeys = new Set(recent.map((entry) => entry.key));
  const olderSystem = formatted.filter((entry) =>
    entry.line.startsWith('- [system]:') && !recentKeys.has(entry.key),
  );
  const merged = [...olderSystem, ...recent]
    .sort((a, b) => a.day - b.day || a.tick - b.tick);
  return { lines: merged.map((entry) => entry.line), truncated: true };
}

function pickLiveChatTranscriptEntriesForPrompt(
  sceneMessages: any[],
  fallbackMessages: any[],
): { lines: string[]; truncated: boolean } {
  if (sceneMessages.length > 0) {
    return pickLiveSceneTranscriptEntries(sceneMessages);
  }
  return pickLiveSceneTranscriptEntries(fallbackMessages);
}

async function buildLiveChatPromptContext(ctx: any, agentDoc: any) {
  const scene = await getLiveChatSceneForAgent(ctx, agentDoc.name);
  if (!scene) return null;

  const partner = getScenePartner(scene, agentDoc.name);
  const threadKey = createChatThreadKey(agentDoc.name, partner);
  const allMessages = await ctx.db
    .query('rl_chat_messages')
    .withIndex('thread_sent', (q: any) => q.eq('threadKey', threadKey))
    .collect();

  const sceneMessages = allMessages
    .filter((entry: any) => entry.deliveryMode === 'live' && entry.sceneId === scene.sceneId)
    .sort(compareChatMessageOrder);

  const fallbackSceneMessages = sceneMessages.length === 0
    ? allMessages
      .filter((entry: any) =>
        entry.deliveryMode === 'live'
        && !entry.sceneId
        && isAtOrAfterSceneOpen(entry, scene),
      )
      .sort(compareChatMessageOrder)
    : [];

  const latestPartnerMessage = [...sceneMessages, ...fallbackSceneMessages]
    .reverse()
    .find((entry: any) => entry.fromAgent === partner)?.text ?? null;

  const transcript = pickLiveChatTranscriptEntriesForPrompt(sceneMessages, fallbackSceneMessages);
  const openingOffer = await getSceneOpeningOfferForRecipient(ctx, scene, agentDoc);

  return {
    partner,
    location: scene.location,
    yourTurn: scene.nextSpeaker === agentDoc.name,
    latestPartnerMessage,
    transcriptLines: transcript.lines,
    transcriptTruncated: transcript.truncated,
    openingOfferRef: openingOffer?.offerRef ?? null,
    openingOfferSummary: openingOffer
      ? `offers ${formatTransactionItems(openingOffer.offer)} for ${formatTransactionItems(openingOffer.request)}`
      : null,
  };
}

function resolveBlacksmithWorkRecipe(agentDoc: any, requestedItem?: string | null) {
  if (agentDoc.role !== 'Blacksmith') {
    return { recipe: null as ReturnType<typeof getRecipe>, note: `${agentDoc.role} cannot use work as a role action.` };
  }

  if (requestedItem) {
    const isKnownOutput = BLACKSMITH_WORK_PRIORITY.includes(requestedItem as (typeof BLACKSMITH_WORK_PRIORITY)[number]);
    const recipe = getRecipes('work', requestedItem).find((entry) =>
      agentDoc.location === entry.location && !formatRequirementShortfall(agentDoc.inventory, entry.consumes),
    ) ?? null;
    if (!recipe) {
      const feasible = feasibleBlacksmithOutputs(agentDoc);
      return {
        recipe: null as ReturnType<typeof getRecipe>,
        note: isKnownOutput
          ? feasible.length > 0
            ? `${requestedItem} is a valid blacksmith output, but you cannot make it right now. Feasible outputs right now: ${feasible.join(', ')}.`
            : `${requestedItem} is a valid blacksmith output, but you lack the needed inputs or are not at the forge right now. Gather inputs or move to the forge.`
          : feasible.length > 0
            ? `Blacksmith work cannot produce ${requestedItem}. Feasible outputs right now: ${feasible.join(', ')}.`
            : `Blacksmith work cannot produce ${requestedItem}. Choose horseshoe, tool, knife, or iron_ingot.`,
      };
    }
    return { recipe, note: null as string | null };
  }

  for (const output of BLACKSMITH_WORK_PRIORITY) {
    const recipe = getRecipes('work', output).find((entry) =>
      agentDoc.location === entry.location && !formatRequirementShortfall(agentDoc.inventory, entry.consumes),
    ) ?? null;
    if (!recipe) continue;
    return { recipe, note: null as string | null };
  }

  return {
    recipe: null as ReturnType<typeof getRecipe>,
    note: 'No valid blacksmith work is available right now. Move to the forge or gather the needed inputs first.',
  };
}

async function resolveFarmerWork(ctx: any, agentDoc: any, requestedItem?: string | null) {
  if (agentDoc.role !== 'Farmer') {
    return { validation: null as WorldValidation | null, note: `${agentDoc.role} cannot use work as a role action.` };
  }
  if (agentDoc.location !== 'farm') {
    return { validation: null as WorldValidation | null, note: 'Farmer work is only available at the farm.' };
  }

  const fields = await getFieldsAtLocation(ctx, agentDoc.location);
  const readyField = (crop?: string | null) => fields.find((entry: any) => entry.stage === 'ready' && entry.cropItem && (!crop || entry.cropItem === crop));
  const growingField = fields.find((entry: any) => entry.stage === 'growing');
  const fallowField = fields.find((entry: any) => entry.stage === 'fallow');
  const harvestBonus = hasInventoryItem(agentDoc, 'tool', 1) ? 1 : 0;

  if (requestedItem) {
    if (!FARMER_WORK_CROPS.includes(requestedItem as (typeof FARMER_WORK_CROPS)[number])) {
      const feasible = await feasibleFarmerWorkOutputs(ctx, agentDoc);
      return {
        validation: null as WorldValidation | null,
        note: feasible.length > 0
          ? `Farmer work cannot target ${requestedItem}. Feasible work right now: ${feasible.join(', ')}.`
          : `Farmer work cannot target ${requestedItem}. Choose grain or vegetable, or use bare work for the best available field task.`,
      };
    }
    const harvestField = readyField(requestedItem);
    if (harvestField) {
      const quantity = (requestedItem === 'grain' ? 4 : 3) + harvestBonus;
      return {
        validation: {
          ok: true as const,
          workKind: 'harvest' as const,
          fieldKey: harvestField.fieldKey,
          cropItem: requestedItem,
          produces: [{ item: requestedItem, quantity }],
          note: `Harvest ${requestedItem} from ${harvestField.fieldKey}.`,
        },
        note: null as string | null,
      };
    }
    if (!fallowField) {
      const feasible = await feasibleFarmerWorkOutputs(ctx, agentDoc);
      return {
        validation: null as WorldValidation | null,
        note: feasible.length > 0
          ? `No fallow field is available to plant ${requestedItem}. Feasible farm work right now: ${feasible.join(', ')}.`
          : `No fallow field is available to plant ${requestedItem}.`,
      };
    }
    if (!inventoryHasAtLeast(agentDoc.inventory, requestedItem, 1)) {
      const inv = parseInventoryRecord(agentDoc.inventory);
      const feasible = await feasibleFarmerWorkOutputs(ctx, agentDoc);
      return {
        validation: null as WorldValidation | null,
        note: feasible.length > 0
          ? `Not enough ${requestedItem}: need 1, have ${inv[requestedItem] ?? 0}. Feasible farm work right now: ${feasible.join(', ')}.`
          : `Not enough ${requestedItem}: need 1, have ${inv[requestedItem] ?? 0}.`,
      };
    }
    return {
      validation: {
        ok: true as const,
        workKind: 'plant' as const,
        fieldKey: fallowField.fieldKey,
        cropItem: requestedItem,
        consumes: [{ item: requestedItem, quantity: 1 }],
        note: `Plant ${requestedItem} in ${fallowField.fieldKey}.`,
      },
      note: null as string | null,
    };
  }

  const anyReadyField = readyField();
  if (anyReadyField && anyReadyField.cropItem) {
    const quantity = (anyReadyField.cropItem === 'grain' ? 4 : 3) + harvestBonus;
    return {
      validation: {
        ok: true as const,
        workKind: 'harvest' as const,
        fieldKey: anyReadyField.fieldKey,
        cropItem: anyReadyField.cropItem,
        produces: [{ item: anyReadyField.cropItem, quantity }],
        note: `Harvest ${anyReadyField.cropItem} from ${anyReadyField.fieldKey}.`,
      },
      note: null as string | null,
    };
  }
  if (growingField) {
    return {
      validation: {
        ok: true as const,
        workKind: 'water' as const,
        fieldKey: growingField.fieldKey,
        note: `Water ${growingField.fieldKey}.`,
      },
      note: null as string | null,
    };
  }
  if (fallowField) {
    for (const crop of FARMER_WORK_CROPS) {
      if (inventoryHasAtLeast(agentDoc.inventory, crop, 1)) {
        return {
          validation: {
            ok: true as const,
            workKind: 'plant' as const,
            fieldKey: fallowField.fieldKey,
            cropItem: crop,
            consumes: [{ item: crop, quantity: 1 }],
            note: `Plant ${crop} in ${fallowField.fieldKey}.`,
          },
          note: null as string | null,
        };
      }
    }
  }

  return {
    validation: null as WorldValidation | null,
    note: 'No valid farm work is available right now. Wait for a field state change or get more seed stock.',
  };
}

async function resolveInnkeeperWork(agentDoc: any, requestedItem?: string | null) {
  if (agentDoc.role !== 'Innkeeper') {
    return { validation: null as WorldValidation | null, note: `${agentDoc.role} cannot use work as a role action.` };
  }
  if (agentDoc.location !== 'bakery') {
    return { validation: null as WorldValidation | null, note: 'Innkeeper work is only available at the bakery right now.' };
  }

  const outputs = requestedItem ? [requestedItem] : [...INNKEEPER_WORK_OUTPUTS];
  for (const output of outputs) {
    if (!INNKEEPER_WORK_OUTPUTS.includes(output as (typeof INNKEEPER_WORK_OUTPUTS)[number])) {
      const feasible = await feasibleInnkeeperWorkOutputs(agentDoc);
      return {
        validation: null as WorldValidation | null,
        note: feasible.length > 0
          ? `Innkeeper work cannot target ${output}. Feasible work right now: ${feasible.join(', ')}.`
          : 'Innkeeper work currently supports flour or bread at the bakery.',
      };
    }
    const recipe = getRecipes('work', output).find((entry) =>
      entry.location === 'bakery' && !formatRequirementShortfall(agentDoc.inventory, entry.consumes),
    );
    if (!recipe) continue;
    const breadBonus = output === 'bread' && hasInventoryItem(agentDoc, 'knife', 1) ? 1 : 0;
    return {
      validation: {
        ok: true as const,
        workKind: output === 'bread' ? 'bake' as const : 'mill' as const,
        consumes: recipe.consumes,
        produces: applyProducedItemBonus(recipe.produces, output, breadBonus),
        note: breadBonus > 0
          ? `${recipe.note} Your knife helps you prep faster and stretch the batch.`
          : recipe.note,
      },
      note: null as string | null,
    };
  }

  const feasible = await feasibleInnkeeperWorkOutputs(agentDoc);
  return {
    validation: null as WorldValidation | null,
    note: feasible.length > 0
      ? `Innkeeper work cannot target ${requestedItem}. Feasible work right now: ${feasible.join(', ')}.`
      : 'No valid bakery work is available right now. Bring grain or flour to the bakery first.',
  };
}

async function resolveHerbalistWork(ctx: any, agentDoc: any, requestedItem?: string | null) {
  if (agentDoc.role !== 'Herbalist') {
    return { validation: null as WorldValidation | null, note: `${agentDoc.role} cannot use work as a role action.` };
  }
  const patches = await getHerbPatchesAtLocation(ctx, agentDoc.location);
  const patch = patches.find((entry: any) => entry.available > 0);
  const medicineRecipe = getRecipe('brew', 'medicine');
  const canBrewMedicine = Boolean(
    medicineRecipe &&
    agentDoc.location === medicineRecipe.location &&
    !formatRequirementShortfall(agentDoc.inventory, medicineRecipe.consumes),
  );

  if (requestedItem) {
    if (!HERBALIST_WORK_OUTPUTS.includes(requestedItem as (typeof HERBALIST_WORK_OUTPUTS)[number])) {
      const feasible = await feasibleHerbalistWorkOutputs(ctx, agentDoc);
      return {
        validation: null as WorldValidation | null,
        note: feasible.length > 0
          ? `Herbalist work cannot target ${requestedItem}. Feasible work right now: ${feasible.join(', ')}.`
          : `Herbalist work cannot target ${requestedItem}. Choose herb or medicine, or use bare work.`,
      };
    }
    if (requestedItem === 'herb') {
      if (!patch) {
        const feasible = await feasibleHerbalistWorkOutputs(ctx, agentDoc);
        return {
          validation: null as WorldValidation | null,
          note: feasible.length > 0
            ? `No gatherable herb is available here right now. Feasible herbal work right now: ${feasible.join(', ')}.`
            : 'No gatherable herb is available here right now.',
        };
      }
      const quantity = Math.min(2, patch.available);
      return {
        validation: {
          ok: true as const,
          workKind: 'gather' as const,
          herbPatchKey: patch.patchKey,
          produces: [{ item: patch.herbItem, quantity }],
          note: `Gather ${quantity} ${patch.herbItem} from ${patch.patchKey}.`,
        },
        note: null as string | null,
      };
    }
    if (!medicineRecipe || agentDoc.location !== medicineRecipe.location) {
      return {
        validation: null as WorldValidation | null,
        note: 'Medicine work is only available at the shrine.',
      };
    }
    const shortfall = formatRequirementShortfall(agentDoc.inventory, medicineRecipe.consumes);
    if (shortfall) {
      const feasible = await feasibleHerbalistWorkOutputs(ctx, agentDoc);
      return {
        validation: null as WorldValidation | null,
        note: feasible.length > 0
          ? `${shortfall} Feasible herbal work right now: ${feasible.join(', ')}.`
          : `${shortfall} No herbal output is currently feasible with your stock.`,
      };
    }
    return {
      validation: {
        ok: true as const,
        workKind: 'brew' as const,
        consumes: medicineRecipe.consumes,
        produces: medicineRecipe.produces,
        note: medicineRecipe.note,
      },
      note: null as string | null,
    };
  }

  if (patch) {
    const quantity = Math.min(2, patch.available);
    return {
      validation: {
        ok: true as const,
        workKind: 'gather' as const,
        herbPatchKey: patch.patchKey,
        produces: [{ item: patch.herbItem, quantity }],
        note: `Gather ${quantity} ${patch.herbItem} from ${patch.patchKey}.`,
      },
      note: null as string | null,
    };
  }
  if (canBrewMedicine && medicineRecipe) {
    return {
      validation: {
        ok: true as const,
        workKind: 'brew' as const,
        consumes: medicineRecipe.consumes,
        produces: medicineRecipe.produces,
        note: medicineRecipe.note,
      },
      note: null as string | null,
    };
  }

  return {
    validation: null as WorldValidation | null,
    note: 'No valid herbal work is available right now. Move to a herb patch or the shrine, or gather more herb first.',
  };
}

const LIVE_CHAT_SCENE_ACTIONS = new Set([
  'chat',
  'leave_chat',
]);

const CHAT_COMMERCE_INTENTS = new Set([
  'buy',
  'sell',
  'trade',
  'give',
  'pay',
  'accept_transaction',
  'reject_transaction',
]) as Set<string>;

const CHAT_SOCIAL_INTENTS = new Set([
  'lie',
  'threaten',
]) as Set<string>;

const SAY_SOCIAL_INTENTS = new Set([
  'gossip',
]) as Set<string>;

const SPEECH_INTENTS = new Set([
  ...CHAT_COMMERCE_INTENTS,
  ...CHAT_SOCIAL_INTENTS,
  ...SAY_SOCIAL_INTENTS,
]) as Set<string>;

const CHAT_SPEECH_INTENTS = new Set([
  ...CHAT_COMMERCE_INTENTS,
  ...CHAT_SOCIAL_INTENTS,
]) as Set<string>;

const ROLE_GATED_ACTIONS = new Set(
  Object.values(ROLE_ECONOMIC_ACTIONS).flatMap((actions) => actions),
);

function sceneOnlyActionNote(intent: string) {
  return `chat intent "${intent}" is only valid inside a live chat with the other agent. Start or continue a chat first.`;
}

function normaliseIntent(value: unknown): string | null | undefined {
  const normalized = normaliseScalarString(value);
  if (normalized === undefined || normalized === null) return normalized;
  const lowered = normalized.toLowerCase();
  return SPEECH_INTENTS.has(lowered) ? lowered : normalized;
}

function getChatIntent(parsed: RocklawAction): string | null {
  const intent = typeof parsed.intent === 'string' ? parsed.intent.trim().toLowerCase() : '';
  return CHAT_SPEECH_INTENTS.has(intent) ? intent : null;
}

function getChatCommerceIntent(parsed: RocklawAction): string | null {
  const intent = typeof parsed.intent === 'string' ? parsed.intent.trim().toLowerCase() : '';
  return CHAT_COMMERCE_INTENTS.has(intent) ? intent : null;
}

function getSpeechIntent(parsed: RocklawAction): string | null {
  const intent = typeof parsed.intent === 'string' ? parsed.intent.trim().toLowerCase() : '';
  return SPEECH_INTENTS.has(intent) ? intent : null;
}

function formatSpeechIntentNote(intent: string | null | undefined): string {
  if (!intent) return '';
  return ` intent:${intent}`;
}

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
    name = canonicalizeItemId(name) ?? name;
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
        value: canonicalizeItemId(itemName) ?? itemName,
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
  const action = parsed.action;
  const target = normaliseScalarString(parsed.target);
  const location = normaliseScalarString(parsed.location);
  const item = canonicalizeItemId(normaliseScalarString(parsed.item) ?? undefined);
  const intent = normaliseIntent(parsed.intent);
  const offerRef = normaliseScalarString(parsed.offer_ref);
  const text = typeof parsed.text === 'string' ? parsed.text.trim() : undefined;
  const topic = typeof parsed.topic === 'string' ? parsed.topic.trim() : undefined;
  const thought = typeof parsed.thought === 'string' ? parsed.thought.trim() : undefined;
  const journal = typeof parsed.journal === 'string' ? parsed.journal.trim() : undefined;
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
    intent,
    offer_ref: offerRef,
    topic,
    thought,
    journal,
    item,
    quantity,
    amount,
    duration_ticks: typeof parsed.duration_ticks === 'number' && parsed.duration_ticks > 0
      ? Math.max(1, parsed.duration_ticks)
      : undefined,
    consumes,
    produces,
  };

  if (action === 'move' && !normalized.location && target) {
    normalized.location = target;
  }
  if ((action === 'chat' || action === 'say' || action === 'message' || action === 'talk' || action === 'write' || action === 'pray' || action === 'eavesdrop') && !normalized.text && parsed.message) {
    normalized.text = parsed.message;
  }
  if ((action === 'work' || action === 'craft' || action === 'repair' || action === 'smelt' || action === 'eat' || action === 'use') && !normalized.item && target) {
    normalized.item = target;
  }
  if ((action === 'eat' || action === 'use' || action === 'work' || action === 'craft' || action === 'smelt') && normalized.quantity == null && normalized.item) {
    normalized.quantity = 1;
  }
  if (action === 'chat' && (intent === 'buy' || intent === 'sell' || intent === 'give') && normalized.quantity == null && normalized.item) {
    normalized.quantity = 1;
  }
  if (action === 'chat' && intent === 'pay' && normalized.amount == null && parsed.consumes?.length) {
    const consumed = parseItemList(parsed.consumes);
    if (typeof consumed.coin === 'number') normalized.amount = consumed.coin;
  }
  if (action === 'chat' && intent === 'trade') {
    normalized.offer = Array.isArray(parsed.offer) ? canonicalizeItemEntries(normaliseEntityList(parsed.offer) ?? []) : undefined;
    normalized.request = Array.isArray(parsed.request) ? canonicalizeItemEntries(normaliseEntityList(parsed.request) ?? []) : undefined;
  }

  const hasInventoryDelta = normalized.consumes.length > 0 || normalized.produces.length > 0;
  if (!hasInventoryDelta) {
    const effectiveAction = action === 'chat' ? intent : action;
    switch (effectiveAction) {
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
      case 'use':
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
  const inv = canonicalizeItemQuantities(JSON.parse(inventoryJson) as Record<string, number>);
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

function parseInventoryRecord(inventoryJson: string): Record<string, number> {
  return canonicalizeItemQuantities(JSON.parse(inventoryJson) as Record<string, number>);
}

function inventoryHasAtLeast(inventoryJson: string, item: string, required: number): boolean {
  const canonicalItem = canonicalizeItemId(item) ?? item;
  const inv = canonicalizeItemQuantities(JSON.parse(inventoryJson) as Record<string, number>);
  return (inv[canonicalItem] ?? 0) >= required;
}

function formatInventoryShortfall(inventoryJson: string, consumes: unknown[]): string | null {
  const inv = canonicalizeItemQuantities(JSON.parse(inventoryJson) as Record<string, number>);
  const needed = parseItemList(consumes);

  for (const [item, qty] of Object.entries(needed)) {
    if (item === 'coin') continue;
    const have = inv[item] ?? 0;
    if (have < qty) {
      return `Not enough ${formatItemLabel(item, qty)}: need ${qty}, have ${have}.`;
    }
  }

  return null;
}

function inventoryHasItems(inventoryJson: string, required: Array<{ item: string; quantity: number }>): boolean {
  const inv = canonicalizeItemQuantities(JSON.parse(inventoryJson) as Record<string, number>);
  return required.every((entry) => (inv[canonicalizeItemId(entry.item) ?? entry.item] ?? 0) >= entry.quantity);
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

async function getPlaceByName(ctx: any, rawPlace: string | null | undefined) {
  if (!rawPlace) return null;
  return ctx.db
    .query('rl_locations')
    .withIndex('name', (q: any) => q.eq('name', rawPlace))
    .unique();
}

async function getPlaceStock(ctx: any, placeName: string, item: string) {
  return ctx.db
    .query('rl_place_stocks')
    .withIndex('place_item', (q: any) => q.eq('placeName', placeName).eq('item', item))
    .unique();
}

async function getPlaceMarket(ctx: any, placeName: string) {
  return ctx.db
    .query('rl_place_markets')
    .withIndex('placeName', (q: any) => q.eq('placeName', placeName))
    .unique();
}

async function getGlobalItemPrice(ctx: any, item: string) {
  const row = await ctx.db
    .query('rl_market_prices')
    .withIndex('item', (q: any) => q.eq('item', item))
    .unique();
  return row?.price ?? null;
}

async function ensurePlaceCounterparty(
  ctx: any,
  actorLocation: string,
  rawPlace: string | null | undefined,
  item: string | null | undefined,
) {
  if (!rawPlace) return { ok: false as const, note: 'This action requires a place target.' };
  if (!item) return { ok: false as const, note: 'This action requires an item.' };
  const place = await getPlaceByName(ctx, rawPlace);
  if (!place) return { ok: false as const, note: `Unknown place: ${rawPlace}.` };
  if (place.name !== actorLocation) {
    return { ok: false as const, note: `You must be at ${place.name} to act on that place.` };
  }
  const stock = await getPlaceStock(ctx, place.name, item);
  if (!stock) {
    return { ok: false as const, note: `${place.name} does not trade ${item}.` };
  }
  const market = await getPlaceMarket(ctx, place.name);
  if (!market) {
    return { ok: false as const, note: `${place.name} has no active market state.` };
  }
  const globalPrice = await getGlobalItemPrice(ctx, item);
  const quote = derivePlaceQuote(stock, market, globalPrice);
  return { ok: true as const, place, stock, market, quote };
}

async function targetAgentAtSameLocation(ctx: any, actorLocation: string, targetName: string) {
  const trimmedTarget = targetName.trim().toLowerCase();
  if (trimmedTarget === 'market' || trimmedTarget === 'inn' || trimmedTarget === 'forge' || trimmedTarget === 'farm' || trimmedTarget === 'shrine' || trimmedTarget === 'square' || trimmedTarget === 'gate' || trimmedTarget === 'mine' || trimmedTarget === 'bakery' || trimmedTarget === 'warehouse') {
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

function isProgressingLiveChatTurn(parsed: RocklawAction) {
  if (parsed.action === 'leave_chat') return true;
  if (parsed.action !== 'chat') return false;
  if (getChatIntent(parsed)) return true;
  const text = (parsed.text ?? parsed.message ?? '').trim().toLowerCase();
  if (!text) return false;
  if (text.includes('?')) return true;
  return [
    'offer',
    'price',
    'coin',
    'buy',
    'sell',
    'trade',
    'deal',
    'terms',
    'accept',
    'decline',
    'agree',
    'how much',
  ].some((needle) => text.includes(needle));
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
  const partner = getScenePartner(scene, agentName);
  await ctx.db.patch(scene._id, {
    status: 'closed',
    closeReason: reason ?? `${agentName} left the chat.`,
    closedTick: tick,
    closedDay: day,
    lastActiveTick: tick,
    lastActiveDay: day,
  });

  const sentPending = await ctx.db
    .query('rl_transactions')
    .withIndex('sender_status', (q: any) => q.eq('fromAgent', agentName).eq('status', 'pending'))
    .collect();
  const receivedPending = await ctx.db
    .query('rl_transactions')
    .withIndex('recipient_status', (q: any) => q.eq('toAgent', agentName).eq('status', 'pending'))
    .collect();
  const sceneTransactions = [...sentPending, ...receivedPending]
    .filter((txn) =>
      ((txn.fromAgent === agentName && txn.toAgent === partner)
        || (txn.fromAgent === partner && txn.toAgent === agentName))
      && txn.status === 'pending',
    );
  for (const txn of sceneTransactions) {
    const note = `In-person offer ended when the conversation with ${partner} closed.`;
    await ctx.db.patch(txn._id, {
      status: 'expired',
      resolvedTick: tick,
      resolvedDay: day,
      outcomeNote: note,
    });
    await setInteractionOutcomeByTransactionId(ctx, txn.txnId, {
      status: 'expired',
      resolvedTick: tick,
      resolvedDay: day,
      outcomeNote: note,
    });
  }

  return {
    scene,
    partner,
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
    boundSceneId?: string;
  },
) {
  const threadKey = createChatThreadKey(args.fromAgent, args.toAgent);
  let sceneId: string | undefined;
  let sceneOrder: number | undefined;
  if (args.deliveryMode === 'live') {
    if (args.boundSceneId) {
      const boundScene = await ctx.db
        .query('rl_chat_scenes')
        .withIndex('sceneId', (q: any) => q.eq('sceneId', args.boundSceneId!))
        .unique();
      if (boundScene) {
        sceneId = boundScene.sceneId;
        sceneOrder = (boundScene.lastMessageOrder ?? 0) + 1;
        await ctx.db.patch(boundScene._id, { lastMessageOrder: sceneOrder });
      }
    } else {
      const liveScene = await getLiveChatSceneBetweenAgents(ctx, args.fromAgent, args.toAgent);
      if (liveScene) {
        sceneId = liveScene.sceneId;
        sceneOrder = (liveScene.lastMessageOrder ?? 0) + 1;
        await ctx.db.patch(liveScene._id, { lastMessageOrder: sceneOrder });
      }
    }
  }
  await ctx.db.insert('rl_chat_messages', {
    threadKey,
    sceneId,
    sceneOrder,
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

async function getLiveChatSceneBetweenAgents(ctx: any, agentA: string, agentB: string) {
  const viaA = await ctx.db
    .query('rl_chat_scenes')
    .withIndex('agentA_status', (q: any) => q.eq('agentA', agentA).eq('status', 'live'))
    .collect();
  const direct = viaA.find((scene: any) => scene.agentB === agentB);
  if (direct) return direct;

  const viaB = await ctx.db
    .query('rl_chat_scenes')
    .withIndex('agentA_status', (q: any) => q.eq('agentA', agentB).eq('status', 'live'))
    .collect();
  return viaB.find((scene: any) => scene.agentB === agentA) ?? null;
}

async function getMostRecentClosedSceneBetweenAgents(ctx: any, agentA: string, agentB: string) {
  const [closedViaA, closedViaB] = await Promise.all([
    ctx.db
      .query('rl_chat_scenes')
      .withIndex('agentA_status', (q: any) => q.eq('agentA', agentA).eq('status', 'closed'))
      .collect(),
    ctx.db
      .query('rl_chat_scenes')
      .withIndex('agentA_status', (q: any) => q.eq('agentA', agentB).eq('status', 'closed'))
      .collect(),
  ]);
  const matching = [...closedViaA, ...closedViaB]
    .filter((scene: any) =>
      (scene.agentA === agentA && scene.agentB === agentB)
      || (scene.agentA === agentB && scene.agentB === agentA),
    )
    .sort((a: any, b: any) =>
      (b.closedDay ?? -1) - (a.closedDay ?? -1)
      || (b.closedTick ?? -1) - (a.closedTick ?? -1),
    );
  return matching[0] ?? null;
}

function compareChatMessageOrder(a: any, b: any) {
  return (
    a.sentDay - b.sentDay
    || a.sentTick - b.sentTick
    || (a.sceneOrder ?? 0) - (b.sceneOrder ?? 0)
  );
}

function describeSuspiciousDealLikeChat(text: string | undefined) {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  const hasDealVerb =
    /\b(i can offer|i can sell|i can buy|i can trade|i'll take|i will take|deal|for \d+|\bfor\b)/.test(lower);
  const hasEconomicObject =
    /\b(coin|coins|grain|bread|ale|coal|iron ore|iron_ore|horseshoe|medicine|tool|hammer|axe|knife|herb|meal)\b/.test(lower);
  const hasQuantity = /\b\d+\b/.test(lower) || /\b(one|two|three|four|five|six|seven|eight|nine|ten|twenty)\b/.test(lower);
  if (hasDealVerb && hasEconomicObject && hasQuantity) {
    return 'Plain chat sounded like a concrete deal, but no structured economic intent was attached. No binding offer was created.';
  }
  return null;
}

async function createSceneSystemMessage(
  ctx: any,
  agentA: string,
  agentB: string,
  text: string,
  tick: number,
  day: number,
) {
  const threadKey = createChatThreadKey(agentA, agentB);
  let sceneId: string | undefined;
  let sceneOrder: number | undefined;
  const liveScene = await getLiveChatSceneBetweenAgents(ctx, agentA, agentB);
  if (liveScene) {
    sceneId = liveScene.sceneId;
    sceneOrder = (liveScene.lastMessageOrder ?? 0) + 1;
    await ctx.db.patch(liveScene._id, { lastMessageOrder: sceneOrder });
  }
  await ctx.db.insert('rl_chat_messages', {
    threadKey,
    sceneId,
    sceneOrder,
    fromAgent: '[system]',
    toAgent: agentB,
    text,
    deliveryMode: 'live',
    status: 'unread',
    sentTick: tick,
    sentDay: day,
  });
}

function buildSceneVisibleActionText(parsed: RocklawAction, partner: string): string {
  const explicit = (parsed.text ?? parsed.message ?? '').trim();
  if (explicit) return explicit;
  switch (parsed.action === 'chat' ? getChatIntent(parsed) : parsed.action) {
    case 'buy':
      return `I want to buy ${formatItemQuantity(parsed.item ?? 'item', parsed.quantity ?? 1)} from you for ${parsed.amount ?? 0} coin.`;
    case 'sell':
      return `I can sell you ${formatItemQuantity(parsed.item ?? 'item', parsed.quantity ?? 1)} for ${parsed.amount ?? 0} coin.`;
    case 'trade':
      return `I want to propose a trade with you.`;
    case 'give':
      return `I am giving you ${formatItemQuantity(parsed.item ?? 'item', parsed.quantity ?? 1)}.`;
    case 'pay':
      return `I am paying you ${parsed.amount ?? 0} coin.`;
    case 'accept_transaction':
      return `I accept your offer, ${partner}.`;
    case 'reject_transaction':
      return `I must decline your offer, ${partner}.`;
    default:
      return '';
  }
}

async function appendLiveSceneActionMessage(
  ctx: any,
  agentDoc: any,
  parsed: RocklawAction,
  tick: number,
  day: number,
  partnerOverride?: string,
) {
  const scene = await getLiveChatSceneForAgent(ctx, agentDoc.name);
  if (!scene) return;
  const partner = partnerOverride ?? getScenePartner(scene, agentDoc.name);
  const text = buildSceneVisibleActionText(parsed, partner);
  if (!text) return;
  await markUnreadChatFromContactRead(ctx, agentDoc.name, partner, tick, day);
  await createChatMessage(ctx, {
    fromAgent: agentDoc.name,
    toAgent: partner,
    text,
    deliveryMode: 'live',
    tick,
    day,
  });
}

async function advanceLiveSceneTurn(
  ctx: any,
  agentName: string,
  tick: number,
  day: number,
  parsed?: RocklawAction,
) {
  const scene = await getLiveChatSceneForAgent(ctx, agentName);
  if (!scene) return;
  const nextStallTurns = parsed
    ? (isProgressingLiveChatTurn(parsed) ? 0 : (scene.stallTurns ?? 0) + 1)
    : scene.stallTurns;
  await ctx.db.patch(scene._id, {
    nextSpeaker: getScenePartner(scene, agentName),
    lastSpeaker: agentName,
    lastActiveTick: tick,
    lastActiveDay: day,
    stallTurns: nextStallTurns,
  });
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
  const roleActions = new Set(ROLE_ECONOMIC_ACTIONS[agentDoc.role] ?? []);

  if (activeChatScene) {
    const partner = getScenePartner(activeChatScene, agentDoc.name);
    if (parsed.action === 'leave_chat') {
      return { ok: true };
    }
    if (!LIVE_CHAT_SCENE_ACTIONS.has(parsed.action)) {
      return {
        ok: false,
        note: `You are currently in a live chat with ${partner}. Only scene actions with that person are allowed until you leave the chat.`,
      };
    }
    if (parsed.action === 'chat') {
      const chatIntent = getChatCommerceIntent(parsed);
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
      if (chatIntent === 'buy' || chatIntent === 'sell' || chatIntent === 'give') {
        if (!parsed.item) return { ok: false, note: `chat intent "${chatIntent}" requires an item.` };
        if (!parsed.quantity || parsed.quantity < 1) return { ok: false, note: `chat intent "${chatIntent}" requires a positive quantity.` };
      }
      if (chatIntent === 'buy' || chatIntent === 'sell' || chatIntent === 'pay') {
        if (typeof parsed.amount !== 'number' || parsed.amount <= 0) {
          return { ok: false, note: `chat intent "${chatIntent}" requires a positive amount.` };
        }
      }
      if (chatIntent === 'trade') {
        if (!Array.isArray(parsed.offer) || parsed.offer.length === 0) {
          return { ok: false, note: 'chat intent "trade" requires a non-empty offer.' };
        }
        if (!Array.isArray(parsed.request) || parsed.request.length === 0) {
          return { ok: false, note: 'chat intent "trade" requires a non-empty request.' };
        }
      }
      if ((chatIntent === 'accept_transaction' || chatIntent === 'reject_transaction') && !parsed.offer_ref) {
        return { ok: false, note: `chat intent "${chatIntent}" requires offer_ref.` };
      }
      return { ok: true };
    }
    if (activeChatScene.nextSpeaker !== agentDoc.name) {
      return {
        ok: false,
        note: `It is ${partner}'s turn in your live chat. Wait for their reply or leave_chat.`,
      };
    }
  }

  if (parsed.action === 'leave_chat') {
    // Allow a trailing goodbye as a no-op if the other person already closed the scene.
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

  if (ROLE_GATED_ACTIONS.has(parsed.action) && !roleActions.has(parsed.action)) {
    if (agentDoc.role === 'Blacksmith' && (parsed.action === 'craft' || parsed.action === 'smelt')) {
      return {
        ok: false,
        note: 'Blacksmith production now uses work. Choose work with an output item from TURN.md instead.',
      };
    }
    if (agentDoc.role === 'Farmer' && ['check_field', 'plant', 'water', 'harvest'].includes(parsed.action)) {
      return {
        ok: false,
        note: 'Farmer production now uses work. Use bare work for the best field task, or work with grain or vegetable when you need a specific crop.',
      };
    }
    if (agentDoc.role === 'Herbalist' && ['gather', 'brew'].includes(parsed.action)) {
      return {
        ok: false,
        note: 'Herbalist production now uses work. Use bare work for the best herbal task, or work with herb or medicine when you need a specific output.',
      };
    }
    return {
      ok: false,
      note: `${agentDoc.role} cannot use ${parsed.action} as a role action. Choose another valid action from TURN.md.`,
    };
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
      const chatIntent = getChatCommerceIntent(parsed);
      const speechIntent = getSpeechIntent(parsed);
      if (!parsed.target) {
        return { ok: false, note: 'chat requires a target agent. Use a known person from TURN.md. Chats are one-to-one only.' };
      }
      if (parsed.target === agentDoc.name) return { ok: false, note: 'chat requires another agent, not yourself.' };
      const targetAgent = await getAgentByName(ctx, parsed.target);
      if (!targetAgent) return { ok: false, note: `Target agent not found: ${parsed.target}.` };
      const knownAlready = await hasKnownContact(ctx, agentDoc.name, parsed.target);
      const visibleNow = targetAgent.location === agentDoc.location;
      const targetActivePartners = await getActiveTalkPartnersForAgent(ctx, parsed.target);
      const targetAlreadyChattingWithOther = targetActivePartners.some((partner: string) => partner !== agentDoc.name);
      if (!knownAlready && !visibleNow) {
        return { ok: false, note: `You can only chat known contacts from TURN.md. You have not met ${parsed.target} yet.` };
      }
      if (!(parsed.text ?? parsed.message)) {
        return { ok: false, note: 'chat requires text.' };
      }
      if (speechIntent === 'gossip') {
        return { ok: false, note: 'gossip is public speech. Use say with intent:"gossip" instead of chat.' };
      }
      if (chatIntent && !visibleNow) {
        return { ok: false, note: sceneOnlyActionNote(chatIntent) };
      }
      if (chatIntent && targetAlreadyChattingWithOther) {
        return { ok: false, note: `chat intent "${chatIntent}" is only valid when ${parsed.target} is here and available for a live chat right now.` };
      }
      return { ok: true };
    }
    case 'say':
      if (parsed.target) return { ok: false, note: 'say is local speech and does not take a target. Use chat for one-to-one communication.' };
      if (!(parsed.text ?? parsed.message)) return { ok: false, note: 'say requires text.' };
      if (parsed.intent === 'lie' || parsed.intent === 'threaten') {
        return { ok: false, note: `${parsed.intent} is direct pressure or concealment. Use chat with that person instead of say.` };
      }
      if (parsed.intent && parsed.intent !== 'gossip') {
        return { ok: false, note: `say only supports intent:"gossip" as a social intent.` };
      }
      return { ok: true };
    case 'pay':
    case 'buy':
    case 'sell':
    case 'give':
    case 'trade':
      return { ok: false, note: `Use chat with intent:"${parsed.action}" inside a live chat scene instead of the top-level ${parsed.action} action.` };
    case 'buy_place': {
      const quantity = parsed.quantity ?? 1;
      if (!parsed.item) return { ok: false, note: 'buy_place requires an item.' };
      if (quantity < 1) return { ok: false, note: 'buy_place requires a positive quantity.' };
      const targetPlace = parsed.target ?? parsed.location;
      const resolved = await ensurePlaceCounterparty(ctx, agentDoc.location, targetPlace, parsed.item);
      if (!resolved.ok) return resolved;
      if (!resolved.stock.sells) return { ok: false, note: `${resolved.place.name} is not selling ${parsed.item} right now.` };
      if (!resolved.quote.canCurrentlySell || !resolved.quote.askPrice) {
        return { ok: false, note: `${resolved.place.name} is out of ${parsed.item} right now.` };
      }
      if (resolved.stock.quantity < quantity) {
        return { ok: false, note: `${resolved.place.name} only has ${resolved.stock.quantity} ${parsed.item}.` };
      }
      const settledAmount = resolved.quote.askPrice * quantity;
      if (settledAmount <= 0) return { ok: false, note: `${resolved.place.name} has no posted selling price for ${parsed.item}.` };
      if (agentDoc.coin < settledAmount) {
        return { ok: false, note: `Not enough coin: need ${settledAmount}c, have ${agentDoc.coin}c.` };
      }
      return {
        ok: true,
        resolvedTarget: resolved.place.name,
        placeStockId: resolved.stock._id,
        placeMarketId: resolved.market._id,
        settledAmount,
        settledItem: parsed.item,
        stockDelta: -quantity,
        placeTreasuryDelta: settledAmount,
        consumes: [{ item: 'coin', quantity: settledAmount }],
        produces: [{ item: parsed.item, quantity }],
        note: `Buy ${quantity} ${parsed.item} from ${resolved.place.name} for ${settledAmount} coin.`,
      };
    }
    case 'sell_place': {
      const quantity = parsed.quantity ?? 1;
      if (!parsed.item) return { ok: false, note: 'sell_place requires an item.' };
      if (quantity < 1) return { ok: false, note: 'sell_place requires a positive quantity.' };
      if (!inventoryHasAtLeast(agentDoc.inventory, parsed.item, quantity)) {
        const inv = parseInventoryRecord(agentDoc.inventory);
        return { ok: false, note: `Not enough ${parsed.item}: need ${quantity}, have ${inv[parsed.item] ?? 0}.` };
      }
      const targetPlace = parsed.target ?? parsed.location;
      const resolved = await ensurePlaceCounterparty(ctx, agentDoc.location, targetPlace, parsed.item);
      if (!resolved.ok) return resolved;
      if (!resolved.stock.buys) return { ok: false, note: `${resolved.place.name} is not buying ${parsed.item} right now.` };
      if (typeof resolved.stock.capacity === 'number' && resolved.stock.quantity + quantity > resolved.stock.capacity) {
        return { ok: false, note: `${resolved.place.name} cannot take that much ${parsed.item} right now.` };
      }
      if (!resolved.quote.canCurrentlyBuy || !resolved.quote.bidPrice) {
        return { ok: false, note: `${resolved.place.name} cannot currently pay for more ${parsed.item}.` };
      }
      if (resolved.quote.maxAffordableQuantity < quantity) {
        return { ok: false, note: `${resolved.place.name} can only afford ${resolved.quote.maxAffordableQuantity} ${parsed.item} right now.` };
      }
      const settledAmount = resolved.quote.bidPrice * quantity;
      if (settledAmount <= 0) return { ok: false, note: `${resolved.place.name} has no posted buying price for ${parsed.item}.` };
      return {
        ok: true,
        resolvedTarget: resolved.place.name,
        placeStockId: resolved.stock._id,
        placeMarketId: resolved.market._id,
        settledAmount,
        settledItem: parsed.item,
        stockDelta: quantity,
        placeTreasuryDelta: -settledAmount,
        consumes: [{ item: parsed.item, quantity }],
        produces: [{ item: 'coin', quantity: settledAmount }],
        note: `Sell ${quantity} ${parsed.item} to ${resolved.place.name} for ${settledAmount} coin.`,
      };
    }
    case 'deliver_place': {
      const quantity = parsed.quantity ?? 1;
      if (!parsed.item) return { ok: false, note: 'deliver_place requires an item.' };
      if (quantity < 1) return { ok: false, note: 'deliver_place requires a positive quantity.' };
      if (!inventoryHasAtLeast(agentDoc.inventory, parsed.item, quantity)) {
        const inv = parseInventoryRecord(agentDoc.inventory);
        return { ok: false, note: `Not enough ${parsed.item}: need ${quantity}, have ${inv[parsed.item] ?? 0}.` };
      }
      const targetPlace = parsed.target ?? parsed.location;
      const resolved = await ensurePlaceCounterparty(ctx, agentDoc.location, targetPlace, parsed.item);
      if (!resolved.ok) return resolved;
      if (typeof resolved.stock.capacity === 'number' && resolved.stock.quantity + quantity > resolved.stock.capacity) {
        return { ok: false, note: `${resolved.place.name} cannot store that much ${parsed.item} right now.` };
      }
      return {
        ok: true,
        resolvedTarget: resolved.place.name,
        placeStockId: resolved.stock._id,
        placeMarketId: resolved.market._id,
        settledItem: parsed.item,
        stockDelta: quantity,
        consumes: [{ item: parsed.item, quantity }],
        note: `Deliver ${quantity} ${parsed.item} into ${resolved.place.name}.`,
      };
    }
    case 'work':
    case 'craft':
    case 'smelt':
    case 'brew': {
      if (parsed.action === 'work') {
        let workValidation: WorldValidation | null = null;
        let workNote: string | null = null;
        if (agentDoc.role === 'Blacksmith') {
          const resolved = resolveBlacksmithWorkRecipe(agentDoc, parsed.item ?? parsed.target);
          workNote = resolved.note;
          workValidation = resolved.recipe
            ? {
                ok: true,
                workKind: 'blacksmith',
                consumes: resolved.recipe.consumes,
                produces: applyProducedItemBonus(
                  resolved.recipe.produces,
                  resolved.recipe.output,
                  resolved.recipe.output !== 'horseshoe' && hasInventoryItem(agentDoc, 'horseshoe', 1) ? 1 : 0,
                ),
                note: resolved.recipe.output !== 'horseshoe' && hasInventoryItem(agentDoc, 'horseshoe', 1)
                  ? `${resolved.recipe.note} Your spare horseshoe helps you keep the forge aligned.`
                  : resolved.recipe.note,
              }
            : null;
        } else if (agentDoc.role === 'Farmer') {
          const resolved = await resolveFarmerWork(ctx, agentDoc, parsed.item ?? parsed.target);
          workValidation = resolved.validation;
          workNote = resolved.note;
        } else if (agentDoc.role === 'Herbalist') {
          const resolved = await resolveHerbalistWork(ctx, agentDoc, parsed.item ?? parsed.target);
          workValidation = resolved.validation;
          workNote = resolved.note;
        } else if (agentDoc.role === 'Innkeeper') {
          const resolved = await resolveInnkeeperWork(agentDoc, parsed.item ?? parsed.target);
          workValidation = resolved.validation;
          workNote = resolved.note;
        } else {
          workNote = `${agentDoc.role} cannot use work as a role action.`;
        }
        return workValidation ?? { ok: false, note: workNote ?? 'work requires a known output item.' };
      }

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
      if (shortfall) {
        return { ok: false, note: shortfall };
      }
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
      if (!['grain', 'vegetable'].includes(cropItem)) {
        return { ok: false, note: 'plant currently supports grain or vegetable.' };
      }
      if (!inventoryHasAtLeast(agentDoc.inventory, cropItem, 1)) {
        const inv = parseInventoryRecord(agentDoc.inventory);
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
        return { ok: false, note: 'No gatherable herb is available here right now.' };
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
        const inv = parseInventoryRecord(agentDoc.inventory);
        return { ok: false, note: `Not enough ${parsed.item}: need 1, have ${inv[parsed.item] ?? 0}.` };
      }
      return { ok: true };
    case 'accept_transaction':
    case 'reject_transaction':
      return { ok: false, note: `Use chat with intent:"${parsed.action}" and offer_ref inside a live chat scene instead of the top-level ${parsed.action} action.` };
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
      if (!parsed.journal || parsed.journal.trim().length === 0) {
        return { ok: false, note: 'sleep requires a short `journal` paragraph summarising the day.' };
      }
      return ((timeOfDay !== null && isSleepPeriod(timeOfDay)) || agentDoc.energy < 20)
        ? { ok: true }
        : { ok: false, note: 'sleep is only appropriate in the evening, at night, or when you are critically exhausted.' };
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
        const inv = parseInventoryRecord(agentDoc.inventory);
        if (parsed.item === 'meal') {
          return {
            ok: false,
            note: `Not enough meal: need ${parsed.quantity ?? 1}, have ${inv[parsed.item] ?? 0}. Accept or buy one first.`,
          };
        }
        return { ok: false, note: `Not enough ${parsed.item}: need ${parsed.quantity ?? 1}, have ${inv[parsed.item] ?? 0}.` };
      }
      return { ok: true };
    case 'use':
      if (!parsed.item) return { ok: false, note: 'use requires an item.' };
      if (!isUsable(parsed.item)) return { ok: false, note: `${parsed.item} cannot be used directly.` };
      if (!inventoryHasAtLeast(agentDoc.inventory, parsed.item, parsed.quantity ?? 1)) {
        const inv = parseInventoryRecord(agentDoc.inventory);
        return { ok: false, note: `Not enough ${parsed.item}: need ${parsed.quantity ?? 1}, have ${inv[parsed.item] ?? 0}.` };
      }
      return { ok: true };
    default:
      return { ok: true };
  }
}

async function validateChatIntentSideEffect(
  ctx: any,
  agentDoc: any,
  parsed: RocklawAction,
  intent: string,
): Promise<WorldValidation> {
  const scene = await getLiveChatSceneForAgent(ctx, agentDoc.name);
  if (!scene) return { ok: false, note: sceneOnlyActionNote(intent) };
  const partner = getScenePartner(scene, agentDoc.name);
  if (parsed.target !== partner) {
    return { ok: false, note: `You are currently in a live chat with ${partner}. Direct commerce actions must target that same person until you leave the scene.` };
  }

  if (intent === 'accept_transaction' || intent === 'reject_transaction') {
    if (!parsed.offer_ref) return { ok: false, note: `chat intent "${intent}" requires offer_ref.` };
    if (isSceneOpeningOfferRef(parsed.offer_ref)) {
      const openingOffer = await getSceneOpeningOfferForRecipient(ctx, scene, agentDoc);
      if (!openingOffer) {
        return { ok: false, note: `Unknown pending offer: ${parsed.offer_ref}.` };
      }
      const proposer = await ctx.db
        .query('rl_agents')
        .withIndex('name', (q: any) => q.eq('name', openingOffer.proposerName))
        .unique();
      if (!proposer) return { ok: false, note: 'The other party no longer exists.' };
      if (proposer.location !== agentDoc.location) {
        return { ok: false, note: `${proposer.name} is no longer here. In-person offers can only be answered while the local scene is still live.` };
      }
      return { ok: true };
    }
    const txn = await resolvePendingTransactionReference(ctx, agentDoc.name, parsed.offer_ref);
    if (!txn) {
      const referencedTxn = await findTransactionByTargetReference(ctx, parsed.offer_ref);
      if (referencedTxn?.fromAgent === agentDoc.name) {
        return { ok: false, note: 'You cannot accept or reject your own offer. Wait for the other person or make a new offer.' };
      }
      if (referencedTxn?.status && referencedTxn.status !== 'pending') {
        return { ok: false, note: `That offer is no longer pending (${referencedTxn.status}).` };
      }
      return { ok: false, note: `Unknown pending offer: ${parsed.offer_ref}.` };
    }
    const proposer = await ctx.db
      .query('rl_agents')
      .withIndex('name', (q: any) => q.eq('name', txn.fromAgent))
      .unique();
    if (!proposer) return { ok: false, note: 'The other party no longer exists.' };
    if (proposer.name !== partner) {
      return { ok: false, note: `You can only respond to offers from ${partner} while this live chat is active.` };
    }
    if (proposer.location !== agentDoc.location) {
      return { ok: false, note: `${proposer.name} is no longer here. In-person offers can only be answered while the local scene is still live.` };
    }
    return { ok: true };
  }

  const targetCheck = await targetAgentAtSameLocation(ctx, agentDoc.location, partner);
  if (!targetCheck.ok) return { ok: false, note: targetCheck.note ?? `${partner} is not available here.` };

  if ((intent === 'buy' || intent === 'sell' || intent === 'give') && !parsed.item) {
    return { ok: false, note: `${intent} requires an item.` };
  }
  if ((intent === 'buy' || intent === 'sell' || intent === 'give') && (!parsed.quantity || parsed.quantity < 1)) {
    return { ok: false, note: `${intent} requires a positive quantity.` };
  }
  if (intent === 'pay' && (!parsed.amount || parsed.amount <= 0)) {
    return { ok: false, note: 'Pay requires a positive amount.' };
  }
  if (intent === 'buy') {
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
  if (intent === 'sell') {
    if (typeof parsed.amount !== 'number' || parsed.amount <= 0) {
      return { ok: false, note: 'Sell requires a positive amount.' };
    }
    if (parsed.item === 'meal') {
      if (!canProvideService(agentDoc, 'meal')) {
        return { ok: false, note: 'Meal service is unavailable here until you have bread and ale at the inn.' };
      }
    } else if (!inventoryHasAtLeast(agentDoc.inventory, parsed.item!, parsed.quantity!)) {
      const sellerInv = parseInventoryRecord(agentDoc.inventory);
      return {
        ok: false,
        note: `Not enough ${parsed.item}: need ${parsed.quantity}, have ${sellerInv[parsed.item!] ?? 0}.`,
      };
    }
  }
  if (intent === 'trade') {
    if (!Array.isArray(parsed.offer) || parsed.offer.length === 0) return { ok: false, note: 'Trade requires a non-empty offer.' };
    if (!Array.isArray(parsed.request) || parsed.request.length === 0) return { ok: false, note: 'Trade requires a non-empty request.' };
    const proposerOffer = parseItemList(parsed.offer);
    for (const [item, qty] of Object.entries(proposerOffer)) {
      if (item === 'coin') {
        if (agentDoc.coin < qty) return { ok: false, note: `Not enough coin: need ${qty}c, have ${agentDoc.coin}c.` };
      } else if (!inventoryHasAtLeast(agentDoc.inventory, item, qty)) {
        const proposerInv = parseInventoryRecord(agentDoc.inventory);
        return { ok: false, note: `Not enough ${item}: need ${qty}, have ${proposerInv[item] ?? 0}.` };
      }
    }
  }
  return { ok: true };
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
  await ctx.db.patch(agentDoc._id, {
    busy: false,
    busyUntilTick: undefined,
    pendingActionJson: undefined,
    pendingActionStartedTick: undefined,
    pendingActionStartedDay: undefined,
  });
  return { outcome: 'failed', note: failNote };
}

function clearBusyStatePatch() {
  return {
    busy: false,
    busyUntilTick: undefined,
    pendingActionJson: undefined,
    pendingActionStartedTick: undefined,
    pendingActionStartedDay: undefined,
  };
}

async function startBusyAction(
  ctx: any,
  agentDoc: any,
  args: {
    agentName: string;
    action: RocklawAction;
    tick: number;
    day: number;
    durationTicks: number;
  },
) {
  const { agentName, action, tick, day, durationTicks } = args;
  await ctx.db.patch(agentDoc._id, {
    busy: true,
    busyUntilTick: tick + durationTicks,
    pendingActionJson: JSON.stringify(action),
    pendingActionStartedTick: tick,
    pendingActionStartedDay: day,
  });
  await ctx.scheduler.runAfter(0, internal.rocklaw.visualBridge.setAgentActivity, {
    agentName,
    action: action.action,
    durationMs: durationTicks * TICK_INTERVAL_MS,
  });
  return {
    outcome: 'started',
    note: `You are busy ${describeActionForHumans(action)} until tick ${tick + durationTicks}.`,
    durationTicks,
  };
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

  if ((deliveryOverride ?? 'deferred') === 'deferred') {
    const recentClosedScene = await getMostRecentClosedSceneBetweenAgents(ctx, agentDoc.name, parsed.target!);
    if (recentClosedScene && typeof recentClosedScene.closedTick === 'number' && tick <= recentClosedScene.closedTick + 1) {
      await ctx.db.insert('rl_actions_log', {
        agentName: agentDoc.name,
        action: parsed.action,
        target: parsed.target ?? undefined,
        location: agentDoc.location,
        message: text,
        tick,
        day,
        outcome: 'success',
        outcomeNote: `Suppressed deferred follow-up to ${parsed.target} because your live chat just closed on the previous tick.`,
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
        note: `${parsed.target} just left your live chat. Wait a beat before following up again.`,
      };
    }
  }

  await markUnreadChatFromContactRead(ctx, agentDoc.name, parsed.target!, tick, day);
  const targetActivePartners = await getActiveTalkPartnersForAgent(ctx, parsed.target!);
  const targetAlreadyChattingWithOther = targetActivePartners.some((partner: string) => partner !== agentDoc.name);
  const deliveryMode: 'live' | 'deferred' = deliveryOverride
    ?? ((targetAgent.location === agentDoc.location && !targetAlreadyChattingWithOther) ? 'live' : 'deferred');
  const suspiciousDealLikeNote = !getChatIntent(parsed)
    ? describeSuspiciousDealLikeChat(text)
    : null;
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
      outcomeNote: suspiciousDealLikeNote
        ? `Live opener sent to ${parsed.target}. ${suspiciousDealLikeNote}`
        : `Live opener sent to ${parsed.target}.`,
    });

    await ctx.db.patch(agentDoc._id, {
      energy: newEnergy,
      health: newHealth,
      hunger: finalHunger,
      busy: false,
      busyUntilTick: undefined,
    });

    return {
      note: `Live opener sent to ${parsed.target}.`,
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
    outcomeNote: suspiciousDealLikeNote
      ? `${deferredReason ?? `Deferred chat sent to ${parsed.target}.`} ${suspiciousDealLikeNote}`
      : deferredReason ?? `Deferred chat sent to ${parsed.target}.`,
  });

  await ctx.db.patch(agentDoc._id, {
    energy: newEnergy,
    health: newHealth,
    hunger: finalHunger,
    busy: false,
    busyUntilTick: undefined,
  });

  await appendPendingNote(ctx, parsed.target!, `New chat from ${agentDoc.name}. Check TURN.md.`);

  return {
    outcome: 'success',
    note: deferredReason ?? `${parsed.target} is not here. Your chat was sent to their thread.`,
  };
}

function buildGenericSceneIntentFailure(intent: string | null) {
  switch (intent) {
    case 'give':
    case 'pay':
      return 'The attempted transfer did not go through.';
    case 'accept_transaction':
    case 'reject_transaction':
      return 'The transaction response did not go through.';
    case 'buy':
    case 'sell':
    case 'trade':
      return 'The attempted offer did not go through.';
    default:
      return 'The attempted action did not go through.';
  }
}

function cloneChatAsIntentAction(parsed: RocklawAction, action: string): RocklawAction {
  return {
    ...parsed,
    action,
    // Live-chat transaction responses still target the chat partner.
    // The referenced offer stays in offer_ref for validation/resolution.
    target: parsed.target,
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
  const liveScene = await getLiveChatSceneForAgent(ctx, agentDoc.name);
  if (liveScene && getScenePartner(liveScene, agentDoc.name) === parsed.target) {
    await supersedePendingTransactionsBetweenAgents(
      ctx,
      agentDoc.name,
      parsed.target!,
      tick,
      day,
      `Superseded by a newer ${parsed.action} offer in the same live chat.`,
    );
  }
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
  options?: { skipSceneVisibleMessage?: boolean },
) {
  const reference = parsed.offer_ref ?? parsed.target ?? '';
  if (isSceneOpeningOfferRef(reference)) {
    const scene = await getLiveChatSceneForAgent(ctx, agentDoc.name);
    const openingOffer = scene ? await getSceneOpeningOfferForRecipient(ctx, scene, agentDoc) : null;
    if (!scene || !openingOffer) {
      return recordFailedAction(ctx, agentDoc, agentDoc.name, parsed, tick, day, `Unknown pending offer: ${reference}.`);
    }
    const proposer = await ctx.db
      .query('rl_agents')
      .withIndex('name', (q: any) => q.eq('name', openingOffer.proposerName))
      .unique();
    if (!proposer) {
      await clearSceneOpeningOffer(ctx, scene);
      return recordFailedAction(ctx, agentDoc, agentDoc.name, parsed, tick, day, 'The other party no longer exists.');
    }
    if (proposer.location !== agentDoc.location) {
      await clearSceneOpeningOffer(ctx, scene);
      return recordFailedAction(ctx, agentDoc, agentDoc.name, parsed, tick, day, `${proposer.name} is no longer here. In-person offers can only be answered while the local scene is still live.`);
    }

    const openerTxnId = await createPendingTransactionFromParsedOffer(
      ctx,
      proposer.name,
      agentDoc.name,
      scene.location,
      openingOffer.parsed,
      tick,
      day,
    );
    await clearSceneOpeningOffer(ctx, scene);
    const replayedParsed: RocklawAction = {
      ...parsed,
      offer_ref: openerTxnId,
      target: proposer.name,
    };
    return resolveTransactionResponse(
      ctx,
      agentDoc,
      replayedParsed,
      tick,
      day,
      newEnergy,
      newHealth,
      finalHunger,
      options,
    );
  }
  const txn = await resolvePendingTransactionReference(ctx, agentDoc.name, reference);

  if (!txn) {
    const referencedTxn = await findTransactionByTargetReference(ctx, reference);
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
    return recordFailedAction(ctx, agentDoc, agentDoc.name, parsed, tick, day, `Unknown pending offer: ${reference}.`);
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
    if (!options?.skipSceneVisibleMessage) {
      await appendLiveSceneActionMessage(ctx, agentDoc, parsed, tick, day, proposer.name);
    }
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
  const proposerInv = parseInventoryRecord(proposer.inventory);
  const recipientInv = parseInventoryRecord(agentDoc.inventory);

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
  if (!options?.skipSceneVisibleMessage) {
    await appendLiveSceneActionMessage(ctx, agentDoc, parsed, tick, day, proposer.name);
  }
  const completionText = `Trade completed: ${formatTransactionItems(offer)} for ${formatTransactionItems(request)}.`;
  await createSceneSystemMessage(ctx, agentDoc.name, proposer.name, completionText, tick, day);

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

export const getPromptActionHints = internalQuery({
  args: {
    agentName: v.string(),
    tick: v.optional(v.number()),
  },
  handler: async (ctx, { agentName, tick }) => {
    const agentDoc = await ctx.db.query('rl_agents').withIndex('name', (q) => q.eq('name', agentName)).unique();
    if (!agentDoc) return [];
    return buildPromptActionHints(ctx, agentDoc, tick);
  },
});

export const getLiveChatTradeFacts = internalQuery({
  args: { agentName: v.string() },
  handler: async (ctx, { agentName }) => {
    const agentDoc = await ctx.db.query('rl_agents').withIndex('name', (q) => q.eq('name', agentName)).unique();
    if (!agentDoc) return [];
    return buildLiveChatTradeFacts(ctx, agentDoc);
  },
});

export const getLiveChatPromptContext = internalQuery({
  args: { agentName: v.string() },
  handler: async (ctx, { agentName }) => {
    const agentDoc = await ctx.db.query('rl_agents').withIndex('name', (q) => q.eq('name', agentName)).unique();
    if (!agentDoc) return null;
    return buildLiveChatPromptContext(ctx, agentDoc);
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
    openingSpeaker: v.optional(v.string()),
    openingText: v.optional(v.string()),
    openingOfferRef: v.optional(v.string()),
    openingOfferPayloadJson: v.optional(v.string()),
    interruptedSpeaker: v.optional(v.string()),
    interruptedText: v.optional(v.string()),
    interruptedActionJson: v.optional(v.string()),
    tick: v.number(),
    day: v.number(),
  },
  handler: async (ctx, {
    agentA,
    agentB,
    location,
    nextSpeaker,
    openingSpeaker,
    openingText,
    openingOfferRef,
    openingOfferPayloadJson,
    interruptedSpeaker,
    interruptedText,
    interruptedActionJson,
    tick,
    day,
  }) => {
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
      lastMessageOrder: 0,
      lastActiveTick: tick,
      lastActiveDay: day,
      stallTurns: 0,
      openingSpeaker,
      openingText,
      openingOfferRef,
      openingOfferPayloadJson,
      interruptedSpeaker,
      interruptedText,
      interruptedActionJson,
      interruptedContextPending: Boolean(interruptedSpeaker && interruptedText),
    });
    return sceneId;
  },
});

export const recordLiveChatMessage = internalMutation({
  args: {
    fromAgent: v.string(),
    toAgent: v.string(),
    text: v.string(),
    tick: v.number(),
    day: v.number(),
  },
  handler: async (ctx, { fromAgent, toAgent, text, tick, day }) => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    return await createChatMessage(ctx, {
      fromAgent,
      toAgent,
      text: trimmed,
      deliveryMode: 'live',
      tick,
      day,
    });
  },
});

export const consumeInterruptedChatContext = internalMutation({
  args: { agentName: v.string() },
  handler: async (ctx, { agentName }) => {
    const scene = await getLiveChatSceneForAgent(ctx, agentName);
    if (!scene || scene.interruptedSpeaker !== agentName || !scene.interruptedContextPending) return null;
    await ctx.db.patch(scene._id, {
      interruptedContextPending: false,
    });
    return scene.sceneId;
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

export const registerLiveChatReplyFailure = internalMutation({
  args: {
    agentName: v.string(),
    tick: v.number(),
    day: v.number(),
    note: v.string(),
  },
  handler: async (ctx, { agentName, tick, day, note }) => {
    const scene = await getLiveChatSceneForAgent(ctx, agentName);
    if (!scene) return null;
    const partner = getScenePartner(scene, agentName);
    const nextStallTurns = (scene.stallTurns ?? 0) + 1;
    await ctx.db.patch(scene._id, {
      lastActiveTick: tick,
      lastActiveDay: day,
      stallTurns: nextStallTurns,
    });
    await createSceneSystemMessage(
      ctx,
      agentName,
      partner,
      `${agentName} failed to answer clearly. The live chat is stalled and ${agentName} still owes the next reply.`,
      tick,
      day,
    );
    return {
      sceneId: scene.sceneId,
      partner,
      stallTurns: nextStallTurns,
      note,
    };
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

export const closeStalledLiveChatScenes = internalMutation({
  args: {
    tick: v.number(),
    day: v.number(),
    maxStallTurns: v.number(),
  },
  handler: async (ctx, { tick, day, maxStallTurns }) => {
    const scenes = await ctx.db
      .query('rl_chat_scenes')
      .withIndex('status_location', (q: any) => q.eq('status', 'live'))
      .collect();
    const closed: Array<{ sceneId: string; agentA: string; agentB: string }> = [];
    for (const scene of scenes) {
      if ((scene.stallTurns ?? 0) < maxStallTurns) continue;
      await ctx.db.patch(scene._id, {
        status: 'closed',
        closeReason: `Conversation stalled after ${scene.stallTurns} low-progress turns.`,
        closedTick: tick,
        closedDay: day,
        lastActiveTick: tick,
        lastActiveDay: day,
      });

      const sentPendingA = await ctx.db
        .query('rl_transactions')
        .withIndex('sender_status', (q: any) => q.eq('fromAgent', scene.agentA).eq('status', 'pending'))
        .collect();
      const receivedPendingA = await ctx.db
        .query('rl_transactions')
        .withIndex('recipient_status', (q: any) => q.eq('toAgent', scene.agentA).eq('status', 'pending'))
        .collect();
      const sceneTransactions = [...sentPendingA, ...receivedPendingA].filter((txn) =>
        ((txn.fromAgent === scene.agentA && txn.toAgent === scene.agentB)
          || (txn.fromAgent === scene.agentB && txn.toAgent === scene.agentA))
        && txn.status === 'pending',
      );
      for (const txn of sceneTransactions) {
        const note = `In-person offer ended when the conversation between ${scene.agentA} and ${scene.agentB} stalled.`;
        await ctx.db.patch(txn._id, {
          status: 'expired',
          resolvedTick: tick,
          resolvedDay: day,
          outcomeNote: note,
        });
        await setInteractionOutcomeByTransactionId(ctx, txn.txnId, {
          status: 'expired',
          resolvedTick: tick,
          resolvedDay: day,
          outcomeNote: note,
        });
      }
      closed.push({ sceneId: scene.sceneId, agentA: scene.agentA, agentB: scene.agentB });
    }
    return closed;
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
  const items = normaliseEntityList(entries) ?? [];
  return items.map((entry) => ({
    ...entry,
    item: canonicalizeTransactionItemId(entry.item) ?? entry.item,
  }));
}

function buildTransactionTerms(parsed: RocklawAction): { offer: TransactionItem[]; request: TransactionItem[] } {
  switch (parsed.action === 'chat' ? getChatIntent(parsed) : parsed.action) {
    case 'buy':
      return {
        offer: typeof parsed.amount === 'number' && parsed.amount > 0 ? [{ item: 'coin', quantity: parsed.amount }] : [],
        request: parsed.item && typeof parsed.quantity === 'number' && parsed.quantity > 0
          ? [{ item: canonicalizeTransactionItemId(parsed.item) ?? parsed.item, quantity: parsed.quantity }]
          : [],
      };
    case 'sell':
      return {
        offer: parsed.item && typeof parsed.quantity === 'number' && parsed.quantity > 0
          ? [{ item: canonicalizeTransactionItemId(parsed.item) ?? parsed.item, quantity: parsed.quantity }]
          : [],
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
    return Array.isArray(parsed)
      ? canonicalizeItemEntries(parsed.map((entry) => ({
          ...entry,
          item: canonicalizeTransactionItemId(entry.item) ?? entry.item,
        })))
      : [];
  } catch {
    return [];
  }
}

function formatTransactionItems(items: TransactionItem[]): string {
  if (items.length === 0) return 'nothing';
  return canonicalizeItemEntries(items).map((entry) => formatItemQuantity(entry.item, entry.quantity)).join(', ');
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

export const configureOpenRouterFreeAgent = internalMutation({
  args: {
    agentName: v.string(),
    currentModel: v.string(),
    fallbackModel: v.string(),
    fallbackProvider: v.optional(v.string()),
    candidatesJson: v.string(),
  },
  handler: async (ctx, { agentName, currentModel, fallbackModel, fallbackProvider, candidatesJson }) => {
    const agent = await ctx.db
      .query('rl_agents')
      .withIndex('name', (q) => q.eq('name', agentName))
      .unique();
    if (!agent) return false;
    await ctx.db.patch(agent._id, {
      providerOverride: 'openrouter',
      modelOverride: currentModel,
      openrouterFreeEnabled: true,
      openrouterFreeCandidatesJson: candidatesJson,
      openrouterFreeCurrentIndex: 0,
      openrouterFreeFailureCount: 0,
      openrouterFreeFallbackActivated: false,
      openrouterFreeFallbackModel: fallbackModel,
      openrouterFreeFallbackProvider: fallbackProvider ?? 'openrouter',
    });
    return true;
  },
});

export const clearOpenRouterFreeAgent = internalMutation({
  args: { agentName: v.string() },
  handler: async (ctx, { agentName }) => {
    const agent = await ctx.db
      .query('rl_agents')
      .withIndex('name', (q) => q.eq('name', agentName))
      .unique();
    if (!agent) return false;
    await ctx.db.patch(agent._id, {
      openrouterFreeEnabled: undefined,
      openrouterFreeCandidatesJson: undefined,
      openrouterFreeCurrentIndex: undefined,
      openrouterFreeFailureCount: undefined,
      openrouterFreeFallbackActivated: undefined,
      openrouterFreeFallbackModel: undefined,
      openrouterFreeFallbackProvider: undefined,
    });
    return true;
  },
});

export const resetOpenRouterFreeFailureState = internalMutation({
  args: { agentName: v.string() },
  handler: async (ctx, { agentName }) => {
    const agent = await ctx.db
      .query('rl_agents')
      .withIndex('name', (q) => q.eq('name', agentName))
      .unique();
    if (!agent?.openrouterFreeEnabled) return false;
    if ((agent.openrouterFreeFailureCount ?? 0) === 0) return true;
    await ctx.db.patch(agent._id, { openrouterFreeFailureCount: 0 });
    return true;
  },
});

export const registerOpenRouterFreeFailure = internalMutation({
  args: {
    agentName: v.string(),
    failureKind: v.union(
      v.literal('transport_failed'),
      v.literal('parse_failed'),
      v.literal('invalid_action'),
    ),
  },
  handler: async (ctx, { agentName, failureKind }) => {
    const agent = await ctx.db
      .query('rl_agents')
      .withIndex('name', (q) => q.eq('name', agentName))
      .unique();
    if (!agent?.openrouterFreeEnabled) return null;

    const threshold = failureKind === 'transport_failed' ? 1 : 2;
    const nextFailureCount = (agent.openrouterFreeFailureCount ?? 0) + 1;
    const candidates = (() => {
      try {
        const parsed = JSON.parse(agent.openrouterFreeCandidatesJson ?? '[]') as string[];
        return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string' && entry.trim()) : [];
      } catch {
        return [] as string[];
      }
    })();

    if (nextFailureCount < threshold) {
      await ctx.db.patch(agent._id, { openrouterFreeFailureCount: nextFailureCount });
      return null;
    }

    const currentIndex = agent.openrouterFreeCurrentIndex ?? 0;
    const nextCandidate = candidates[currentIndex + 1];
    if (!agent.openrouterFreeFallbackActivated && nextCandidate) {
      await ctx.db.patch(agent._id, {
        providerOverride: 'openrouter',
        modelOverride: nextCandidate,
        openrouterFreeCurrentIndex: currentIndex + 1,
        openrouterFreeFailureCount: 0,
      });
      return {
        mode: 'rotate',
        provider: 'openrouter',
        model: nextCandidate,
        previousModel: agent.modelOverride ?? candidates[currentIndex] ?? null,
      };
    }

    if (!agent.openrouterFreeFallbackActivated && agent.openrouterFreeFallbackModel) {
      const fallbackProvider = agent.openrouterFreeFallbackProvider ?? 'openrouter';
      await ctx.db.patch(agent._id, {
        providerOverride: fallbackProvider,
        modelOverride: agent.openrouterFreeFallbackModel,
        openrouterFreeFailureCount: 0,
        openrouterFreeFallbackActivated: true,
      });
      return {
        mode: 'fallback',
        provider: fallbackProvider,
        model: agent.openrouterFreeFallbackModel,
        previousModel: agent.modelOverride ?? candidates[currentIndex] ?? null,
      };
    }

    await ctx.db.patch(agent._id, { openrouterFreeFailureCount: nextFailureCount });
    return null;
  },
});

async function executeResolvedAction(
  ctx: any,
  args: {
    agentDoc: any;
    agentName: string;
    parsed: RocklawAction;
    tick: number;
    day: number;
    chatDeliveryOverride?: 'live' | 'deferred';
    chatDeferredReason?: string;
    activityDurationTicks?: number;
    validationTick?: number;
  },
) {
  const {
    agentDoc,
    agentName,
    parsed,
    tick,
    day,
    chatDeliveryOverride,
    chatDeferredReason,
    activityDurationTicks = 1,
    validationTick = tick,
  } = args;

  const worldValidation = await validateWorldExecution(ctx, agentDoc, parsed, validationTick);
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
  if (worldValidation.resolvedTarget) {
    parsed.target = worldValidation.resolvedTarget;
  }

  const energyCost = EFFORT_COSTS[parsed.action] ?? 5;

  const SOCIALLY_GATED_ACTIONS = new Set(['treat', 'counsel', 'serve', 'rent_room', 'buy', 'bless']);
  const GATED_LOCATIONS = new Set(['shrine', 'inn', 'market']);
  if (SOCIALLY_GATED_ACTIONS.has(parsed.action) && GATED_LOCATIONS.has(agentDoc.location)) {
    const rep = await ctx.db
      .query('rl_reputation')
      .withIndex('agentName', (q: any) => q.eq('agentName', agentName))
      .unique();
    if ((rep?.score ?? 50) < 20) {
      const failNote = `Refused service — your reputation (${rep?.score ?? 50}/100) is too low here.`;
      return recordFailedAction(ctx, agentDoc, agentName, parsed, tick, day, failNote);
    }
  }

  const minEnergyForHardWork = await readSystemFloat(ctx, 'agents', 'min_energy_for_hard_work', DEFAULT_MIN_ENERGY_FOR_HARD_WORK);
  const healthDrainPerZeroTick = await readSystemFloat(ctx, 'agents', 'health_drain_per_zero_tick', DEFAULT_HEALTH_DRAIN_PER_ZERO_ENERGY_TICK);

  const isExhausted = HIGH_EFFORT_ACTIONS.has(parsed.action) &&
    agentDoc.energy < minEnergyForHardWork;

  if (isExhausted) {
    const failNote = `Too exhausted to ${parsed.action}. Energy: ${agentDoc.energy}/100. Rest first.`;
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
      outcomeNote: `${failNote}${formatSpeechIntentNote(getSpeechIntent(parsed))}`,
    });

    await ctx.db.patch(agentDoc._id, {
      energy: penaltyEnergy,
      hunger: newHunger,
      ...clearBusyStatePatch(),
    });

    if (parsed.target ?? parsed.location) {
      await ctx.scheduler.runAfter(0, internal.rocklaw.reputation.updateReputation, {
        agentName, delta: -3, note: `failed ${parsed.action} (exhausted)`, tick,
      });
    }

    return { outcome: 'failed', note: failNote, durationTicks: 1 };
  }

  const newEnergy = Math.max(0, Math.min(100, agentDoc.energy - energyCost));
  const newHunger = Math.min(100, agentDoc.hunger + 5);
  const sustainedExhaustion = agentDoc.energy === 0 && parsed.action !== 'sleep' && parsed.action !== 'rest';
  const newHealth = sustainedExhaustion
    ? Math.max(0, agentDoc.health - healthDrainPerZeroTick)
    : agentDoc.health;

  if (parsed.action === 'pray' && (parsed.text || parsed.message)) {
    const prayerText = parsed.text ?? parsed.message;
    if (prayerText) {
      await ctx.db.insert('rl_prayers', { agentName, message: prayerText, tick, day });
    }
  }

  if (parsed.action === 'eavesdrop' && (parsed.text || parsed.message)) {
    const overheard = parsed.text ?? parsed.message;
    if (!overheard) {
      return { outcome: 'failed', note: 'Missing eavesdrop text', durationTicks: 1 };
    }
    await ctx.db.patch(agentDoc._id, {
      pendingNote: `You overheard: "${overheard}"`,
    });
  }

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

  let repCoinModifier = 1.0;
  if (['buy', 'sell', 'trade'].includes(parsed.action)) {
    const rep = await ctx.db
      .query('rl_reputation')
      .withIndex('agentName', (q: any) => q.eq('agentName', agentName))
      .unique();
    const repScore = rep?.score ?? 50;
    if (repScore > 70) repCoinModifier = 0.95;
    else if (repScore < 30) repCoinModifier = 1.10;
  }

  const { newInventory, newCoin: rawCoin } = applyInventoryChanges(
    agentDoc.inventory,
    agentDoc.coin,
    parsed.consumes,
    parsed.produces,
    parsed.action,
  );
  const coinDelta = rawCoin - agentDoc.coin;
  const newCoin = agentDoc.coin + Math.round(coinDelta * repCoinModifier);

  const outcomeNote = sustainedExhaustion
    ? 'Acting on zero energy -- health is degrading. Sleep urgently.'
    : undefined;

  const eatingHungerReduction = parsed.action === 'eat' ? hungerRestoreFor(parsed.item) : 0;
  const useHealthRestore = parsed.action === 'use' ? healthRestoreFor(parsed.item) * (parsed.quantity ?? 1) : 0;
  const finalHunger = Math.max(0, newHunger - eatingHungerReduction);
  const finalHealth = Math.min(100, newHealth + useHealthRestore);

  if (parsed.action === 'buy' || parsed.action === 'sell' || parsed.action === 'trade') {
    const result = await createPendingTransaction(
      ctx,
      agentDoc,
      parsed,
      tick,
      day,
      newEnergy,
      finalHealth,
      finalHunger,
    );
    if (result?.outcome === 'success') {
      await appendLiveSceneActionMessage(ctx, agentDoc, parsed, tick, day, parsed.target ?? undefined);
      await advanceLiveSceneTurn(ctx, agentName, tick, day, parsed);
    }
    return { ...result, durationTicks: 1 };
  }

  if (parsed.action === 'leave_chat') {
    const closingText = parsed.text ?? parsed.message ?? '';
    const activeScene = await getLiveChatSceneForAgent(ctx, agentName);
    const activePartner = activeScene ? getScenePartner(activeScene, agentName) : null;
    if (activePartner && closingText.trim() !== '') {
      await markUnreadChatFromContactRead(ctx, agentDoc.name, activePartner, tick, day);
      await createChatMessage(ctx, {
        fromAgent: agentDoc.name,
        toAgent: activePartner,
        text: closingText,
        deliveryMode: 'live',
        tick,
        day,
        boundSceneId: activeScene.sceneId,
      });
    }
    const closed = await closeLiveChatSceneForAgent(ctx, agentName, tick, day, `${agentName} left the live chat.`);
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
        : closingText.trim() !== ''
          ? 'The conversation had already ended, so your goodbye did not need to close anything.'
          : 'The conversation had already ended.',
    });
    await ctx.db.patch(agentDoc._id, {
      energy: newEnergy,
      health: finalHealth,
      hunger: finalHunger,
      ...clearBusyStatePatch(),
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
      durationTicks: 1,
    };
  }

  if (parsed.action === 'accept_transaction' || parsed.action === 'reject_transaction') {
    const result = await resolveTransactionResponse(
      ctx,
      agentDoc,
      parsed,
      tick,
      day,
      newEnergy,
      finalHealth,
      finalHunger,
    );
    if (result?.outcome === 'success') {
      await advanceLiveSceneTurn(ctx, agentName, tick, day, parsed);
    }
    return { ...result, durationTicks: 1 };
  }

  if (parsed.action === 'chat') {
    const chatIntent = getChatIntent(parsed);
    if (chatIntent && chatDeliveryOverride === 'live') {
      const partner = parsed.target!;
      const liveScene = await getLiveChatSceneForAgent(ctx, agentDoc.name);
      const isOpeningOfferTurn =
        Boolean(
          liveScene
          && liveScene.openingSpeaker === agentDoc.name
          && !liveScene.lastSpeaker
          && liveScene.nextSpeaker === partner
          && liveScene.openingOfferPayloadJson
          && isSceneOpeningOfferRef(liveScene.openingOfferRef ?? null),
        );
      await markUnreadChatFromContactRead(ctx, agentDoc.name, partner, tick, day);
      await createChatMessage(ctx, {
        fromAgent: agentDoc.name,
        toAgent: partner,
        text: parsed.text ?? parsed.message ?? '',
        deliveryMode: 'live',
        tick,
        day,
      });

      const commerceParsed = cloneChatAsIntentAction(parsed, chatIntent);
      const sideEffectValidation = await validateChatIntentSideEffect(ctx, agentDoc, commerceParsed, chatIntent);
      if (!sideEffectValidation.ok) {
        await createSceneSystemMessage(
          ctx,
          agentDoc.name,
          partner,
          sideEffectValidation.note ?? buildGenericSceneIntentFailure(chatIntent),
          tick,
          day,
        );
        await ctx.db.insert('rl_actions_log', {
          agentName,
          action: 'chat',
          target: partner,
          location: agentDoc.location,
          message: parsed.text ?? parsed.message,
          tick,
          day,
          outcome: 'failed',
          outcomeNote: sideEffectValidation.note,
        });
        await ctx.db.patch(agentDoc._id, {
          energy: newEnergy,
          health: newHealth,
          hunger: finalHunger,
          ...clearBusyStatePatch(),
        });
        await advanceLiveSceneTurn(ctx, agentName, tick, day, parsed);
        return { outcome: 'failed', note: sideEffectValidation.note, durationTicks: 1 };
      }

      let result:
        | { outcome?: string; note?: string }
        | undefined;
      if (isOpeningOfferTurn) {
        await ctx.db.insert('rl_actions_log', {
          agentName,
          action: 'chat',
          target: partner,
          location: agentDoc.location,
          message: parsed.text ?? parsed.message,
          tick,
          day,
          outcome: 'success',
          outcomeNote: `Opening offer ${liveScene?.openingOfferRef ?? SCENE_OPENING_OFFER_REF} is now visible to ${partner}.${formatSpeechIntentNote(chatIntent)}`,
        });
        await ctx.db.patch(agentDoc._id, {
          energy: newEnergy,
          health: finalHealth,
          hunger: finalHunger,
          ...clearBusyStatePatch(),
        });
        result = {
          outcome: 'success',
          note: `Opening offer ${liveScene?.openingOfferRef ?? SCENE_OPENING_OFFER_REF} is now visible to ${partner}.`,
        };
      } else if (chatIntent === 'buy' || chatIntent === 'sell' || chatIntent === 'trade') {
        result = await createPendingTransaction(
          ctx,
          agentDoc,
          commerceParsed,
          tick,
          day,
          newEnergy,
          finalHealth,
          finalHunger,
        );
      } else if (chatIntent === 'accept_transaction' || chatIntent === 'reject_transaction') {
        result = await resolveTransactionResponse(
          ctx,
          agentDoc,
          commerceParsed,
          tick,
          day,
          newEnergy,
          finalHealth,
          finalHunger,
          { skipSceneVisibleMessage: true },
        );
      } else if (chatIntent === 'pay' || chatIntent === 'give') {
        const recipient = await ctx.db
          .query('rl_agents')
          .withIndex('name', (q: any) => q.eq('name', partner))
          .unique();
        if (!recipient) {
          await createSceneSystemMessage(ctx, agentDoc.name, partner, buildGenericSceneIntentFailure(chatIntent), tick, day);
          await ctx.db.patch(agentDoc._id, {
            energy: newEnergy,
            health: finalHealth,
            hunger: finalHunger,
            ...clearBusyStatePatch(),
          });
          await advanceLiveSceneTurn(ctx, agentName, tick, day, parsed);
          return { outcome: 'failed', note: `Target agent not found: ${partner}.`, durationTicks: 1 };
        }
        const recipientProduces =
          chatIntent === 'pay'
            ? [{ item: 'coin', quantity: commerceParsed.amount ?? 0 }]
            : commerceParsed.item && typeof commerceParsed.quantity === 'number'
            ? [{ item: commerceParsed.item, quantity: commerceParsed.quantity }]
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
        await ctx.db.insert('rl_actions_log', {
          agentName,
          action: chatIntent,
          target: partner,
          location: agentDoc.location,
          message: parsed.text ?? parsed.message,
          tick,
          day,
          outcome: 'success',
          outcomeNote: `${chatIntent} completed in live chat.${formatSpeechIntentNote(chatIntent)}`,
        });
        await ctx.db.patch(agentDoc._id, {
          energy: newEnergy,
          health: finalHealth,
          hunger: finalHunger,
          ...clearBusyStatePatch(),
        });
        result = { outcome: 'success', note: `${chatIntent} completed with ${partner}.` };
      }

      if (result?.outcome === 'success') {
        await advanceLiveSceneTurn(ctx, agentName, tick, day, parsed);
      }
      return { ...(result ?? { outcome: 'success', note: `Live scene reply sent to ${partner}.` }), durationTicks: 1 };
    }

    const result = await sendChatAction(
      ctx,
      agentDoc,
      parsed,
      tick,
      day,
      newEnergy,
      finalHealth,
      finalHunger,
      chatDeliveryOverride,
      chatDeferredReason,
    );
    if ((chatDeliveryOverride === 'live') && result?.outcome === 'success') {
      await advanceLiveSceneTurn(ctx, agentName, tick, day, parsed);
    }
    return { ...result, durationTicks: 1 };
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
      .withIndex('name', (q: any) => q.eq('name', targetName))
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
    await appendLiveSceneActionMessage(ctx, agentDoc, parsed, tick, day, recipient.name);
    await advanceLiveSceneTurn(ctx, agentName, tick, day, parsed);
  }

  if (parsed.action === 'talk') {
    return createTalkInteraction(
      ctx,
      agentDoc,
      parsed,
      tick,
      day,
      newEnergy,
      finalHealth,
      finalHunger,
    );
  }

  if ((parsed.action === 'plant' || (parsed.action === 'work' && worldValidation.workKind === 'plant')) && worldValidation.fieldKey) {
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

  if ((parsed.action === 'water' || (parsed.action === 'work' && worldValidation.workKind === 'water')) && worldValidation.fieldKey) {
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

  if ((parsed.action === 'harvest' || (parsed.action === 'work' && worldValidation.workKind === 'harvest')) && worldValidation.fieldKey) {
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

  if ((parsed.action === 'gather' || (parsed.action === 'work' && worldValidation.workKind === 'gather')) && worldValidation.herbPatchKey) {
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

  if ((parsed.action === 'buy_place' || parsed.action === 'sell_place' || parsed.action === 'deliver_place') && worldValidation.placeStockId) {
    const stock = await ctx.db.get(worldValidation.placeStockId);
    if (stock) {
      await ctx.db.patch(stock._id, {
        quantity: Math.max(0, stock.quantity + (worldValidation.stockDelta ?? 0)),
      });
    }
  }

  if ((parsed.action === 'buy_place' || parsed.action === 'sell_place') && worldValidation.placeMarketId) {
    const market = await ctx.db.get(worldValidation.placeMarketId);
    if (market) {
      await ctx.db.patch(market._id, {
        treasury: Math.max(0, market.treasury + (worldValidation.placeTreasuryDelta ?? 0)),
      });
    }
  }

  if (parsed.action !== 'wait') {
    await noteTalkNonResponse(ctx, agentDoc.name, parsed.action, tick, day);
  }

  await ctx.db.insert('rl_actions_log', {
    agentName,
    action: parsed.action,
    target: parsed.target ?? parsed.location ?? parsed.item ?? undefined,
    location: newLocation,
    message: parsed.text ?? parsed.message,
    tick,
    day,
    outcome: 'success',
    outcomeNote: `${outcomeNote ?? ''}${(parsed.action === 'chat' || parsed.action === 'say') ? formatSpeechIntentNote(getSpeechIntent(parsed)) : ''}`.trim() || undefined,
  });

  if (parsed.action === 'sleep' && parsed.journal) {
    await ctx.db.insert('rl_journal_entries', {
      agentName,
      day,
      tick,
      timeOfDay: timeOfDayForTick(tick),
      summary: parsed.journal,
    });
  }

  await ctx.db.patch(agentDoc._id, {
    energy: newEnergy,
    health: finalHealth,
    hunger: finalHunger,
    location: newLocation,
    inventory: newInventory,
    coin: newCoin,
    ...clearBusyStatePatch(),
  });

  if (['buy', 'sell', 'buy_place', 'sell_place', 'deliver_place', 'work', 'craft', 'smelt', 'brew', 'give', 'trade', 'eat', 'use', 'plant', 'harvest', 'gather'].includes(parsed.action)) {
    await ctx.scheduler.runAfter(0, internal.rocklaw.priceEngine.recalculate, {});
  }

  const REP_DELTAS: Record<string, number> = {
    give: 2, treat: 2, counsel: 2, bless: 2, run_errand: 2,
    trade: 1, sell: 1, buy: 1, buy_place: 1, sell_place: 1, deliver_place: 1,
  };
  const repDelta = REP_DELTAS[parsed.action] ?? 0;
  if (repDelta !== 0) {
    await ctx.scheduler.runAfter(0, internal.rocklaw.reputation.updateReputation, {
      agentName, delta: repDelta, note: parsed.action, tick,
    });
  }

  if (parsed.action === 'move' && newLocation !== agentDoc.location) {
    await ctx.scheduler.runAfter(0, internal.rocklaw.visualBridge.syncAgentPosition, {
      agentName, newLocation,
    });
  }
  if (activityDurationTicks > 0) {
    await ctx.scheduler.runAfter(0, internal.rocklaw.visualBridge.setAgentActivity, {
      agentName,
      action: parsed.action,
      durationMs: activityDurationTicks * TICK_INTERVAL_MS,
    });
  }

  return { outcome: 'success', note: outcomeNote, durationTicks: 1 };
}

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
    const durationTicks = getActionDuration(parsed.action);
    if (durationTicks > 1) {
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
      return startBusyAction(ctx, agentDoc, {
        agentName,
        action: parsed,
        tick,
        day,
        durationTicks,
      });
    }

    return executeResolvedAction(ctx, {
      agentDoc,
      agentName,
      parsed,
      tick,
      day,
      chatDeliveryOverride,
      chatDeferredReason,
      activityDurationTicks: durationTicks,
    });
  },
});

export const completePendingAction = internalMutation({
  args: {
    agentName: v.string(),
    tick: v.number(),
    day: v.number(),
  },
  handler: async (ctx, { agentName, tick, day }) => {
    const agentDoc = await ctx.db
      .query('rl_agents')
      .withIndex('name', (q) => q.eq('name', agentName))
      .unique();
    if (!agentDoc) return { outcome: 'failed', note: 'Agent not found' };
    if (!agentDoc.pendingActionJson) {
      if (agentDoc.busy) {
        await ctx.db.patch(agentDoc._id, clearBusyStatePatch());
      }
      return { outcome: 'failed', note: 'No pending action to complete.' };
    }

    const parsed = normaliseAction(JSON.parse(agentDoc.pendingActionJson) as RocklawAction);
    const result = await executeResolvedAction(ctx, {
      agentDoc,
      agentName,
      parsed,
      tick,
      day,
      activityDurationTicks: 0,
      validationTick: agentDoc.pendingActionStartedTick ?? tick,
    });
    return {
      ...result,
      action: parsed,
    };
  },
});
