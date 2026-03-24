/**
 * Systems Layer -- Phase 8
 *
 * Runtime-configurable knobs stored in rl_systems_state.
 * The engine (bridge, priceEngine, compact) reads these at call time
 * instead of using hardcoded constants.
 *
 * Public surface:
 *   getSystems         -- query: returns all knobs with current value + metadata
 *   setSystemValue     -- mutation: writes one knob (god mode)
 *   applyPreset        -- mutation: applies a named scenario preset
 *   resetToDefaults    -- mutation: restores all knobs to default values
 *
 * Internal helpers (used by engine code):
 *   getSystemFloat     -- internalQuery: reads a float knob (with default)
 *   getSystemInt       -- internalQuery: reads an int knob (with default)
 */

import { v } from 'convex/values';
import { query, mutation, internalQuery, internalMutation } from '../_generated/server';
import type { MutationCtx } from '../_generated/server';

// ── Knob catalogue ────────────────────────────────────────────────────────────

export type KnobDef = {
  systemName: string;
  key: string;
  label: string;
  description: string;
  defaultValue: number;
  min: number;
  max: number;
  step: number;
  unit: string;
};

export const KNOB_CATALOGUE: KnobDef[] = [
  {
    systemName: 'engine',
    key: 'tick_interval_ms',
    label: 'Tick Interval',
    description: 'Milliseconds between world clock ticks. Lower = faster simulation.',
    defaultValue: 30000,
    min: 5000,
    max: 120000,
    step: 5000,
    unit: 'ms',
  },
  {
    systemName: 'engine',
    key: 'compaction_every_n_ticks',
    label: 'Compaction Frequency',
    description: 'How many ticks between memory compaction runs.',
    defaultValue: 10,
    min: 5,
    max: 50,
    step: 1,
    unit: 'ticks',
  },
  {
    systemName: 'agents',
    key: 'min_energy_for_hard_work',
    label: 'Min Energy for Hard Work',
    description: 'Energy threshold below which physical actions (craft, harvest, mine…) fail.',
    defaultValue: 15,
    min: 0,
    max: 50,
    step: 5,
    unit: 'energy',
  },
  {
    systemName: 'agents',
    key: 'health_drain_per_zero_tick',
    label: 'Health Drain at Zero Energy',
    description: 'Health lost per tick when energy reaches 0 and the agent keeps acting.',
    defaultValue: 10,
    min: 0,
    max: 30,
    step: 2,
    unit: 'hp',
  },
  {
    systemName: 'economy',
    key: 'scarcity_multiplier',
    label: 'Scarcity Multiplier',
    description: 'Scales how severely shortages inflate prices. 1.0 = normal, 2.0 = brutal.',
    defaultValue: 1.0,
    min: 0.1,
    max: 4.0,
    step: 0.1,
    unit: '×',
  },
  {
    systemName: 'economy',
    key: 'base_price_multiplier',
    label: 'Base Price Multiplier',
    description: 'Scales all base item prices. >1 = expensive era, <1 = boom times.',
    defaultValue: 1.0,
    min: 0.25,
    max: 3.0,
    step: 0.25,
    unit: '×',
  },
  {
    systemName: 'narrative',
    key: 'auto_event_tension_threshold',
    label: 'Auto-Event Tension Threshold',
    description: 'When tension exceeds this value a world event is auto-injected. 0 = off.',
    defaultValue: 0,
    min: 0,
    max: 90,
    step: 10,
    unit: 'tension',
  },
];

// ── Scenario presets ──────────────────────────────────────────────────────────

type PresetValues = Record<string, Record<string, number>>; // systemName → key → value

