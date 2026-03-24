/**
 * World Refresh -- writes the agent's world/ files from Convex state
 * before each tick fires. The agent reads these files as "reality".
 *
 * Also handles HEARTBEAT.md appends (world engine only, never the agent).
 */

import { v } from 'convex/values';
import { internalAction, internalMutation, internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';
import * as fs from 'fs/promises';
import * as path from 'path';

// ── Main refresh action ──────────────────────────────────────────────────────

export const refreshWorldFiles = internalAction({
  args: {
    agentName: v.string(),
    tick: v.number(),
    day: v.number(),
    timeOfDay: v.string(),
  },
  handler: async (ctx, { agentName, tick, day, timeOfDay }) => {
    const data = await ctx.runQuery(internal.rocklaw.worldRefresh.getWorldSnapshot, {
      agentName,
      tick,
      day,
    });
    if (!data) {
      console.error(`[worldRefresh] No data for ${agentName}`);
      return;
    }

    // Deliver any unread letters waiting for the agent at their current location,
    // marking them as read so they don't re-appear next tick.
    const letters = await ctx.runMutation(internal.rocklaw.worldRefresh.deliverLetters, {
      agentName,
      locationId: data.locationDoc?._id ?? null,
      day,
    });

    const workspacePath = path.resolve(data.workspacePath, 'world');

    await Promise.all([
      writeFile(workspacePath, 'inventory.md',      buildInventoryMd(agentName, day, data)),
      writeFile(workspacePath, 'location.md',       buildLocationMd(agentName, day, timeOfDay, data, letters)),
      writeFile(workspacePath, 'village_news.md',   buildVillageNewsMd(day, data)),
      writeFile(workspacePath, 'market_prices.md',  buildMarketPricesMd(day, data)),
      writeFile(workspacePath, 'status.md',         buildStatusMd(agentName, day, timeOfDay, data)),
    ]);
  },
});

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

// ── HEARTBEAT append ─────────────────────────────────────────────────────────

export const appendHeartbeat = internalAction({
  args: { agentName: v.string(), line: v.string() },
  handler: async (ctx, { agentName, line }) => {
    const agent = await ctx.runQuery(internal.rocklaw.bridge.getAgent, { agentName });
    if (!agent) return;

    const heartbeatPath = path.resolve(agent.workspacePath, '06_HEARTBEAT.md');

    let existing = '';
    try {
      existing = await fs.readFile(heartbeatPath, 'utf8');
    } catch {
      existing = `# HEARTBEAT -- ${agentName}\n\n## Recent Activity\n`;
    }

    // Parse existing entries and keep only last 6 (we'll add one more = 7 total)
    const lines = existing.split('\n');
    const entries = lines.filter((l) => l.startsWith('- Day'));
    const trimmed = entries.slice(-6);

    const newContent = [
      `# HEARTBEAT -- ${agentName}`,
      '',
      '## Recent Activity',
      ...trimmed,
      line,
      '',
    ].join('\n');

    await fs.writeFile(heartbeatPath, newContent, 'utf8');
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

    return {
      agent,
      nearby: nearby.filter((a) => a.name !== agentName),
      prices,
      events,
      locationDoc: location,
      recentTrades,
      mentions,
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

  return [
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
  ].join('\n');
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

  return [
    `# Status -- ${agentName} -- Day ${day}, ${timeOfDay}`,
    '',
    `Energy:  ${energy}/100  ${energyLabel}`,
    `Health:  ${health}/100  ${healthLabel}`,
    `Hunger:  ${hunger}/100  ${hungerLabel}`,
    '',
    `Conditions: ${conditionLine}`,
    '',
  ].join('\n');
}

async function writeFile(dir: string, filename: string, content: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), content, 'utf8');
}
