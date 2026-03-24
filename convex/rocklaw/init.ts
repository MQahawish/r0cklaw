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

    // World state
    if (existing) {
      await ctx.db.patch(existing._id, { tick: 0, day: 1, timeOfDay: 'morning', isRunning: false });
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
      };

      if (existingAgent) {
        await ctx.db.patch(existingAgent._id, fields);
      } else {
        await ctx.db.insert('rl_agents', fields);
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
