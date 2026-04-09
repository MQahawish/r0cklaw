/**
 * Rocklaw init -- seeds the Convex database with the starter village.
 * Run once: npx convex run rocklaw/init:initRocklaw
 */

import { mutation, internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { v } from 'convex/values';
import {
  SEEDED_FIELDS,
  SEEDED_HERB_PATCHES,
  SEEDED_PLACE_MARKETS,
  SEEDED_PLACE_STOCKS,
  canonicalizeItemEntries,
  canonicalizeItemQuantities,
  canonicalizeItemId,
} from './economy';
import { AGENT_PROFILE_SEEDS, defaultAgentProfileFor } from './agentProfiles';
import { DayPeriod, nextDayPeriod } from './dayCycle';

// Agent roster with initial state
const AGENT_ROSTER = [
  {
    name: 'Elena Voss',
    role: 'Blacksmith',
    location: 'elena_home',
    inventory: JSON.stringify({ iron_ore: 5, coal: 8, bread: 2 }),
    coin: 20,
    gatewayPort: 42617,
    workspacePath: 'agents/elena/workspace',
  },
  {
    name: 'Marcus Hale',
    role: 'Merchant',
    location: 'marcus_home',
    inventory: JSON.stringify({ coal: 20, grain: 5, coin_purse: 1 }),
    coin: 80,
    gatewayPort: 42618,
    workspacePath: 'agents/marcus/workspace',
  },
  {
    name: 'Finn',
    role: 'Farmer',
    location: 'finn_home',
    inventory: JSON.stringify({ grain: 15, iron_ore: 8, vegetable: 10 }),
    coin: 30,
    gatewayPort: 42619,
    workspacePath: 'agents/finn/workspace',
  },
  {
    name: 'Lena Marsh',
    role: 'Herbalist',
    location: 'lena_home',
    inventory: JSON.stringify({ herb: 12, medicine: 5, bread: 1 }),
    coin: 15,
    gatewayPort: 42620,
    workspacePath: 'agents/lena/workspace',
  },
  {
    name: 'Sera',
    role: 'Innkeeper',
    location: 'sera_home',
    inventory: JSON.stringify({ bread: 10, grain: 8, ale: 5 }),
    coin: 45,
    gatewayPort: 42621,
    workspacePath: 'agents/sera/workspace',
  },
];

const LOCATIONS = [
  { name: 'elena_home', type: 'residence', capacity: 2 },
  { name: 'marcus_home', type: 'residence', capacity: 2 },
  { name: 'finn_home', type: 'residence', capacity: 2 },
  { name: 'lena_home', type: 'residence', capacity: 2 },
  { name: 'sera_home', type: 'residence', capacity: 2 },
  { name: 'forge',  type: 'workshop', capacity: 4 },
  { name: 'market', type: 'commerce', capacity: 20 },
  { name: 'inn',    type: 'social',   capacity: 30 },
  { name: 'farm',   type: 'work',     capacity: 8 },
  { name: 'shrine', type: 'social',   capacity: 15 },
  { name: 'gate',   type: 'transit',  capacity: 10 },
  { name: 'square', type: 'social',   capacity: 50 },
  { name: 'mine',   type: 'work',      capacity: 6, tags: ['extractive', 'commerce'] },
  { name: 'bakery', type: 'workshop',  capacity: 8, tags: ['food', 'commerce'] },
  { name: 'warehouse', type: 'commerce', capacity: 12, tags: ['storage', 'commerce'] },
];

export const initRocklaw = mutation({
  args: { force: v.optional(v.boolean()), agentNames: v.optional(v.array(v.string())) },
  handler: async (ctx, { force, agentNames }) => {
    await ensureCanonicalItemIdsInternal(ctx);

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
    const ELDERS_DAY = 30;
    const worldState = await ctx.db.query('rl_world_state').first();
    if (worldState) {
      await ctx.db.patch(worldState._id, { tick: 0, day: 1, timeOfDay: 'dawn', isRunning: false, eldersDay: ELDERS_DAY });
    } else {
      await ctx.db.insert('rl_world_state', { tick: 0, day: 1, timeOfDay: 'dawn', isRunning: false, eldersDay: ELDERS_DAY });
    }

    // Locations
    for (const loc of LOCATIONS) {
      const existingLoc = await ctx.db
        .query('rl_locations')
        .withIndex('name', (q) => q.eq('name', loc.name))
        .unique();
      if (existingLoc) {
        await ctx.db.patch(existingLoc._id, { ...loc, tags: (loc as any).tags ?? undefined, presentAgents: '[]', messageBoard: '[]' });
      } else {
        await ctx.db.insert('rl_locations', { ...loc, tags: (loc as any).tags ?? undefined, presentAgents: '[]', messageBoard: '[]' });
      }
    }

    // Production state
    for (const field of SEEDED_FIELDS) {
      const existingField = await ctx.db
        .query('rl_fields')
        .withIndex('fieldKey', (q) => q.eq('fieldKey', field.fieldKey))
        .unique();
      if (existingField) {
        await ctx.db.patch(existingField._id, field);
      } else {
        await ctx.db.insert('rl_fields', field);
      }
    }

    for (const patch of SEEDED_HERB_PATCHES) {
      const existingPatch = await ctx.db
        .query('rl_herb_patches')
        .withIndex('patchKey', (q) => q.eq('patchKey', patch.patchKey))
        .unique();
      if (existingPatch) {
        await ctx.db.patch(existingPatch._id, patch);
      } else {
        await ctx.db.insert('rl_herb_patches', patch);
      }
    }

    for (const stock of SEEDED_PLACE_STOCKS) {
      const existingStock = await ctx.db
        .query('rl_place_stocks')
        .withIndex('place_item', (q) => q.eq('placeName', stock.placeName).eq('item', stock.item))
        .unique();
      if (existingStock) {
        await ctx.db.patch(existingStock._id, stock);
      } else {
        await ctx.db.insert('rl_place_stocks', stock);
      }
    }

    for (const market of SEEDED_PLACE_MARKETS) {
      const existingMarket = await ctx.db
        .query('rl_place_markets')
        .withIndex('placeName', (q) => q.eq('placeName', market.placeName))
        .unique();
      if (existingMarket) {
        await ctx.db.patch(existingMarket._id, market);
      } else {
        await ctx.db.insert('rl_place_markets', market);
      }
    }

    const selectedRoster = Array.isArray(agentNames) && agentNames.length > 0
      ? AGENT_ROSTER.filter((agent) => agentNames.includes(agent.name))
      : AGENT_ROSTER;

    if (selectedRoster.length === 0) {
      throw new Error('[init] No matching agents in roster for requested agentNames.');
    }

    // Agents
    for (const agentData of selectedRoster) {
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

      const existingProfile = await ctx.db
        .query('rl_agent_profiles')
        .withIndex('agentName', (q) => q.eq('agentName', agentData.name))
        .unique();
      const profileSeed = AGENT_PROFILE_SEEDS[agentData.name] ?? defaultAgentProfileFor(agentData.name, agentData.role);
      const profileFields = {
        agentName: agentData.name,
        coreNature: profileSeed.coreNature,
        whatMattersMost: profileSeed.whatMattersMost,
        whenTimesAreGood: profileSeed.whenTimesAreGood,
        whenTimesAreTight: profileSeed.whenTimesAreTight,
      };
      if (existingProfile) {
        await ctx.db.patch(existingProfile._id, profileFields);
      } else {
        await ctx.db.insert('rl_agent_profiles', profileFields);
      }
    }

    // Seed reputation for all agents at neutral score (50)
    for (const agentData of selectedRoster) {
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

    // Assign hidden roles (Saboteur, Usurper, Heir)
    await ctx.scheduler.runAfter(0, internal.rocklaw.hiddenRoles.assignHiddenRoles, {
      agentNames: selectedRoster.map((a) => a.name),
      day: 1,
    });

    // Seed initial market prices
    await ctx.scheduler.runAfter(0, internal.rocklaw.priceEngine.recalculate, {});

    // Register Rocklaw agents in the AI Town visual layer (1s delay for world to be ready)
    await ctx.scheduler.runAfter(1000, internal.rocklaw.visualBridge.initVisualAgents, {});

    console.log(`[init] Rocklaw initialised. ${selectedRoster.length} villagers, ${LOCATIONS.length} locations, market prices seeded.`);
    return { status: 'ok', agents: selectedRoster.length, locations: LOCATIONS.length };
  },
});

export const ensureCanonicalItemIds = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ensureCanonicalItemIdsInternal(ctx);
    return { status: 'ok' };
  },
});

