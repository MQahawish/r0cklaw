/**
 * World Refresh -- writes the agent's world/ files from Convex state
 * before each tick fires. The agent reads these files as "reality".
 *
 * Also handles HEARTBEAT.md appends (world engine only, never the agent).
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery } from '../_generated/server';
import { RECIPE_CATALOGUE, ROLE_ECONOMIC_ACTIONS, ROLE_TRADE_PROFILES, SERVICE_CATALOGUE } from './economy';

type EconomicSurfaceEntry = {
  action: string;
  status: 'available' | 'unavailable';
  detail: string;
};

type TradeOpportunity = {
  name: string;
  role: string;
  likelySells: string[];
  likelyBuys: string[];
};

function createChatThreadKey(agentA: string, agentB: string): string {
  return [agentA, agentB].sort((a, b) => a.localeCompare(b)).join('::');
}

function timeOfDayForTick(tick: number): 'morning' | 'afternoon' | 'evening' {
  const mod = tick % 3;
  if (mod === 1) return 'afternoon';
  if (mod === 2) return 'evening';
  return 'morning';
}

function findPrimaryTradeLocation(agentLocation: string): string {
  return agentLocation === 'market' ? 'inn' : 'market';
}

function buildTradeOpportunities(args: { agent: any; nearby: any[] }): TradeOpportunity[] {
  const { agent, nearby } = args;
  return nearby
    .filter((other) => other.name !== agent.name)
    .map((other) => {
      const profile = ROLE_TRADE_PROFILES[other.role] ?? { likelySells: [], likelyBuys: [] };
      const inv = JSON.parse(other.inventory ?? '{}') as Record<string, number>;
      const likelySells = profile.likelySells.filter((item) => {
        if (item === 'meal' && other.role === 'Innkeeper') {
          return other.location === 'inn' && (inv.bread ?? 0) >= 1 && (inv.ale ?? 0) >= 1;
        }
        return (inv[item] ?? 0) > 0;
      });
      return {
        name: other.name,
        role: other.role,
        likelySells,
        likelyBuys: profile.likelyBuys,
      };
    });
}

function buildEconomicSurface(args: {
  agent: any;
  nearby: any[];
  fieldsHere: any[];
  herbPatchesHere: any[];
  prices: any[];
  reachableLocations: string[];
}): EconomicSurfaceEntry[] {
  const { agent, nearby, fieldsHere, herbPatchesHere, prices, reachableLocations } = args;
  const inv = JSON.parse(agent.inventory) as Record<string, number>;
  const roleActions = ROLE_ECONOMIC_ACTIONS[agent.role] ?? ['buy', 'sell', 'trade'];
  const entries: EconomicSurfaceEntry[] = [];
  const nearbyTradePartners = nearby.filter((other) => other.name !== agent.name);
  const primaryTradeLocation = findPrimaryTradeLocation(agent.location);

  if (roleActions.includes('buy')) {
    if (nearbyTradePartners.length > 0) {
      const mealSeller = nearby.find((other) => other.role === 'Innkeeper' && agent.location === 'inn');
      entries.push({
        action: 'buy',
        status: 'available',
        detail: mealSeller
          ? `Available now. ${mealSeller.name} can trade here, including meal service if stocked.`
          : 'Available now because a trade partner is here.',
      });
    }
  }

  if (roleActions.includes('sell')) {
    const mealService = SERVICE_CATALOGUE.meal;
    const canServeMeal = agent.role === mealService.providerRole
      && agent.location === mealService.location
      && nearbyTradePartners.length > 0;
    if (nearbyTradePartners.length > 0) {
      entries.push({
        action: 'sell',
        status: 'available',
        detail: canServeMeal
          ? 'Available now. You can sell goods here, and meal service may be offered if your stock supports it.'
          : 'Available now because a trade partner is here.',
      });
    }
  }

  if (roleActions.includes('trade')) {
    if (nearbyTradePartners.length > 0) {
      entries.push({
        action: 'trade',
        status: 'available',
        detail: 'Available now because a trade partner is here.',
      });
    }
  }

  for (const recipe of RECIPE_CATALOGUE.filter((entry) => roleActions.includes(entry.action))) {
    const cheapestPrice = prices.find((price) => price.item === recipe.output)?.price;
    const hasInputs = recipe.consumes.every((entry) => (inv[entry.item] ?? 0) >= entry.quantity);
    entries.push({
      action: `${recipe.action}:${recipe.output}`,
      status: agent.location === recipe.location && hasInputs ? 'available' : 'unavailable',
      detail: agent.location !== recipe.location
        ? `Unavailable here. Move to ${recipe.location} to ${recipe.action} ${recipe.output}.`
        : hasInputs
        ? `Available now at ${recipe.location}${typeof cheapestPrice === 'number' ? `; ${recipe.output} is priced around ${cheapestPrice}c.` : '.'}`
        : `Unavailable now. You lack the inputs to ${recipe.action} ${recipe.output}.`
    });
  }

  const mealService = SERVICE_CATALOGUE.meal;
  if (agent.role === mealService.providerRole) {
    const hasMealInputs = mealService.consumes.every((entry) => (inv[entry.item] ?? 0) >= entry.quantity);
    if (agent.location === mealService.location && nearbyTradePartners.length > 0) {
      entries.push({
        action: 'meal_service',
        status: hasMealInputs ? 'available' : 'unavailable',
        detail: hasMealInputs
          ? 'Available now through `sell` with `item:"meal"`.'
          : 'Unavailable now. You need bread and ale before `sell` with `item:"meal"` will work.',
      });
    }
  }

  if (roleActions.includes('check_field')) {
    entries.push({
      action: 'check_field',
      status: agent.location === 'farm' ? 'available' : 'unavailable',
      detail: agent.location === 'farm'
        ? `Available now. ${fieldsHere.length} field${fieldsHere.length === 1 ? '' : 's'} here need attention.`
        : 'Unavailable here. Move to farm to inspect field state.',
    });
  }
  if (roleActions.includes('plant')) {
    const hasFallowField = fieldsHere.some((field) => field.stage === 'fallow');
    entries.push({
      action: 'plant',
      status: agent.location === 'farm' && hasFallowField ? 'available' : 'unavailable',
      detail: agent.location === 'farm'
        ? hasFallowField
          ? 'Available now. At least one field is fallow and ready to plant.'
          : 'Unavailable now. All fields are already in use.'
        : 'Unavailable here. Move to farm to plant crops.',
    });
  }
  if (roleActions.includes('water')) {
    const needsWater = fieldsHere.some((field) => field.stage === 'growing');
    entries.push({
      action: 'water',
      status: agent.location === 'farm' && needsWater ? 'available' : 'unavailable',
      detail: agent.location === 'farm'
        ? needsWater
          ? 'Available now. A growing field can be watered to speed it along.'
          : 'Unavailable now. No growing field needs water.'
        : 'Unavailable here. Move to farm to water crops.',
    });
  }
  if (roleActions.includes('harvest')) {
    const readyFields = fieldsHere.filter((field) => field.stage === 'ready');
    entries.push({
      action: 'harvest',
      status: agent.location === 'farm' && readyFields.length > 0 ? 'available' : 'unavailable',
      detail: agent.location === 'farm'
        ? readyFields.length > 0
          ? `Available now. ${readyFields.length} field${readyFields.length === 1 ? '' : 's'} is ready to harvest.`
          : 'Unavailable now. No field is ready to harvest.'
        : 'Unavailable here. Move to farm to harvest crops.',
    });
  }

  if (roleActions.includes('gather')) {
    const gatherable = herbPatchesHere.some((patch) => patch.available > 0);
    const remedy = reachableLocations.includes('shrine') ? 'shrine' : reachableLocations[0] ?? 'shrine';
    entries.push({
      action: 'gather',
      status: gatherable ? 'available' : 'unavailable',
      detail: gatherable
        ? 'Available now. Herbs can be gathered here.'
        : `Unavailable here. Move to ${remedy} to gather herbs.`,
    });
  }

  return entries;
}

// ── Letter delivery ───────────────────────────────────────────────────────────

/**
 * Finds unread letters addressed to agentName at their current location,
 * marks them as read, and returns the letter objects for inclusion in location.md.
 */
