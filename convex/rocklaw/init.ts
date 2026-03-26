/**
 * Rocklaw init -- seeds the Convex database with the starter village.
 * Run once: npx convex run rocklaw/init:initRocklaw
 */

import { mutation, internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { v } from 'convex/values';

// Agent roster with initial state
const AGENT_ROSTER = [
  {
    name: 'Elena Voss',
    role: 'Blacksmith',
    location: 'forge',
    inventory: JSON.stringify({ iron_ore: 5, coal: 8, bread: 2 }),
    coin: 20,
    gatewayPort: 42617,
    workspacePath: 'agents/elena/workspace',
  },
  {
    name: 'Marcus Hale',
    role: 'Merchant',
    location: 'market',
    inventory: JSON.stringify({ coal: 20, grain: 5, coin_purse: 1 }),
    coin: 80,
    gatewayPort: 42618,
    workspacePath: 'agents/marcus/workspace',
  },
  {
    name: 'Finn',
    role: 'Farmer',
    location: 'farm',
    inventory: JSON.stringify({ grain: 15, iron_ore: 8, vegetables: 10 }),
    coin: 30,
    gatewayPort: 42619,
    workspacePath: 'agents/finn/workspace',
  },
  {
    name: 'Lena Marsh',
    role: 'Herbalist',
    location: 'shrine',
    inventory: JSON.stringify({ herbs: 12, medicine: 5, bread: 1 }),
    coin: 15,
    gatewayPort: 42620,
    workspacePath: 'agents/lena/workspace',
  },
  {
    name: 'Sera',
    role: 'Innkeeper',
    location: 'inn',
    inventory: JSON.stringify({ bread: 10, grain: 8, ale: 5 }),
    coin: 45,
    gatewayPort: 42621,
    workspacePath: 'agents/sera/workspace',
  },
  {
    name: 'Brother Aldric',
    role: 'Priest',
    location: 'shrine',
    inventory: JSON.stringify({ bread: 3 }),
    coin: 10,
    gatewayPort: 42622,
    workspacePath: 'agents/aldric/workspace',
  },
  {
    name: 'Cora',
    role: 'Child',
    location: 'square',
    inventory: JSON.stringify({ bread: 1 }),
    coin: 2,
    gatewayPort: 42623,
    workspacePath: 'agents/cora/workspace',
  },
  {
    name: 'Old Rook',
    role: 'Retired Soldier',
    location: 'square',
    inventory: JSON.stringify({ medicine: 2, bread: 1 }),
    coin: 12,
    gatewayPort: 42624,
    workspacePath: 'agents/rook/workspace',
  },
];

const LOCATIONS = [
  { name: 'forge',  type: 'workshop', capacity: 4 },
  { name: 'market', type: 'commerce', capacity: 20 },
  { name: 'inn',    type: 'social',   capacity: 30 },
  { name: 'farm',   type: 'work',     capacity: 8 },
  { name: 'shrine', type: 'social',   capacity: 15 },
  { name: 'gate',   type: 'transit',  capacity: 10 },
  { name: 'square', type: 'social',   capacity: 50 },
];

export const initRocklaw = mutation({
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    // Guard: don't run twice unless forced
    const existing = await ctx.db.query('rl_world_state').first();
    if (existing && !force) {
      console.log('[init] Rocklaw already initialised. Pass force: true to reinitialise.');
      return { status: 'already_initialised' };
    }

    if (force) {
      await clearRocklawTables(ctx);
    }

    // World state
    const worldState = await ctx.db.query('rl_world_state').first();
    if (worldState) {
      await ctx.db.patch(worldState._id, { tick: 0, day: 1, timeOfDay: 'morning', isRunning: false });
    } else {
      await ctx.db.insert('rl_world_state', { tick: 0, day: 1, timeOfDay: 'morning', isRunning: false });
    }

    // Locations
    for (const loc of LOCATIONS) {
      const existingLoc = await ctx.db
        .query('rl_locations')
        .withIndex('name', (q) => q.eq('name', loc.name))
        .unique();
      if (existingLoc) {
        await ctx.db.patch(existingLoc._id, { ...loc, presentAgents: '[]', messageBoard: '[]' });
      } else {
        await ctx.db.insert('rl_locations', { ...loc, presentAgents: '[]', messageBoard: '[]' });
      }
    }

    // Agents
    for (const agentData of AGENT_ROSTER) {
      const existingAgent = await ctx.db
        .query('rl_agents')
        .withIndex('name', (q) => q.eq('name', agentData.name))
        .unique();

      const fields = {
        ...agentData,
        energy: 100,
        health: 100,
        hunger: 0,
        currentDay: 1,
        busy: false,
        blankSelf: false,
      };

      if (existingAgent) {
        await ctx.db.patch(existingAgent._id, fields);
      } else {
        await ctx.db.insert('rl_agents', fields);
      }
    }

    // Seed reputation for all agents at neutral score (50)
    for (const agentData of AGENT_ROSTER) {
      const existingRep = await ctx.db
        .query('rl_reputation')
        .withIndex('agentName', (q) => q.eq('agentName', agentData.name))
        .unique();
      if (existingRep && force) {
        await ctx.db.patch(existingRep._id, { score: 50, recentIncidents: '[]' });
      } else if (!existingRep) {
        await ctx.db.insert('rl_reputation', {
          agentName: agentData.name,
          score: 50,
          recentIncidents: '[]',
        });
      }
    }

    // Seed initial market prices
    await ctx.scheduler.runAfter(0, internal.rocklaw.priceEngine.recalculate, {});

    // Register Rocklaw agents in the AI Town visual layer (1s delay for world to be ready)
    await ctx.scheduler.runAfter(1000, internal.rocklaw.visualBridge.initVisualAgents, {});

    console.log('[init] Rocklaw initialised. 8 villagers, 7 locations, market prices seeded.');
    return { status: 'ok', agents: AGENT_ROSTER.length, locations: LOCATIONS.length };
  },
});

