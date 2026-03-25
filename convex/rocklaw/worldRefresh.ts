/**
 * World Refresh -- writes the agent's world/ files from Convex state
 * before each tick fires. The agent reads these files as "reality".
 *
 * Also handles HEARTBEAT.md appends (world engine only, never the agent).
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery } from '../_generated/server';

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
    }

    return expired.map((txn) => ({
      txnId: txn.txnId,
      fromAgent: txn.fromAgent,
      kind: txn.kind,
    }));
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

    // Reputation score for this agent
    const reputation = await ctx.db
      .query('rl_reputation')
      .withIndex('agentName', (q) => q.eq('agentName', agentName))
      .unique();

    const pendingTransactions = await ctx.db
      .query('rl_transactions')
      .withIndex('recipient_status', (q) => q.eq('toAgent', agentName).eq('status', 'pending'))
      .collect();

    const proposerNames = Array.from(new Set(pendingTransactions.map((txn) => txn.fromAgent)));
    const proposers = await Promise.all(
      proposerNames.map((name) =>
        ctx.db.query('rl_agents').withIndex('name', (q) => q.eq('name', name)).unique(),
      ),
    );
    const proposerByName = new Map(
      proposers.filter(Boolean).map((agent) => [agent!.name, agent!]),
    );

    return {
      agent,
      nearby: nearby.filter((a) => a.name !== agentName),
      prices,
      events,
      locationDoc: location,
      recentTrades,
      mentions,
      reputation,
      pendingTransactions: pendingTransactions.map((txn) => ({
        ...txn,
        proposerLocation: proposerByName.get(txn.fromAgent)?.location ?? null,
      })),
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

  const letterLines = letters.length === 0
    ? '  (none)'
    : letters.map((l: any) =>
        `  From ${l.fromAgent} (Day ${l.daySent}):\n  "${l.content}"`,
      ).join('\n\n');

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
    'Letters waiting for you here:',
    letterLines,
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