export const deliverLetters = internalMutation({
  args: {
    agentName: v.string(),
    locationId: v.union(v.id('rl_locations'), v.null()),
    day: v.number(),
  },
  handler: async (ctx, { agentName, locationId, day }) => {
    const unread = await ctx.db
      .query('rl_messages')
      .withIndex('toAgent', (q) => q.eq('toAgent', agentName).eq('status', 'unread'))
      .collect();

    // Deliver letters left at this specific location, or direct-delivery letters (no location)
    const deliverable = unread.filter(
      (m) => m.deliveryLocationId === undefined || m.deliveryLocationId === locationId,
    );

    for (const letter of deliverable) {
      await ctx.db.patch(letter._id, { status: 'read', dayRead: day });
    }

    return deliverable;
  },
});

// ── Pending note cleanup ──────────────────────────────────────────────────────

export const clearPendingNote = internalMutation({
  args: { agentName: v.string() },
  handler: async (ctx, { agentName }) => {
    const agent = await ctx.db
      .query('rl_agents')
      .withIndex('name', (q) => q.eq('name', agentName))
      .unique();
    if (agent) await ctx.db.patch(agent._id, { pendingNote: undefined });
  },
});

export const recordFirstSightingsForAgent = internalMutation({
  args: { agentName: v.string(), tick: v.number(), day: v.number() },
  handler: async (ctx, { agentName, tick, day }) => {
    const agent = await ctx.db
      .query('rl_agents')
      .withIndex('name', (q) => q.eq('name', agentName))
      .unique();
    if (!agent || !agent.blankSelf) return [];

    const nearby = await ctx.db
      .query('rl_agents')
      .withIndex('location', (q) => q.eq('location', agent.location))
      .collect();

    const firstSeen: Array<{ name: string; role: string; location: string }> = [];

    for (const other of nearby) {
      if (other.name === agentName) continue;

      const existing = await ctx.db
        .query('rl_social_knowledge')
        .withIndex('observer_subject', (q) => q.eq('observerAgent', agentName).eq('subjectAgent', other.name))
        .unique();

      if (existing) {
        await ctx.db.patch(existing._id, {
          lastSeenDay: day,
          lastSeenTick: tick,
          lastSeenLocation: agent.location,
        });
        continue;
      }

      await ctx.db.insert('rl_social_knowledge', {
        observerAgent: agentName,
        subjectAgent: other.name,
        knownName: other.name,
        knownRole: other.role,
        firstSeenDay: day,
        firstSeenTick: tick,
        firstSeenLocation: agent.location,
        lastSeenDay: day,
        lastSeenTick: tick,
        lastSeenLocation: agent.location,
      });
      firstSeen.push({ name: other.name, role: other.role, location: agent.location });
    }

    return firstSeen;
  },
});