async function clearRocklawTables(ctx: any) {
  await deleteAll(ctx, 'rl_hidden_roles');
  await deleteAll(ctx, 'rl_gossip_events');
  await deleteAll(ctx, 'rl_journal_entries');
  await deleteAll(ctx, 'rl_activity_notes');
  await deleteAll(ctx, 'rl_agent_profiles');
  await deleteAll(ctx, 'rl_social_knowledge');
  await deleteAll(ctx, 'rl_fields');
  await deleteAll(ctx, 'rl_herb_patches');
  await deleteAll(ctx, 'rl_interactions');
  await deleteAll(ctx, 'rl_transactions');
  await deleteAll(ctx, 'rl_messages');
  await deleteAll(ctx, 'rl_chat_messages');
  await deleteAll(ctx, 'rl_chat_scenes');
  await deleteAll(ctx, 'rl_actions_log');
  await deleteAll(ctx, 'rl_prayers');
  await deleteAll(ctx, 'rl_world_events');
  await deleteAll(ctx, 'rl_price_history');
  await deleteAll(ctx, 'rl_market_prices');
  await deleteAll(ctx, 'rl_place_markets');
  await deleteAll(ctx, 'rl_place_stocks');
  await deleteAll(ctx, 'rl_reputation');
  await deleteAll(ctx, 'rl_locations');
  await deleteAll(ctx, 'rl_agents');
  await deleteAll(ctx, 'rl_systems_state');
  await deleteAll(ctx, 'rl_world_state');
  await deleteAll(ctx, 'rl_run_tick_summaries');
  await deleteAll(ctx, 'rl_run_console_state');
}