async function clearRocklawTables(ctx: any) {
  await deleteAll(ctx, 'rl_social_knowledge');
  await deleteAll(ctx, 'rl_interactions');
  await deleteAll(ctx, 'rl_transactions');
  await deleteAll(ctx, 'rl_messages');
  await deleteAll(ctx, 'rl_actions_log');
  await deleteAll(ctx, 'rl_prayers');
  await deleteAll(ctx, 'rl_world_events');
  await deleteAll(ctx, 'rl_price_history');
  await deleteAll(ctx, 'rl_market_prices');
  await deleteAll(ctx, 'rl_reputation');
  await deleteAll(ctx, 'rl_locations');
  await deleteAll(ctx, 'rl_agents');
  await deleteAll(ctx, 'rl_systems_state');
  await deleteAll(ctx, 'rl_world_state');
}

async function deleteAll(ctx: any, table: string) {
  const rows = await ctx.db.query(table).collect();
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
}

export const setWorkspaceRoot = mutation({
  args: { rootPath: v.string() },
  handler: async (ctx, { rootPath }) => {
    const agents = await ctx.db.query('rl_agents').collect();
    let updated = 0;

    for (const agent of agents) {
      const suffix = extractWorkspaceSuffix(agent.workspacePath);
      if (!suffix) continue;
      const nextPath = joinRootAndSuffix(rootPath, suffix);
      if (agent.workspacePath !== nextPath) {
        await ctx.db.patch(agent._id, { workspacePath: nextPath });
        updated += 1;
      }
    }

    return { updated };
  },
});

export const setAllAgentsBlankProfile = mutation({
  args: { blankSelf: v.boolean() },
  handler: async (ctx, { blankSelf }) => {
    const agents = await ctx.db.query('rl_agents').collect();
    for (const agent of agents) {
      await ctx.db.patch(agent._id, { blankSelf });
    }
    return { updated: agents.length, blankSelf };
  },
});

export const setAgentBlankProfile = mutation({
  args: { agentName: v.string(), blankSelf: v.boolean() },
  handler: async (ctx, { agentName, blankSelf }) => {
    const agent = await ctx.db
      .query('rl_agents')
      .withIndex('name', (q) => q.eq('name', agentName))
      .unique();
    if (!agent) return { updated: 0, blankSelf };
    await ctx.db.patch(agent._id, { blankSelf });
    return { updated: 1, blankSelf };
  },
});

// Convenience: tick the simulation forward by one step (morning → afternoon → evening → next day morning)
export const advanceTick = internalMutation({
  args: {},
  handler: async (ctx) => {
    const state = await ctx.db.query('rl_world_state').unique();
    if (!state) return;

    const timeOrder = ['morning', 'afternoon', 'evening'] as const;
    const currentIdx = timeOrder.indexOf(state.timeOfDay as any);

    let nextTick = state.tick + 1;
    let nextDay = state.day;
    let nextTime: 'morning' | 'afternoon' | 'evening';

    if (currentIdx === 2) {
      nextTime = 'morning';
      nextDay = state.day + 1;
    } else {
      nextTime = timeOrder[currentIdx + 1];
    }

    await ctx.db.patch(state._id, { tick: nextTick, day: nextDay, timeOfDay: nextTime });
    return { tick: nextTick, day: nextDay, timeOfDay: nextTime };
  },
});

function extractWorkspaceSuffix(workspacePath: string): string | null {
  const normalized = workspacePath.replace(/\\/g, '/');
  const marker = '/agents/';
  if (normalized.startsWith('agents/')) return normalized;
  const idx = normalized.indexOf(marker);
  if (idx >= 0) {
    return normalized.slice(idx + 1);
  }
  return null;
}

function joinRootAndSuffix(rootPath: string, suffix: string): string {
  const cleanRoot = rootPath.replace(/[\\/]+$/, '');
  const cleanSuffix = suffix.replace(/^[\\/]+/, '').replace(/\\/g, '/');
  return `${cleanRoot}/${cleanSuffix}`;
}