export const PRESETS: Record<string, { label: string; description: string; values: PresetValues }> = {
  default: {
    label: 'Default',
    description: 'Balanced simulation. All knobs at their factory defaults.',
    values: {},
  },
  harsh_winter: {
    label: 'Harsh Winter',
    description: 'Food and fuel scarce. Prices volatile. Agents tire faster and fall sick sooner.',
    values: {
      agents: { min_energy_for_hard_work: 20, health_drain_per_zero_tick: 15 },
      economy: { scarcity_multiplier: 1.8, base_price_multiplier: 1.5 },
    },
  },
  boom_times: {
    label: 'Boom Times',
    description: 'Trade is cheap, goods are plentiful, agents have more energy to spare.',
    values: {
      agents: { min_energy_for_hard_work: 8 },
      economy: { scarcity_multiplier: 0.5, base_price_multiplier: 0.7 },
    },
  },
  plague: {
    label: 'Plague',
    description: 'Health drains fast. Medicine is critical. Agents must rest frequently.',
    values: {
      agents: { min_energy_for_hard_work: 25, health_drain_per_zero_tick: 20 },
      economy: { scarcity_multiplier: 1.5 },
      narrative: { auto_event_tension_threshold: 50 },
    },
  },
  drought: {
    label: 'Drought',
    description: 'Grain and herbs are the new gold. Trade tension runs high.',
    values: {
      economy: { scarcity_multiplier: 2.0, base_price_multiplier: 1.25 },
      narrative: { auto_event_tension_threshold: 60 },
    },
  },
};

// ── Internal read helpers (used by bridge, priceEngine, etc.) ─────────────────

async function readSystemFloat(
  ctx: { db: any },
  systemName: string,
  key: string,
  defaultVal: number,
): Promise<number> {
  const row = await ctx.db
    .query('rl_systems_state')
    .withIndex('system', (q: any) => q.eq('systemName', systemName).eq('key', key))
    .unique();
  if (!row) return defaultVal;
  const v = parseFloat(row.value);
  return isNaN(v) ? defaultVal : v;
}

export const getSystemFloat = internalQuery({
  args: { systemName: v.string(), key: v.string(), defaultValue: v.number() },
  handler: async (ctx, { systemName, key, defaultValue }) => {
    return readSystemFloat(ctx, systemName, key, defaultValue);
  },
});

export const getSystemInt = internalQuery({
  args: { systemName: v.string(), key: v.string(), defaultValue: v.number() },
  handler: async (ctx, { systemName, key, defaultValue }) => {
    const val = await readSystemFloat(ctx, systemName, key, defaultValue);
    return Math.round(val);
  },
});

// ── Public query: all knobs ───────────────────────────────────────────────────

export type SystemKnob = KnobDef & {
  currentValue: number;
  isDefault: boolean;
};

export const getSystems = query({
  args: {},
  handler: async (ctx): Promise<SystemKnob[]> => {
    const rows = await ctx.db.query('rl_systems_state').collect();
    const stored = new Map<string, number>();
    for (const row of rows) {
      stored.set(`${row.systemName}.${row.key}`, parseFloat(row.value));
    }

    return KNOB_CATALOGUE.map((knob) => {
      const storeKey = `${knob.systemName}.${knob.key}`;
      const currentValue = stored.has(storeKey) ? stored.get(storeKey)! : knob.defaultValue;
      return {
        ...knob,
        currentValue,
        isDefault: currentValue === knob.defaultValue,
      };
    });
  },
});

// ── Public mutation: set one knob ─────────────────────────────────────────────

export const setSystemValue = mutation({
  args: {
    systemName: v.string(),
    key: v.string(),
    value: v.number(),
  },
  handler: async (ctx, { systemName, key, value }) => {
    const existing = await ctx.db
      .query('rl_systems_state')
      .withIndex('system', (q) => q.eq('systemName', systemName).eq('key', key))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { value: String(value), updatedAt: Date.now() });
    } else {
      await ctx.db.insert('rl_systems_state', {
        systemName,
        key,
        value: String(value),
        updatedAt: Date.now(),
      });
    }
  },
});

// ── Public mutation: apply preset ─────────────────────────────────────────────

export const applyPreset = mutation({
  args: { presetId: v.string() },
  handler: async (ctx, { presetId }) => {
    const preset = PRESETS[presetId];
    if (!preset) throw new Error(`Unknown preset: ${presetId}`);

    // Start by resetting all knobs to defaults (delete all rows)
    const all = await ctx.db.query('rl_systems_state').collect();
    for (const row of all) {
      await ctx.db.delete(row._id);
    }

    // Apply preset values
    for (const [systemName, keys] of Object.entries(preset.values)) {
      for (const [key, value] of Object.entries(keys)) {
        await ctx.db.insert('rl_systems_state', {
          systemName,
          key,
          value: String(value),
          updatedAt: Date.now(),
        });
      }
    }
  },
});

// ── Public mutation: reset all to defaults ────────────────────────────────────

export const resetToDefaults = mutation({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query('rl_systems_state').collect();
    for (const row of all) {
      await ctx.db.delete(row._id);
    }
  },
});