export const expireTransactionsForAgent = internalMutation({
  args: { agentName: v.string(), tick: v.number(), day: v.number() },
  handler: async (ctx, { agentName, tick, day }) => {
    const pending = await ctx.db
      .query('rl_transactions')
      .withIndex('recipient_status', (q) => q.eq('toAgent', agentName).eq('status', 'pending'))
      .collect();

    const expired = pending.filter((txn) => txn.expiresTick < tick);
    for (const txn of expired) {
      await ctx.db.patch(txn._id, {
        status: 'expired',
        resolvedTick: tick,
        resolvedDay: day,
        outcomeNote: 'Offer expired before a response was made.',
      });
      const interaction = await ctx.db
        .query('rl_interactions')
        .withIndex('transactionId', (q) => q.eq('transactionId', txn.txnId))
        .unique();
      if (interaction) {
        await ctx.db.patch(interaction._id, {
          status: 'expired',
          resolvedTick: tick,
          resolvedDay: day,
          outcomeNote: 'Offer expired before a response was made.',
        });
      }
    }

    return expired.map((txn) => ({
      txnId: txn.txnId,
      fromAgent: txn.fromAgent,
      kind: txn.kind,
    }));
  },
});

export const expireInteractionsForAgent = internalMutation({
  args: { agentName: v.string(), tick: v.number(), day: v.number() },
  handler: async (ctx, { agentName, tick, day }) => {
    const received = await ctx.db
      .query('rl_interactions')
      .withIndex('recipient_status', (q) => q.eq('toAgent', agentName).eq('status', 'active'))
      .collect();
    const sent = await ctx.db
      .query('rl_interactions')
      .withIndex('sender_status', (q) => q.eq('fromAgent', agentName).eq('status', 'active'))
      .collect();

    const expired: Array<{
      interactionId: string;
      kind: string;
      fromAgent: string;
      toAgent: string;
      fromHeartbeatLine: string;
      toHeartbeatLine: string;
      pendingNoteAgent?: string;
      pendingNote?: string;
    }> = [];
    const seen = new Set<string>();
    for (const interaction of [...received, ...sent]) {
      if (seen.has(interaction._id) || interaction.transactionId || interaction.expiresTick >= tick) continue;
      seen.add(interaction._id);
      const payload = interaction.payloadJson
        ? JSON.parse(interaction.payloadJson) as {
            lastNonResponseAction?: string;
          }
        : {};
      const genericLineForSender = `- Day ${day} ${timeOfDayForTick(tick)}: ${interaction.kind} with ${interaction.toAgent} expired [FAILED] ⚠ No response before tick ${tick}.`;
      const genericLineForRecipient = `- Day ${day} ${timeOfDayForTick(tick)}: ${interaction.kind} with ${interaction.fromAgent} expired [FAILED] ⚠ No response before tick ${tick}.`;
      const senderLine =
        interaction.kind === 'talk' && payload.lastNonResponseAction
          ? `- Day ${day} ${timeOfDayForTick(tick)}: ${interaction.toAgent} turned to other matters before answering.`
          : genericLineForSender;
      const recipientLine =
        interaction.kind === 'talk' && payload.lastNonResponseAction
          ? `- Day ${day} ${timeOfDayForTick(tick)}: You turned to other matters before answering ${interaction.fromAgent}.`
          : genericLineForRecipient;
      const outcomeNote =
        interaction.kind === 'talk' && payload.lastNonResponseAction
          ? `${interaction.toAgent} turned to other matters before answering.`
          : 'Interaction expired without a response.';
      await ctx.db.patch(interaction._id, {
        status: 'expired',
        resolvedTick: tick,
        resolvedDay: day,
        outcomeNote,
      });
      expired.push({
        interactionId: interaction.interactionId,
        kind: interaction.kind,
        fromAgent: interaction.fromAgent,
        toAgent: interaction.toAgent,
        fromHeartbeatLine: senderLine,
        toHeartbeatLine: recipientLine,
        pendingNoteAgent: interaction.fromAgent,
        pendingNote: outcomeNote,
      });
    }

    return expired;
  },
});

