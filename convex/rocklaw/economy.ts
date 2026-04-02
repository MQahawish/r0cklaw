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
  usable?: boolean;
  healthRestore?: number;
};

export type RecipeDef = {
  action: 'work' | 'brew';
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
  vegetable: { id: 'vegetable', category: 'food', edible: true, hungerRestore: 35 },
  ale: { id: 'ale', category: 'food', edible: true, hungerRestore: 10 },
  herb: { id: 'herb', category: 'raw' },
  medicine: { id: 'medicine', category: 'medicine', usable: true, healthRestore: 35 },
  flour: { id: 'flour', category: 'material' },
  iron_ingot: { id: 'iron_ingot', category: 'material' },
  horseshoe: { id: 'horseshoe', category: 'crafted' },
  tool: { id: 'tool', category: 'crafted' },
  knife: { id: 'knife', category: 'crafted' },
  meal: { id: 'meal', category: 'service', edible: true, hungerRestore: 60 },
};

const ITEM_ALIASES: Record<string, string> = {
  tool: 'tool',
  tools: 'tool',
  herb: 'herb',
  herbs: 'herb',
  vegetable: 'vegetable',
  vegetables: 'vegetable',
  horseshoe: 'horseshoe',
  horseshoes: 'horseshoe',
  knife: 'knife',
  knives: 'knife',
  grain: 'grain',
  grains: 'grain',
  bread: 'bread',
  breads: 'bread',
  medicine: 'medicine',
  medicines: 'medicine',
  coal: 'coal',
  coals: 'coal',
  ale: 'ale',
  ales: 'ale',
  meal: 'meal',
  meals: 'meal',
  iron_ore: 'iron_ore',
  'iron ore': 'iron_ore',
  'iron-ore': 'iron_ore',
  iron_ingot: 'iron_ingot',
  'iron ingot': 'iron_ingot',
  'iron-ingot': 'iron_ingot',
  axe: 'axe',
  axes: 'axe',
  coin: 'coin',
  coins: 'coin',
  coin_purse: 'coin_purse',
  'coin purse': 'coin_purse',
  'coin-purse': 'coin_purse',
};

const ITEM_DISPLAY_NAMES: Record<string, { singular: string; plural: string }> = {
  iron_ore: { singular: 'iron_ore', plural: 'iron_ore' },
  coal: { singular: 'coal', plural: 'coal' },
  grain: { singular: 'grain', plural: 'grain' },
  bread: { singular: 'bread', plural: 'bread' },
  vegetable: { singular: 'vegetable', plural: 'vegetables' },
  ale: { singular: 'ale', plural: 'ale' },
  herb: { singular: 'herb', plural: 'herbs' },
  medicine: { singular: 'medicine', plural: 'medicine' },
  flour: { singular: 'flour', plural: 'flour' },
  iron_ingot: { singular: 'iron_ingot', plural: 'iron_ingot' },
  horseshoe: { singular: 'horseshoe', plural: 'horseshoes' },
  tool: { singular: 'tool', plural: 'tools' },
  knife: { singular: 'knife', plural: 'knives' },
  meal: { singular: 'meal', plural: 'meals' },
  axe: { singular: 'axe', plural: 'axes' },
  coin: { singular: 'coin', plural: 'coin' },
  coin_purse: { singular: 'coin_purse', plural: 'coin_purse' },
};

export function canonicalizeItemId(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const lowered = trimmed
    .toLowerCase()
    .replace(/[_\s-]+/g, '_');
  const alias = ITEM_ALIASES[lowered] ?? ITEM_ALIASES[lowered.replace(/_/g, ' ')];
  if (alias) return alias;
  if (ITEM_CATALOGUE[lowered]) return lowered;
  return lowered;
}

export function canonicalizeItemQuantities(input: Record<string, number>): Record<string, number> {
  const output: Record<string, number> = {};
  for (const [rawItem, rawQty] of Object.entries(input)) {
    const item = canonicalizeItemId(rawItem);
    if (!item) continue;
    const qty = Number(rawQty);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    output[item] = (output[item] ?? 0) + qty;
  }
  return output;
}

