import { internalMutation } from '../_generated/server';
import { v } from 'convex/values';

export type ItemCategory = 'raw' | 'food' | 'crafted' | 'medicine' | 'material' | 'service';
export type StationType = 'forge' | 'farm' | 'inn' | 'market' | 'mine' | 'bakery' | 'warehouse';
export type FieldStage = 'fallow' | 'growing' | 'ready';

export type ItemDef = {
  id: string;
  category: ItemCategory;
  edible?: boolean;
  hungerRestore?: number;
};

export type RecipeDef = {
  action: 'craft' | 'smelt' | 'brew';
  output: string;
  location: string;
  consumes: Array<{ item: string; quantity: number }>;
  produces: Array<{ item: string; quantity: number }>;
  note: string;
};

export type ServiceDef = {
  item: string;
  providerRole: string;
  location: string;
  consumes: Array<{ item: string; quantity: number }>;
  price: number;
  note: string;
};

export type PlaceStockSeed = {
  placeName: string;
  item: string;
  quantity: number;
  capacity?: number;
  buys: boolean;
  sells: boolean;
  bidPrice?: number;
  askPrice?: number;
};

export type PlaceMarketSeed = {
  placeName: string;
  treasury: number;
  buySpreadPct: number;
  sellSpreadPct: number;
  targetStockRatio: number;
};

export type TradeProfile = {
  likelySells: string[];
  likelyBuys: string[];
};

export const ITEM_CATALOGUE: Record<string, ItemDef> = {
  iron_ore: { id: 'iron_ore', category: 'raw' },
  coal: { id: 'coal', category: 'raw' },
  grain: { id: 'grain', category: 'raw' },
  bread: { id: 'bread', category: 'food', edible: true, hungerRestore: 40 },
  vegetables: { id: 'vegetables', category: 'food', edible: true, hungerRestore: 35 },
  ale: { id: 'ale', category: 'food', edible: true, hungerRestore: 10 },
  herbs: { id: 'herbs', category: 'raw' },
  medicine: { id: 'medicine', category: 'medicine' },
  flour: { id: 'flour', category: 'material' },
  horseshoe: { id: 'horseshoe', category: 'crafted' },
  tools: { id: 'tools', category: 'crafted' },
  knife: { id: 'knife', category: 'crafted' },
  meal: { id: 'meal', category: 'service', edible: true, hungerRestore: 60 },
};

export const RECIPE_CATALOGUE: RecipeDef[] = [
  {
    action: 'craft',
    output: 'horseshoe',
    location: 'forge',
    consumes: [
      { item: 'iron_ore', quantity: 2 },
      { item: 'coal', quantity: 1 },
    ],
    produces: [{ item: 'horseshoe', quantity: 1 }],
    note: 'Forge a horseshoe at the forge.',
  },
  {
    action: 'craft',
    output: 'tools',
    location: 'forge',
    consumes: [
      { item: 'iron_ore', quantity: 2 },
      { item: 'coal', quantity: 1 },
    ],
    produces: [{ item: 'tools', quantity: 1 }],
    note: 'Forge tools at the forge.',
  },
  {
    action: 'craft',
    output: 'knife',
    location: 'forge',
    consumes: [
      { item: 'iron_ore', quantity: 1 },
      { item: 'coal', quantity: 1 },
    ],
    produces: [{ item: 'knife', quantity: 1 }],
    note: 'Forge a knife at the forge.',
  },
  {
    action: 'smelt',
    output: 'tools',
    location: 'forge',
    consumes: [
      { item: 'iron_ore', quantity: 2 },
      { item: 'coal', quantity: 1 },
    ],
    produces: [{ item: 'tools', quantity: 1 }],
    note: 'Smelt raw ore into usable metal goods at the forge.',
  },
  {
    action: 'brew',
    output: 'medicine',
    location: 'shrine',
    consumes: [{ item: 'herbs', quantity: 2 }],
    produces: [{ item: 'medicine', quantity: 1 }],
    note: 'Brew medicine at the shrine.',
  },
];