// ── Convex query -- snapshot of everything an agent needs ────────────────────

export const getWorldSnapshot = internalQuery({
  args: { agentName: v.string(), tick: v.number(), day: v.number() },
  handler: async (ctx, { agentName, tick, day }) => {
    const agent = await ctx.db
      .query('rl_agents')
      .withIndex('name', (q) => q.eq('name', agentName))
      .unique();
    if (!agent) return null;

    // Nearby agents (at same location)
    const nearby = await ctx.db
      .query('rl_agents')
      .withIndex('location', (q) => q.eq('location', agent.location))
      .collect();

    // Market prices
    const prices = await ctx.db.query('rl_market_prices').collect();

    // Active world events
    const events = await ctx.db
      .query('rl_world_events')
      .withIndex('active', (q) => q.eq('active', true))
      .order('desc')
      .take(10);

    // Location message board
    const location = await ctx.db
      .query('rl_locations')
      .withIndex('name', (q) => q.eq('name', agent.location))
      .unique();
    const allLocations = await ctx.db.query('rl_locations').collect();
    const fieldsHere = await ctx.db
      .query('rl_fields')
      .withIndex('location', (q) => q.eq('location', agent.location))
      .collect();
    const herbPatchesHere = await ctx.db
      .query('rl_herb_patches')
      .withIndex('location', (q) => q.eq('location', agent.location))
      .collect();

    // Recent trade activity (last 5 actions involving trades)
    const recentTrades = await ctx.db
      .query('rl_actions_log')
      .withIndex('tick', (q) => q.gt('tick', tick - 10))
      .filter((q) =>
        q.or(
          q.eq(q.field('action'), 'buy'),
          q.eq(q.field('action'), 'sell'),
          q.eq(q.field('action'), 'trade'),
        ),
      )
      .order('desc')
      .take(5);

    // Mentions of this agent in recent actions (others talking to/about them)
    const mentions = await ctx.db
      .query('rl_actions_log')
      .withIndex('tick', (q) => q.gt('tick', tick - 6))
      .filter((q) => q.eq(q.field('target'), agentName))
      .order('desc')
      .take(5);

    const recentLocalSpeech = await ctx.db
      .query('rl_actions_log')
      .withIndex('tick', (q) => q.gt('tick', tick - 3))
      .filter((q) =>
        q.and(
          q.eq(q.field('action'), 'say'),
          q.eq(q.field('location'), agent.location),
        ),
      )
      .order('desc')
      .take(5);

    // Reputation score for this agent
    const reputation = await ctx.db
      .query('rl_reputation')
      .withIndex('agentName', (q) => q.eq('agentName', agentName))
      .unique();

    const incomingTransactions = await ctx.db
      .query('rl_transactions')
      .withIndex('recipient_status', (q) => q.eq('toAgent', agentName).eq('status', 'pending'))
      .collect();
    const outgoingTransactions = await ctx.db
      .query('rl_transactions')
      .withIndex('sender_status', (q) => q.eq('fromAgent', agentName).eq('status', 'pending'))
      .collect();

    const receivedInteractions = await ctx.db
      .query('rl_interactions')
      .withIndex('recipient_status', (q) => q.eq('toAgent', agentName).eq('status', 'active'))
      .collect();
    const sentInteractions = await ctx.db
      .query('rl_interactions')
      .withIndex('sender_status', (q) => q.eq('fromAgent', agentName).eq('status', 'active'))
      .collect();
    const liveChatScenes = await ctx.db
      .query('rl_chat_scenes')
      .withIndex('status_location', (q) => q.eq('status', 'live').eq('location', agent.location))
      .collect();
    const currentChatScene = liveChatScenes.find((scene) => scene.agentA === agentName || scene.agentB === agentName) ?? null;

    const counterpartNames = Array.from(new Set([
      ...incomingTransactions.map((txn) => txn.fromAgent),
      ...outgoingTransactions.map((txn) => txn.toAgent),
      ...receivedInteractions.filter((interaction) => interaction.kind !== 'talk').map((interaction) => interaction.fromAgent),
      ...sentInteractions.filter((interaction) => interaction.kind !== 'talk').map((interaction) => interaction.toAgent),
      ...liveChatScenes.flatMap((scene) => [scene.agentA, scene.agentB]),
    ]));
    const proposers = await Promise.all(
      counterpartNames.map((name) =>
        ctx.db.query('rl_agents').withIndex('name', (q) => q.eq('name', name)).unique(),
      ),
    );
    const proposerByName = new Map(
      proposers.filter(Boolean).map((agent) => [agent!.name, agent!]),
    );

    const orderTransactions = (transactions: any[], counterpartField: 'fromAgent' | 'toAgent') =>
      transactions
        .slice()
        .sort((a, b) =>
          a.createdDay - b.createdDay
          || a.createdTick - b.createdTick
          || a[counterpartField].localeCompare(b[counterpartField]),
        );

    const actionableIncomingTransactions = incomingTransactions.filter((txn) =>
      proposerByName.get(txn.fromAgent)?.location === agent.location,
    );
    const actionableOutgoingTransactions = outgoingTransactions.filter((txn) =>
      proposerByName.get(txn.toAgent)?.location === agent.location,
    );

    const orderedIncomingTransactions = orderTransactions(actionableIncomingTransactions, 'fromAgent');
    const orderedOutgoingTransactions = orderTransactions(actionableOutgoingTransactions, 'toAgent');

    const nearbyOthers = nearby.filter((a) => a.name !== agentName);
    const reachableLocations = allLocations
      .map((entry) => entry.name)
      .filter((name) => name !== agent.location)
      .sort((a, b) => a.localeCompare(b));

    const socialKnowledge = await ctx.db
      .query('rl_social_knowledge')
      .withIndex('observer', (q) => q.eq('observerAgent', agentName))
      .collect();

    const sentChatMessages = await ctx.db
      .query('rl_chat_messages')
      .withIndex('sender_sent', (q) => q.eq('fromAgent', agentName))
      .collect();
    const receivedChatMessages = await ctx.db
      .query('rl_chat_messages')
      .withIndex('recipient_sent', (q) => q.eq('toAgent', agentName))
      .collect();
    const allChatMessages = [...sentChatMessages, ...receivedChatMessages]
      .sort((a, b) => a.sentDay - b.sentDay || a.sentTick - b.sentTick);

    const knownContactNames = Array.from(new Set([
      ...socialKnowledge.map((entry) => entry.subjectAgent),
      ...allChatMessages.map((entry) => (entry.fromAgent === agentName ? entry.toAgent : entry.fromAgent)),
    ]));

    const knownContacts = await Promise.all(
      knownContactNames.map(async (name) => {
        const contactAgent = await ctx.db
          .query('rl_agents')
          .withIndex('name', (q) => q.eq('name', name))
          .unique();
        const knowledge = socialKnowledge.find((entry) => entry.subjectAgent === name);
        if (!contactAgent || !knowledge) {
          return contactAgent
            ? {
                name: contactAgent.name,
                role: contactAgent.role,
                location: contactAgent.location,
                knownRole: contactAgent.role,
              }
            : null;
        }
        return {
          name: contactAgent.name,
          role: contactAgent.role,
          location: contactAgent.location,
          knownRole: knowledge.knownRole,
        };
      }),
    );

    const chatThreads = knownContacts
      .filter(Boolean)
      .map((contact) => {
        const threadKey = createChatThreadKey(agentName, contact!.name);
        const threadMessages = allChatMessages.filter((entry) => entry.threadKey === threadKey);
        const lastMessage = threadMessages[threadMessages.length - 1] ?? null;
        const unreadCount = threadMessages.filter((entry) =>
          entry.toAgent === agentName && entry.fromAgent === contact!.name && entry.status === 'unread').length;
        const liveScene = currentChatScene
          && (currentChatScene.agentA === contact!.name || currentChatScene.agentB === contact!.name)
          ? currentChatScene
          : null;
        return {
          name: contact!.name,
          role: contact!.role,
          online: contact!.location === agent.location,
          live: Boolean(liveScene),
          yourTurn: liveScene ? liveScene.nextSpeaker === agentName : false,
          unreadCount,
          preview: lastMessage?.text ?? '(no messages yet)',
          messages: threadMessages.slice(-10).map((entry) => ({
            fromAgent: entry.fromAgent,
            toAgent: entry.toAgent,
            text: entry.text,
            deliveryMode: entry.deliveryMode,
            status: entry.status,
            sentDay: entry.sentDay,
            sentTick: entry.sentTick,
          })),
        };
      })
      .sort((a, b) => {
        const unreadDelta = b.unreadCount - a.unreadCount;
        if (unreadDelta !== 0) return unreadDelta;
        if (a.online !== b.online) return a.online ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    return {
      agent,
      nearby: nearbyOthers,
      reachableLocations,
      prices,
      events,
      locationDoc: location,
      fieldsHere,
      herbPatchesHere,
      recentTrades,
      mentions,
      recentLocalSpeech,
      reputation,
      incomingTransactions: orderedIncomingTransactions.map((txn, index) => ({
        ...txn,
        responseRef: `offer-${index + 1}`,
        proposerLocation: proposerByName.get(txn.fromAgent)?.location ?? null,
      })),
      outgoingTransactions: orderedOutgoingTransactions.map((txn) => ({
        ...txn,
        recipientLocation: proposerByName.get(txn.toAgent)?.location ?? null,
      })),
      activeInteractions: [...receivedInteractions, ...sentInteractions]
        .filter((interaction) => interaction.kind !== 'talk')
        .map((interaction) => ({
        ...interaction,
        counterpart: interaction.fromAgent === agentName ? interaction.toAgent : interaction.fromAgent,
        counterpartLocation: proposerByName.get(
          interaction.fromAgent === agentName ? interaction.toAgent : interaction.fromAgent,
        )?.location ?? null,
      })),
      localActiveTalks: liveChatScenes.map((scene) => ({
        fromAgent: scene.agentA,
        toAgent: scene.agentB,
        location: scene.location,
        nextSpeaker: scene.nextSpeaker,
      })),
      currentChatScene: currentChatScene
        ? {
            sceneId: currentChatScene.sceneId,
            partner: currentChatScene.agentA === agentName ? currentChatScene.agentB : currentChatScene.agentA,
            location: currentChatScene.location,
            nextSpeaker: currentChatScene.nextSpeaker,
            yourTurn: currentChatScene.nextSpeaker === agentName,
          }
        : null,
      socialKnowledge,
      chatThreads,
      economicSurface: buildEconomicSurface({
        agent,
        nearby: nearbyOthers,
        fieldsHere,
        herbPatchesHere,
        prices,
        reachableLocations,
      }),
      tradeOpportunities: buildTradeOpportunities({
        agent,
        nearby: nearbyOthers,
      }),
      workspacePath: agent.workspacePath,
    };
  },
});

// ── File builders ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Snapshot = any; // typed loosely; Convex _generated types handle validation at runtime

function buildInventoryMd(agentName: string, day: number, data: any): string {
  const inv = JSON.parse(data.agent.inventory) as Record<string, number>;
  const lines = Object.entries(inv)
    .map(([item, qty]) => `${item.padEnd(12)} ${qty} units`)
    .join('\n');
  return `# Inventory -- ${agentName} -- Day ${day}\n\n${lines}\ncoin:         ${data.agent.coin}c\n`;
}

function buildLocationMd(
  agentName: string,
  day: number,
  timeOfDay: string,
  data: any,
  letters: any[] = [],
): string {
  const nearbyLines = data.nearby.length === 0
    ? '  (nobody nearby)'
    : data.nearby.map((a: any) => `  - ${a.name} (${a.role})`).join('\n');

  const board = data.locationDoc?.messageBoard
    ? JSON.parse(data.locationDoc.messageBoard) as string[]
    : [];
  const boardLines = board.length === 0
    ? '  (none)'
    : board.map((m: string) => `  - ${m}`).join('\n');

  const sections = [
    `# Location -- ${agentName} -- Day ${day}, ${timeOfDay}`,
    '',
    `Current: ${data.agent.location}`,
    'Nearby:',
    nearbyLines,
    '',
    'Message board:',
    boardLines,
    '',
  ];

  const pendingOffers = Array.isArray(data.pendingTransactions) ? data.pendingTransactions : [];
  const pendingOfferLines = pendingOffers.length === 0
    ? '  (none)'
    : pendingOffers.map((txn: any) => {
        const offer = JSON.parse(txn.offerJson) as Array<{ item: string; quantity: number }>;
        const request = JSON.parse(txn.requestJson) as Array<{ item: string; quantity: number }>;
        const offerText = offer.length === 0 ? 'nothing' : offer.map((entry) => `${entry.quantity} ${entry.item}`).join(', ');
        const requestText = request.length === 0 ? 'nothing' : request.map((entry) => `${entry.quantity} ${entry.item}`).join(', ');
        const locationNote = txn.proposerLocation === data.agent.location
          ? ''
          : ` [${txn.fromAgent} is no longer here]`;
        const messageNote = txn.message ? ` -- "${txn.message}"` : '';
        return `  - ${txn.txnId}: ${txn.fromAgent} offers ${offerText} for ${requestText}; expires tick ${txn.expiresTick}${locationNote}${messageNote}`;
      }).join('\n');

  sections.push('Pending offers here:');
  sections.push(pendingOfferLines);
  sections.push('');

  if (data.agent.pendingNote) {
    sections.push('From last tick:');
    sections.push(`  ${data.agent.pendingNote}`);
    sections.push('');
  }

  return sections.join('\n');
}

function buildVillageNewsMd(day: number, data: any): string {
  const eventLines = data.events.length === 0
    ? '  Nothing unusual to report.'
    : data.events.map((e: any) => `  - ${e.description}`).join('\n');

  const mentionLines = data.mentions.length === 0
    ? '  - Nothing yet.'
    : data.mentions.map((m: any) => `  - ${m.agentName} ${m.action}${m.target ? ` → ${m.target}` : ''}${m.message ? `: "${m.message}"` : ''}`).join('\n');

  return [
    `# Village News -- Day ${day}`,
    '',
    eventLines,
    '',
    'You were mentioned:',
    mentionLines,
    '',
  ].join('\n');
}

function buildMarketPricesMd(day: number, data: any): string {
  const prices = data.prices as any[];
  const header = `# Rocklaw Market -- Day ${day}\n\n${'Item'.padEnd(14)}${'Price'.padEnd(9)}${'Change'.padEnd(10)}Note`;
  const rows = prices.map((p: any) => {
    const changeStr = p.changePct === 0 ? 'stable' : `${p.changePct > 0 ? '+' : ''}${Math.round(p.changePct)}%`;
    const noteStr = p.shortageLevel !== 'none' ? `${p.shortageLevel.toUpperCase()} shortage` : '';
    return `${p.item.padEnd(14)}${String(p.price + 'c').padEnd(9)}${changeStr.padEnd(10)}${noteStr}`;
  });

  const alerts = prices.filter((p: any) => p.shortageLevel !== 'none');
  const alertLines = alerts.length === 0
    ? '  (none)'
    : alerts.map((p: any) => `  ! ${p.item}: ${p.shortageLevel.toUpperCase()}`).join('\n');

  const tradeLogs = data.recentTrades as any[];
  const tradeLines = tradeLogs.length === 0
    ? '  (none yet)'
    : tradeLogs.map((t: any) => `  - ${t.agentName} ${t.action} ${t.target ?? ''} (Day ${t.day})`).join('\n');

  return [header, rows.join('\n'), '', 'Shortage alerts:', alertLines, '', 'Recent trades:', tradeLines, ''].join('\n');
}

function buildStatusMd(agentName: string, day: number, timeOfDay: string, data: any): string {
  const { energy, health, hunger } = data.agent;
  const energyLabel = energy < 15 ? '[EXHAUSTED -- demanding actions will FAIL until you rest]'
    : energy < 30 ? '[CRITICAL -- rest before demanding work]'
    : energy < 50 ? '[low -- demanding actions may fail]'
    : '[fine]';
  const healthLabel = health < 30 ? '[POOR -- you need treatment urgently]'
    : health < 70 ? '[injured -- take care of yourself]'
    : '[fine]';
  const hungerLabel = hunger > 80 ? '[STARVING -- health will degrade if you don\'t eat]'
    : hunger > 60 ? '[hungry -- eat soon]'
    : hunger > 40 ? '[getting hungry]'
    : '[fine]';

  const conditions: string[] = [];
  if (energy === 0) conditions.push('Sustained exhaustion: health is degrading each tick. SLEEP NOW.');
  if (health < 30) conditions.push('Poor health: your body is failing. Seek treatment and rest.');
  if (hunger > 80) conditions.push('Starving: health will degrade until you eat.');
  const conditionLine = conditions.length === 0 ? 'none' : conditions.map((c) => `  ! ${c}`).join('\n');

  // Reputation section
  const repScore = data.reputation?.score ?? 50;
  const repLabel = repScore >= 70 ? '[RESPECTED -- you receive discounts and open doors]'
    : repScore >= 50 ? '[neutral]'
    : repScore >= 30 ? '[mixed -- some distrust you]'
    : repScore >= 20 ? '[poor -- merchants charge you more]'
    : '[NOTORIOUS -- you will be refused service at inn, shrine, and market]';
  const repWarning = repScore < 20
    ? '\n  ! Your reputation is too low for service at social locations. Improve it through helpful actions.'
    : repScore < 30
    ? '\n  ! Low reputation: you pay 10% more at market. Help others to improve your standing.'
    : '';

  return [
    `# Status -- ${agentName} -- Day ${day}, ${timeOfDay}`,
    '',
    `Energy:     ${energy}/100  ${energyLabel}`,
    `Health:     ${health}/100  ${healthLabel}`,
    `Hunger:     ${hunger}/100  ${hungerLabel}`,
    `Reputation: ${repScore}/100  ${repLabel}${repWarning}`,
    '',
    `Conditions: ${conditionLine}`,
    '',
  ].join('\n');
}