async function deleteAll(ctx: any, table: string) {
  const rows = await ctx.db.query(table).collect();
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
}

async function ensureCanonicalItemIdsInternal(ctx: any) {
  const existing = await ctx.db
    .query('rl_systems_state')
    .withIndex('system', (q: any) => q.eq('systemName', 'migration').eq('key', 'canonical_item_ids_v1'))
    .unique();
  if (existing?.value === 'done') return;

  const agents = await ctx.db.query('rl_agents').collect();
  for (const agent of agents) {
    const inventory = canonicalizeItemQuantities(JSON.parse(agent.inventory ?? '{}') as Record<string, number>);
    await ctx.db.patch(agent._id, { inventory: JSON.stringify(inventory) });
  }

  const fields = await ctx.db.query('rl_fields').collect();
  for (const field of fields) {
    const cropItem = canonicalizeItemId(field.cropItem ?? undefined) ?? field.cropItem;
    if (cropItem !== field.cropItem) {
      await ctx.db.patch(field._id, { cropItem });
    }
  }

  const herbPatches = await ctx.db.query('rl_herb_patches').collect();
  for (const patch of herbPatches) {
    const herbItem = canonicalizeItemId(patch.herbItem) ?? patch.herbItem;
    if (herbItem !== patch.herbItem) {
      await ctx.db.patch(patch._id, { herbItem });
    }
  }

  const placeStocks = await ctx.db.query('rl_place_stocks').collect();
  for (const stock of placeStocks) {
    const item = canonicalizeItemId(stock.item) ?? stock.item;
    if (item !== stock.item) {
      await ctx.db.patch(stock._id, { item });
    }
  }

  const marketPrices = await ctx.db.query('rl_market_prices').collect();
  for (const row of marketPrices) {
    const item = canonicalizeItemId(row.item) ?? row.item;
    if (item !== row.item) {
      await ctx.db.patch(row._id, { item });
    }
  }

  const priceHistory = await ctx.db.query('rl_price_history').collect();
  for (const row of priceHistory) {
    const item = canonicalizeItemId(row.item) ?? row.item;
    if (item !== row.item) {
      await ctx.db.patch(row._id, { item });
    }
  }

  const transactions = await ctx.db.query('rl_transactions').collect();
  for (const txn of transactions) {
    const offer = canonicalizeItemEntries(JSON.parse(txn.offerJson ?? '[]') as Array<{ item: string; quantity: number }>);
    const request = canonicalizeItemEntries(JSON.parse(txn.requestJson ?? '[]') as Array<{ item: string; quantity: number }>);
    await ctx.db.patch(txn._id, {
      offerJson: JSON.stringify(offer),
      requestJson: JSON.stringify(request),
    });
  }

  const interactions = await ctx.db.query('rl_interactions').collect();
  for (const interaction of interactions) {
    const payload = interaction.payloadJson ? JSON.parse(interaction.payloadJson) as Record<string, unknown> : {};
    let changed = false;
    if (Array.isArray(payload.offer)) {
      payload.offer = canonicalizeItemEntries(payload.offer as Array<{ item: string; quantity: number }>);
      changed = true;
    }
    if (Array.isArray(payload.request)) {
      payload.request = canonicalizeItemEntries(payload.request as Array<{ item: string; quantity: number }>);
      changed = true;
    }
    if (changed) {
      await ctx.db.patch(interaction._id, { payloadJson: JSON.stringify(payload) });
    }
  }

  if (existing) {
    await ctx.db.patch(existing._id, { value: 'done', updatedAt: Date.now() });
  } else {
    await ctx.db.insert('rl_systems_state', {
      systemName: 'migration',
      key: 'canonical_item_ids_v1',
      value: 'done',
      updatedAt: Date.now(),
    });
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

// Convenience: tick the simulation forward by one step in the shared 6-period day cycle.
export const advanceTick = internalMutation({
  args: {},
  handler: async (ctx) => {
    const state = await ctx.db.query('rl_world_state').unique();
    if (!state) return;

    let nextTick = state.tick + 1;
    const { nextTime, dayDelta } = nextDayPeriod(state.timeOfDay as DayPeriod);
    const nextDay = state.day + dayDelta;

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