export const SERVICE_CATALOGUE: Record<string, ServiceDef> = {
  meal: {
    item: 'meal',
    providerRole: 'Innkeeper',
    location: 'inn',
    consumes: [
      { item: 'bread', quantity: 1 },
      { item: 'ale', quantity: 1 },
    ],
    price: 8,
    note: 'Serve a simple hot meal at the inn.',
  },
};

export const ROLE_ECONOMIC_ACTIONS: Record<string, string[]> = {
  Blacksmith: ['craft', 'smelt'],
  Farmer: ['check_field', 'plant', 'water', 'harvest'],
  Herbalist: ['gather', 'brew'],
  Innkeeper: [],
  Merchant: [],
};

export const ROLE_TRADE_PROFILES: Record<string, TradeProfile> = {
  Blacksmith: {
    likelySells: ['horseshoe', 'tools', 'knife'],
    likelyBuys: ['iron_ore', 'coal'],
  },
  Farmer: {
    likelySells: ['grain', 'vegetables'],
    likelyBuys: ['tools', 'bread'],
  },
  Herbalist: {
    likelySells: ['herbs', 'medicine'],
    likelyBuys: ['bread', 'ale'],
  },
  Innkeeper: {
    likelySells: ['bread', 'ale', 'meal'],
    likelyBuys: ['grain', 'bread', 'ale'],
  },
  Merchant: {
    likelySells: ['grain', 'coal'],
    likelyBuys: ['iron_ore', 'horseshoe', 'tools', 'knife', 'medicine', 'bread'],
  },
};

export const SEEDED_FIELDS = [
  { fieldKey: 'north_field', location: 'farm', cropItem: 'grain', stage: 'ready' as FieldStage, readyTick: 0 },
  { fieldKey: 'south_field', location: 'farm', cropItem: null, stage: 'fallow' as FieldStage, readyTick: null },
];

export const SEEDED_HERB_PATCHES = [
  { patchKey: 'shrine_patch', location: 'shrine', herbItem: 'herbs', available: 2, maxAvailable: 3, regenPerDay: 1, lastRegenDay: 1 },
  { patchKey: 'gate_patch', location: 'gate', herbItem: 'herbs', available: 3, maxAvailable: 4, regenPerDay: 1, lastRegenDay: 1 },
  { patchKey: 'market_patch', location: 'market', herbItem: 'herbs', available: 2, maxAvailable: 3, regenPerDay: 1, lastRegenDay: 1 },
];

export const SEEDED_PLACE_STOCKS: PlaceStockSeed[] = [
  { placeName: 'market', item: 'bread', quantity: 4, capacity: 20, buys: true, sells: true, bidPrice: 4, askPrice: 6 },
  { placeName: 'market', item: 'tools', quantity: 1, capacity: 10, buys: true, sells: true, bidPrice: 18, askPrice: 24 },
  { placeName: 'market', item: 'horseshoe', quantity: 0, capacity: 12, buys: true, sells: true, bidPrice: 16, askPrice: 22 },
  { placeName: 'market', item: 'medicine', quantity: 1, capacity: 12, buys: true, sells: true, bidPrice: 11, askPrice: 16 },
  { placeName: 'mine', item: 'iron_ore', quantity: 12, capacity: 30, buys: false, sells: true, askPrice: 10 },
  { placeName: 'mine', item: 'coal', quantity: 10, capacity: 30, buys: false, sells: true, askPrice: 6 },
  { placeName: 'bakery', item: 'grain', quantity: 6, capacity: 20, buys: true, sells: false, bidPrice: 8 },
  { placeName: 'bakery', item: 'bread', quantity: 10, capacity: 30, buys: false, sells: true, askPrice: 6 },
  { placeName: 'warehouse', item: 'iron_ore', quantity: 4, capacity: 50, buys: true, sells: true, bidPrice: 8, askPrice: 11 },
  { placeName: 'warehouse', item: 'coal', quantity: 6, capacity: 50, buys: true, sells: true, bidPrice: 4, askPrice: 6 },
  { placeName: 'warehouse', item: 'grain', quantity: 6, capacity: 50, buys: true, sells: true, bidPrice: 7, askPrice: 10 },
  { placeName: 'warehouse', item: 'herbs', quantity: 2, capacity: 30, buys: true, sells: true, bidPrice: 5, askPrice: 8 },
];