export function canonicalizeItemEntries<T extends { item: string; quantity: number }>(items: T[]): T[] {
  return Object.entries(
    items.reduce<Record<string, number>>((acc, entry) => {
      const item = canonicalizeItemId(entry.item);
      if (!item) return acc;
      acc[item] = (acc[item] ?? 0) + entry.quantity;
      return acc;
    }, {}),
  ).map(([item, quantity]) => ({ item, quantity } as T));
}

export function formatItemLabel(item: string, quantity = 1): string {
  const canonical = canonicalizeItemId(item) ?? item;
  const labels = ITEM_DISPLAY_NAMES[canonical];
  if (!labels) return canonical;
  return quantity === 1 ? labels.singular : labels.plural;
}

export function formatItemQuantity(item: string, quantity: number): string {
  return `${quantity} ${formatItemLabel(item, quantity)}`;
}

export const RECIPE_CATALOGUE: RecipeDef[] = [
  {
    action: 'work',
    output: 'flour',
    location: 'bakery',
    consumes: [{ item: 'grain', quantity: 2 }],
    produces: [{ item: 'flour', quantity: 2 }],
    note: 'Mill grain into flour at the bakery.',
  },
  {
    action: 'work',
    output: 'bread',
    location: 'bakery',
    consumes: [{ item: 'flour', quantity: 2 }],
    produces: [{ item: 'bread', quantity: 3 }],
    note: 'Bake bread at the bakery.',
  },
  {
    action: 'work',
    output: 'horseshoe',
    location: 'forge',
    consumes: [{ item: 'iron_ingot', quantity: 1 }],
    produces: [{ item: 'horseshoe', quantity: 1 }],
    note: 'Forge a horseshoe from refined ingot at the forge.',
  },
  {
    action: 'work',
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
    action: 'work',
    output: 'tool',
    location: 'forge',
    consumes: [{ item: 'iron_ingot', quantity: 1 }],
    produces: [{ item: 'tool', quantity: 1 }],
    note: 'Forge a tool from refined ingot at the forge.',
  },
  {
    action: 'work',
    output: 'tool',
    location: 'forge',
    consumes: [
      { item: 'iron_ore', quantity: 2 },
      { item: 'coal', quantity: 1 },
    ],
    produces: [{ item: 'tool', quantity: 1 }],
    note: 'Forge a tool at the forge.',
  },
  {
    action: 'work',
    output: 'knife',
    location: 'forge',
    consumes: [{ item: 'iron_ingot', quantity: 1 }],
    produces: [{ item: 'knife', quantity: 1 }],
    note: 'Forge a knife from refined ingot at the forge.',
  },
  {
    action: 'work',
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
    action: 'work',
    output: 'iron_ingot',
    location: 'forge',
    consumes: [{ item: 'horseshoe', quantity: 1 }],
    produces: [{ item: 'iron_ingot', quantity: 1 }],
    note: 'Reforge a horseshoe back into an iron ingot at the forge.',
  },
  {
    action: 'work',
    output: 'iron_ingot',
    location: 'forge',
    consumes: [
      { item: 'iron_ore', quantity: 2 },
      { item: 'coal', quantity: 1 },
    ],
    produces: [{ item: 'iron_ingot', quantity: 1 }],
    note: 'Refine raw ore into an iron ingot at the forge.',
  },
  {
    action: 'brew',
    output: 'medicine',
    location: 'shrine',
    consumes: [{ item: 'herb', quantity: 2 }],
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
  Blacksmith: ['work'],
  Farmer: ['work'],
  Herbalist: ['work'],
  Innkeeper: ['work'],
  Merchant: [],
};

export const ROLE_TRADE_PROFILES: Record<string, TradeProfile> = {
  Blacksmith: {
    likelySells: ['horseshoe', 'tool', 'knife', 'iron_ingot'],
    likelyBuys: ['iron_ore', 'coal'],
  },
  Farmer: {
    likelySells: ['grain', 'vegetable'],
    likelyBuys: ['tool', 'bread'],
  },
  Herbalist: {
    likelySells: ['herb', 'medicine'],
    likelyBuys: ['bread', 'ale'],
  },
  Innkeeper: {
    likelySells: ['bread', 'ale', 'meal'],
    likelyBuys: ['grain', 'bread', 'ale'],
  },
  Merchant: {
    likelySells: ['grain', 'coal'],
    likelyBuys: ['iron_ore', 'horseshoe', 'tool', 'knife', 'medicine', 'bread'],
  },
};

export const SEEDED_FIELDS = [
  { fieldKey: 'north_field', location: 'farm', cropItem: 'grain', stage: 'ready' as FieldStage, readyTick: 0 },
  { fieldKey: 'south_field', location: 'farm', cropItem: null, stage: 'fallow' as FieldStage, readyTick: null },
];

export const SEEDED_HERB_PATCHES = [
  { patchKey: 'shrine_patch', location: 'shrine', herbItem: 'herb', available: 2, maxAvailable: 3, regenPerDay: 1, lastRegenDay: 1 },
  { patchKey: 'gate_patch', location: 'gate', herbItem: 'herb', available: 3, maxAvailable: 4, regenPerDay: 1, lastRegenDay: 1 },
  { patchKey: 'market_patch', location: 'market', herbItem: 'herb', available: 2, maxAvailable: 3, regenPerDay: 1, lastRegenDay: 1 },
];

export const SEEDED_PLACE_STOCKS: PlaceStockSeed[] = [
  { placeName: 'market', item: 'bread', quantity: 4, capacity: 20, buys: true, sells: true, bidPrice: 4, askPrice: 6 },
  { placeName: 'market', item: 'tool', quantity: 1, capacity: 10, buys: true, sells: true, bidPrice: 18, askPrice: 24 },
  { placeName: 'market', item: 'horseshoe', quantity: 0, capacity: 12, buys: true, sells: true, bidPrice: 16, askPrice: 22 },
  { placeName: 'market', item: 'medicine', quantity: 1, capacity: 12, buys: true, sells: true, bidPrice: 11, askPrice: 16 },
  { placeName: 'mine', item: 'iron_ore', quantity: 12, capacity: 30, buys: false, sells: true, askPrice: 10 },
  { placeName: 'mine', item: 'coal', quantity: 10, capacity: 30, buys: false, sells: true, askPrice: 6 },
  { placeName: 'bakery', item: 'grain', quantity: 6, capacity: 20, buys: true, sells: false, bidPrice: 8 },
  { placeName: 'bakery', item: 'bread', quantity: 10, capacity: 30, buys: false, sells: true, askPrice: 6 },
  { placeName: 'warehouse', item: 'iron_ore', quantity: 4, capacity: 50, buys: true, sells: true, bidPrice: 8, askPrice: 11 },
  { placeName: 'warehouse', item: 'coal', quantity: 6, capacity: 50, buys: true, sells: true, bidPrice: 4, askPrice: 6 },
  { placeName: 'warehouse', item: 'grain', quantity: 6, capacity: 50, buys: true, sells: true, bidPrice: 7, askPrice: 10 },
  { placeName: 'warehouse', item: 'herb', quantity: 2, capacity: 30, buys: true, sells: true, bidPrice: 5, askPrice: 8 },
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

export function getRecipes(action: string, output: string | null | undefined): RecipeDef[] {
  if (!output) return [];
  return RECIPE_CATALOGUE.filter((recipe) => recipe.action === action && recipe.output === output);
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

export function isUsable(item: string | null | undefined): boolean {
  if (!item) return false;
  return ITEM_CATALOGUE[item]?.usable === true;
}

export function healthRestoreFor(item: string | null | undefined): number {
  if (!item) return 0;
  return ITEM_CATALOGUE[item]?.healthRestore ?? 0;
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

  if (item === 'bread' || item === 'meal' || item === 'grain' || item === 'vegetable') {
    demand += totalHunger / Math.max(agents.length * 120, 1);
  }
  if (item === 'medicine' || item === 'herb') {
    demand += lowMedicineAgents * 0.25;
  }
  if (item === 'iron_ore' || item === 'coal' || item === 'tool' || item === 'horseshoe' || item === 'knife') {
    demand += blacksmiths * 0.2;
  }
  if (item === 'iron_ingot') {
    demand += blacksmiths * 0.15;
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
    if ((item === 'medicine' || item === 'herb') && /illness|plague|sick|fever/.test(description)) {
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