export const SEEDED_PLACE_MARKETS: PlaceMarketSeed[] = [
  { placeName: 'market', treasury: 220, buySpreadPct: 0.18, sellSpreadPct: 0.2, targetStockRatio: 0.55 },
  { placeName: 'mine', treasury: 40, buySpreadPct: 0.12, sellSpreadPct: 0.1, targetStockRatio: 0.7 },
  { placeName: 'bakery', treasury: 120, buySpreadPct: 0.08, sellSpreadPct: 0.18, targetStockRatio: 0.6 },
  { placeName: 'warehouse', treasury: 180, buySpreadPct: 0.1, sellSpreadPct: 0.12, targetStockRatio: 0.75 },
];

export function getRecipe(action: string, output: string | null | undefined): RecipeDef | null {
  if (!output) return null;
  return RECIPE_CATALOGUE.find((recipe) => recipe.action === action && recipe.output === output) ?? null;
}

export function getService(item: string | null | undefined): ServiceDef | null {
  if (!item) return null;
  return SERVICE_CATALOGUE[item] ?? null;
}

export function isEdible(item: string | null | undefined): boolean {
  if (!item) return false;
  return ITEM_CATALOGUE[item]?.edible === true;
}

export function hungerRestoreFor(item: string | null | undefined): number {
  if (!item) return 0;
  return ITEM_CATALOGUE[item]?.hungerRestore ?? 40;
}

export function demandPressureForItem(
  item: string,
  agents: Array<{ role: string; inventory: string; hunger: number; health: number }>,
  events: Array<{ description: string; severity: 'low' | 'medium' | 'high' }>,
): number {
  let demand = 1;

  const totalHunger = agents.reduce((sum, agent) => sum + agent.hunger, 0);
  const lowMedicineAgents = agents.filter((agent) => agent.health < 70).length;
  const blacksmiths = agents.filter((agent) => agent.role === 'Blacksmith').length;
  const innkeepers = agents.filter((agent) => agent.role === 'Innkeeper').length;

  if (item === 'bread' || item === 'meal' || item === 'grain' || item === 'vegetables') {
    demand += totalHunger / Math.max(agents.length * 120, 1);
  }
  if (item === 'medicine' || item === 'herbs') {
    demand += lowMedicineAgents * 0.25;
  }
  if (item === 'iron_ore' || item === 'coal' || item === 'tools' || item === 'horseshoe' || item === 'knife') {
    demand += blacksmiths * 0.2;
  }
  if (item === 'bread' || item === 'ale' || item === 'meal') {
    demand += innkeepers * 0.2;
  }

  for (const event of events) {
    const description = event.description.toLowerCase();
    const severityWeight = event.severity === 'high' ? 0.5 : event.severity === 'medium' ? 0.25 : 0.1;
    if ((item === 'grain' || item === 'bread' || item === 'meal') && /drought|famine|hunger/.test(description)) {
      demand += severityWeight;
    }
    if ((item === 'medicine' || item === 'herbs') && /illness|plague|sick|fever/.test(description)) {
      demand += severityWeight;
    }
  }

  return Math.max(0.5, demand);
}

export const advanceEconomicState = internalMutation({
  args: { tick: v.number(), day: v.number(), timeOfDay: v.string() },
  handler: async (ctx, { tick, day, timeOfDay }) => {
    const fields = await ctx.db.query('rl_fields').collect();
    for (const field of fields) {
      if (field.stage === 'growing' && typeof field.readyTick === 'number' && tick >= field.readyTick) {
        await ctx.db.patch(field._id, { stage: 'ready' });
      }
    }

    if (timeOfDay === 'morning') {
      const patches = await ctx.db.query('rl_herb_patches').collect();
      for (const patch of patches) {
        if (patch.lastRegenDay >= day) continue;
        await ctx.db.patch(patch._id, {
          available: Math.min(patch.maxAvailable, patch.available + patch.regenPerDay),
          lastRegenDay: day,
        });
      }
    }
  },
});
