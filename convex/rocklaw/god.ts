/**
 * God-Mode API -- Phase 5
 *
 * Gives the player full visibility and control over the simulation:
 *   getDashboard  -- one query returning all world state (agents, events, log, prices, tension)
 *   injectEvent   -- insert a world event that all agents see next tick
 *   resolveEvent  -- mark an active event resolved
 *   suggestEvents -- one LLM call reads world state, returns 4-6 event suggestions
 */

import { v } from 'convex/values';
import { query, mutation, action, internalMutation } from '../_generated/server';
import { api, internal } from '../_generated/api';

const RUN_CONSOLE_SINGLETON = 'main';
const DEFAULT_AGENT_SLUGS = ['elena', 'marcus', 'finn', 'lena', 'sera'] as const;
const AGENT_NAME_BY_SLUG: Record<string, string> = {
  elena: 'Elena Voss',
  marcus: 'Marcus Hale',
  finn: 'Finn',
  lena: 'Lena Marsh',
  sera: 'Sera',
};

function parseJsonValue<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function defaultRunConsoleState() {
  return {
    controlStatus: 'idle' as const,
    autoRunning: false,
    stepInProgress: false,
    loopToken: 0,
    selectedAgentSlugs: [...DEFAULT_AGENT_SLUGS],
    mode: 'fresh' as const,
    profile: 'blank-self' as const,
    providerPreset: 'keep',
    modelProvider: undefined as string | undefined,
    modelId: undefined as string | undefined,
    fallbackProvider: 'openrouter',
    fallbackModel: undefined as string | undefined,
    stepBatchSize: 1,
    lastPreparedTick: undefined as number | undefined,
    lastSummaryTick: undefined as number | undefined,
    lastError: undefined as string | undefined,
    sessionCostUsd: 0,
  };
}

// ── Prayers query (standalone) ───────────────────────────────────────────────

export const getPrayers = query({
  args: {
    agentName: v.optional(v.string()),  // omit for all agents
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { agentName, limit = 20 }) => {
    if (agentName) {
      return ctx.db
        .query('rl_prayers')
        .withIndex('agentName', (q) => q.eq('agentName', agentName))
        .order('desc')
        .take(limit);
    }
    return ctx.db.query('rl_prayers').order('desc').take(limit);
  },
});

// ── Dashboard query ───────────────────────────────────────────────────────────

export const getDashboard = query({
  args: {},
  handler: async (ctx) => {
    const worldState = await ctx.db.query('rl_world_state').unique();

    const agents = await ctx.db.query('rl_agents').collect();

    const activeEvents = await ctx.db
      .query('rl_world_events')
      .withIndex('active', (q) => q.eq('active', true))
      .order('desc')
      .take(20);

    const recentActions = await ctx.db
      .query('rl_actions_log')
      .withIndex('tick', (q) => q.gt('tick', (worldState?.tick ?? 0) - 30))
      .order('desc')
      .take(20);

    const prices = await ctx.db.query('rl_market_prices').collect();

    const recentPrayers = await ctx.db
      .query('rl_prayers')
      .filter((q) => q.gt(q.field('tick'), (worldState?.tick ?? 0) - 15))
      .order('desc')
      .take(5);

    // Unread letters older than 5 ticks (social stress)
    const tick = worldState?.tick ?? 0;
    const allUnread = await ctx.db
      .query('rl_messages')
      .filter((q) => q.eq(q.field('status'), 'unread'))
      .collect();
    const staleLetters = allUnread.filter((m) => m.tickSent < tick - 5);

    const tension = computeTension(agents, prices, staleLetters, activeEvents);

    // Reputation scores for all agents
    const reputations = await ctx.db.query('rl_reputation').collect();
    const repByAgent: Record<string, number> = {};
    for (const r of reputations) {
      repByAgent[r.agentName] = r.score;
    }

    return {
      worldState,
      agents,
      activeEvents,
      recentActions,
      prices,
      recentPrayers,
      tension,
      repByAgent,
    };
  },
});

export const getRunConsole = query({
  args: {},
  handler: async (ctx) => {
    const worldState = await ctx.db.query('rl_world_state').unique();
    const stateDoc = await ctx.db
      .query('rl_run_console_state')
      .withIndex('singletonKey', (q) => q.eq('singletonKey', RUN_CONSOLE_SINGLETON))
      .unique();
    const historyDocs = await ctx.db
      .query('rl_run_tick_summaries')
      .order('desc')
      .take(120);

    const defaults = defaultRunConsoleState();
    const state = stateDoc
      ? {
          controlStatus: stateDoc.controlStatus,
          autoRunning: stateDoc.autoRunning,
          stepInProgress: stateDoc.stepInProgress,
          loopToken: stateDoc.loopToken,
          selectedAgentSlugs: parseJsonValue<string[]>(stateDoc.selectedAgentSlugsJson, defaults.selectedAgentSlugs),
          mode: stateDoc.mode,
          profile: stateDoc.profile,
          providerPreset: stateDoc.providerPreset,
          modelProvider: stateDoc.modelProvider,
          modelId: stateDoc.modelId,
          fallbackProvider: stateDoc.fallbackProvider,
          fallbackModel: stateDoc.fallbackModel,
          stepBatchSize: stateDoc.stepBatchSize ?? 1,
          lastPreparedTick: stateDoc.lastPreparedTick,
          lastSummaryTick: stateDoc.lastSummaryTick,
          lastError: stateDoc.lastError,
          sessionCostUsd: stateDoc.sessionCostUsd ?? 0,
        }
      : defaults;

    return {
      state,
      worldState,
      tickHistory: historyDocs.map((entry) => ({
        _id: entry._id,
        tick: entry.tick,
        day: entry.day,
        timeOfDay: entry.timeOfDay,
        createdAt: entry.createdAt,
        summary: parseJsonValue<any>(entry.summaryJson, null),
      })),
    };
  },
});

// ── Tension meter ─────────────────────────────────────────────────────────────

function computeTension(
  agents: any[],
  prices: any[],
  staleLetters: any[],
  events: any[],
): { score: number; breakdown: Record<string, number> } {
  const breakdown: Record<string, number> = {};

  // Agent physical stress
  let agentStress = 0;
  for (const a of agents) {
    if (a.energy < 15) agentStress += 8;
    else if (a.energy < 30) agentStress += 4;
    if (a.health < 30) agentStress += 10;
    else if (a.health < 50) agentStress += 5;
    if (a.hunger > 80) agentStress += 8;
    else if (a.hunger > 60) agentStress += 3;
  }
  breakdown.agentStress = Math.min(40, agentStress);

  // Economic stress
  let econStress = 0;
  for (const p of prices) {
    if (p.shortageLevel === 'critical') econStress += 10;
    else if (p.shortageLevel === 'moderate') econStress += 5;
  }
  breakdown.econStress = Math.min(30, econStress);

  // Social stress (unanswered letters)
  breakdown.socialStress = Math.min(20, staleLetters.length * 4);

  // Active crises
  let crisisStress = 0;
  for (const e of events) {
    if (e.severity === 'high') crisisStress += 15;
    else if (e.severity === 'medium') crisisStress += 8;
    else crisisStress += 3;
  }
  breakdown.crisisStress = Math.min(30, crisisStress);

  const score = Math.min(
    100,
    breakdown.agentStress + breakdown.econStress + breakdown.socialStress + breakdown.crisisStress,
  );

  return { score, breakdown };
}

// ── Event injection ───────────────────────────────────────────────────────────

export const injectEvent = mutation({
  args: {
    type: v.string(),
    description: v.string(),
    severity: v.union(v.literal('low'), v.literal('medium'), v.literal('high')),
  },
  handler: async (ctx, { type, description, severity }) => {
    const worldState = await ctx.db.query('rl_world_state').unique();
    const tick = worldState?.tick ?? 0;

    await ctx.db.insert('rl_world_events', {
      type,
      description,
      severity,
      active: true,
      source: 'god',
      createdAtTick: tick,
    });

    console.log(`[god] Injected event: ${type} — ${description}`);
  },
});

export const resolveEvent = mutation({
  args: { eventId: v.id('rl_world_events') },
  handler: async (ctx, { eventId }) => {
    const worldState = await ctx.db.query('rl_world_state').unique();
    await ctx.db.patch(eventId, {
      active: false,
      resolvedAtTick: worldState?.tick ?? 0,
    });
  },
});

export const _upsertRunConsoleState = internalMutation({
  args: {
    controlStatus: v.optional(v.union(
      v.literal('idle'),
      v.literal('preparing'),
      v.literal('ready'),
      v.literal('running'),
      v.literal('error'),
    )),
    autoRunning: v.optional(v.boolean()),
    stepInProgress: v.optional(v.boolean()),
    loopToken: v.optional(v.number()),
    selectedAgentSlugsJson: v.optional(v.string()),
    mode: v.optional(v.union(v.literal('fresh'), v.literal('continue'))),
    profile: v.optional(v.union(v.literal('blank-self'), v.literal('seeded'))),
    providerPreset: v.optional(v.string()),
    modelProvider: v.optional(v.string()),
    modelId: v.optional(v.string()),
    fallbackProvider: v.optional(v.string()),
    fallbackModel: v.optional(v.string()),
    stepBatchSize: v.optional(v.number()),
    lastPreparedTick: v.optional(v.number()),
    lastSummaryTick: v.optional(v.number()),
    lastError: v.optional(v.string()),
    clearLastSummaryTick: v.optional(v.boolean()),
    clearLastError: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('rl_run_console_state')
      .withIndex('singletonKey', (q) => q.eq('singletonKey', RUN_CONSOLE_SINGLETON))
      .unique();
    const now = Date.now();
    const defaults = defaultRunConsoleState();
    const fields = {
      singletonKey: RUN_CONSOLE_SINGLETON,
      controlStatus: args.controlStatus ?? existing?.controlStatus ?? defaults.controlStatus,
      autoRunning: args.autoRunning ?? existing?.autoRunning ?? defaults.autoRunning,
      stepInProgress: args.stepInProgress ?? existing?.stepInProgress ?? defaults.stepInProgress,
      loopToken: args.loopToken ?? existing?.loopToken ?? defaults.loopToken,
      selectedAgentSlugsJson: args.selectedAgentSlugsJson ?? existing?.selectedAgentSlugsJson ?? JSON.stringify(defaults.selectedAgentSlugs),
      mode: args.mode ?? existing?.mode ?? defaults.mode,
      profile: args.profile ?? existing?.profile ?? defaults.profile,
      providerPreset: args.providerPreset ?? existing?.providerPreset ?? defaults.providerPreset,
      modelProvider: args.modelProvider ?? existing?.modelProvider,
      modelId: args.modelId ?? existing?.modelId,
      fallbackProvider: args.fallbackProvider ?? existing?.fallbackProvider ?? defaults.fallbackProvider,
      fallbackModel: args.fallbackModel ?? existing?.fallbackModel,
      stepBatchSize: args.stepBatchSize ?? existing?.stepBatchSize ?? defaults.stepBatchSize,
      lastPreparedTick: args.lastPreparedTick ?? existing?.lastPreparedTick,
      lastSummaryTick: args.clearLastSummaryTick ? undefined : (args.lastSummaryTick ?? existing?.lastSummaryTick),
      lastError: args.clearLastError ? undefined : (args.lastError ?? existing?.lastError),
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return existing._id;
    }
    return await ctx.db.insert('rl_run_console_state', fields);
  },
});

export const _clearRunTickSummaries = internalMutation({
  args: {},
  handler: async (ctx) => {
    const entries = await ctx.db.query('rl_run_tick_summaries').collect();
    for (const entry of entries) {
      await ctx.db.delete(entry._id);
    }
  },
});

export const _patchAgentCosts = internalMutation({
  args: {
    agentName: v.string(),
    deltaCostUsd: v.number(),
    deltaInputTokens: v.number(),
    deltaOutputTokens: v.number(),
    newOffset: v.number(),
  },
  handler: async (ctx, { agentName, deltaCostUsd, deltaInputTokens, deltaOutputTokens, newOffset }) => {
    const agent = await ctx.db
      .query('rl_agents')
      .withIndex('name', (q) => q.eq('name', agentName))
      .unique();
    if (!agent) return;
    await ctx.db.patch(agent._id, {
      lifetimeCostUsd: (agent.lifetimeCostUsd ?? 0) + deltaCostUsd,
      lifetimeInputTokens: (agent.lifetimeInputTokens ?? 0) + deltaInputTokens,
      lifetimeOutputTokens: (agent.lifetimeOutputTokens ?? 0) + deltaOutputTokens,
      costsFileOffset: newOffset,
    });
    if (deltaCostUsd > 0) {
      const runState = await ctx.db
        .query('rl_run_console_state')
        .withIndex('singletonKey', (q) => q.eq('singletonKey', RUN_CONSOLE_SINGLETON))
        .unique();
      if (runState) {
        await ctx.db.patch(runState._id, {
          sessionCostUsd: (runState.sessionCostUsd ?? 0) + deltaCostUsd,
        });
      }
    }
  },
});

export const _clearAgentCosts = internalMutation({
  args: {
    agentUpdates: v.array(v.object({
      agentName: v.string(),
      costsFileOffset: v.number(),
    })),
  },
  handler: async (ctx, { agentUpdates }) => {
    for (const { agentName, costsFileOffset } of agentUpdates) {
      const agent = await ctx.db
        .query('rl_agents')
        .withIndex('name', (q) => q.eq('name', agentName))
        .unique();
      if (!agent) continue;
      await ctx.db.patch(agent._id, {
        lifetimeCostUsd: 0,
        lifetimeInputTokens: 0,
        lifetimeOutputTokens: 0,
        costsFileOffset,
      });
    }
    const runState = await ctx.db
      .query('rl_run_console_state')
      .withIndex('singletonKey', (q) => q.eq('singletonKey', RUN_CONSOLE_SINGLETON))
      .unique();
    if (runState) {
      await ctx.db.patch(runState._id, { sessionCostUsd: 0 });
    }
  },
});

export const _recordRunTickSummary = internalMutation({
  args: {
    tick: v.number(),
    day: v.number(),
    timeOfDay: v.string(),
    summaryJson: v.string(),
  },
  handler: async (ctx, { tick, day, timeOfDay, summaryJson }) => {
    const existing = await ctx.db
      .query('rl_run_tick_summaries')
      .withIndex('tick', (q) => q.eq('tick', tick))
      .collect();
    for (const entry of existing) {
      await ctx.db.delete(entry._id);
    }
    await ctx.db.insert('rl_run_tick_summaries', {
      tick,
      day,
      timeOfDay,
      summaryJson,
      createdAt: Date.now(),
    });
    const entries = await ctx.db.query('rl_run_tick_summaries').order('desc').take(301);
    for (const stale of entries.slice(300)) {
      await ctx.db.delete(stale._id);
    }
  },
});

export const _setRunAgentSelection = internalMutation({
  args: { selectedAgentNames: v.array(v.string()) },
  handler: async (ctx, { selectedAgentNames }) => {
    const selected = new Set(selectedAgentNames);
    const agents = await ctx.db.query('rl_agents').collect();
    for (const agent of agents) {
      await ctx.db.patch(agent._id, { paused: !selected.has(agent.name) });
    }
  },
});

export const stopRunAuto = mutation({
  args: {},
  handler: async (ctx) => {
    await ctx.runMutation(internal.rocklaw.god._upsertRunConsoleState, {
      autoRunning: false,
      stepInProgress: false,
      controlStatus: 'ready',
      clearLastError: true,
    });
    return { status: 'stopped' };
  },
});

export const clearRunHistory = mutation({
  args: {},
  handler: async (ctx) => {
    await ctx.runMutation(internal.rocklaw.god._clearRunTickSummaries, {});
    await ctx.runMutation(internal.rocklaw.god._upsertRunConsoleState, {
      clearLastSummaryTick: true,
      clearLastError: true,
      controlStatus: 'ready',
    });
    return { status: 'cleared' };
  },
});

export const startRunAuto = mutation({
  args: { stepBatchSize: v.optional(v.number()) },
  handler: async (ctx, { stepBatchSize }) => {
    const existing = await ctx.db
      .query('rl_run_console_state')
      .withIndex('singletonKey', (q) => q.eq('singletonKey', RUN_CONSOLE_SINGLETON))
      .unique();
    const nextLoopToken = (existing?.loopToken ?? 0) + 1;
    await ctx.runMutation(internal.rocklaw.god._upsertRunConsoleState, {
      autoRunning: true,
      stepInProgress: false,
      controlStatus: 'running',
      loopToken: nextLoopToken,
      stepBatchSize: Math.max(1, Math.min(20, stepBatchSize ?? existing?.stepBatchSize ?? 1)),
      clearLastError: true,
    });
    await ctx.scheduler.runAfter(0, internal.rocklaw.godNode.runConsoleAutoLoop, {
      loopToken: nextLoopToken,
    });
    return { status: 'started', loopToken: nextLoopToken };
  },
});

// ── Engine controls (god can start/stop) ─────────────────────────────────────
// These delegate to engine.startRocklaw / engine.stopRocklaw which handle
// the world clock + per-agent loop scheduling correctly.

export const startSim = mutation({
  args: {},
  handler: async (ctx) => {
    const state = await ctx.db.query('rl_world_state').unique();
    if (!state) throw new Error('Run initRocklaw first');
    if (state.isRunning) return { status: 'already_running' };

    await ctx.db.patch(state._id, { isRunning: true });

    // Start world clock
    await ctx.scheduler.runAfter(0, internal.rocklaw.engine.runRocklawTick, {});

    // Start each agent's individual loop
    const agents = await ctx.db.query('rl_agents').collect();
    for (const agent of agents) {
      await ctx.scheduler.runAfter(0, internal.rocklaw.bridgeNode.tickAgent, { agentName: agent.name });
    }

    return { status: 'started', agentCount: agents.length };
  },
});

export const stopSim = mutation({
  args: {},
  handler: async (ctx) => {
    const state = await ctx.db.query('rl_world_state').unique();
    if (!state) return { status: 'no_world_state' };
    // Setting isRunning = false causes:
    //   - world clock to exit after next tick
    //   - each agent loop to exit at start of their next wake
    await ctx.db.patch(state._id, { isRunning: false });
    return { status: 'stopped' };
  },
});

// ── Event suggestions ─────────────────────────────────────────────────────────

export const suggestEvents = action({
  args: {},
  handler: async (ctx): Promise<EventSuggestion[]> => {
    // Build world snapshot for the LLM
    const dashboard = await ctx.runQuery(api.rocklaw.god.getDashboard);
    if (!dashboard) return FALLBACK_SUGGESTIONS;

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      console.warn('[god] OPENROUTER_API_KEY not set, returning fallback suggestions');
      return FALLBACK_SUGGESTIONS;
    }

    const prompt = buildSuggestionPrompt(dashboard);

    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://rocklaw.sim',
          'X-Title': 'Rocklaw God Mode',
        },
        body: JSON.stringify({
          model: 'google/gemini-3.1-flash-lite-preview',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.9,
          max_tokens: 600,
        }),
      });

      if (!response.ok) throw new Error(`OpenRouter ${response.status}`);

      const data = await response.json() as any;
      const content = data.choices?.[0]?.message?.content ?? '';

      return parseEventSuggestions(content);
    } catch (err) {
      console.error('[god] suggestEvents failed:', err);
      return FALLBACK_SUGGESTIONS;
    }
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

export type EventSuggestion = {
  type: string;
  description: string;
  severity: 'low' | 'medium' | 'high';
};

function buildSuggestionPrompt(dashboard: any): string {
  const { worldState, agents, prices, tension, activeEvents } = dashboard;

  const agentLines = agents.map((a: any) =>
    `  ${a.name} (${a.role}) @ ${a.location} — energy:${a.energy} health:${a.health} hunger:${a.hunger} coin:${a.coin}`,
  ).join('\n');

  const shortages = prices
    .filter((p: any) => p.shortageLevel !== 'none')
    .map((p: any) => `  ${p.item}: ${p.shortageLevel} shortage (${p.price}c)`)
    .join('\n') || '  none';

  const activeList = activeEvents.length === 0
    ? '  none'
    : activeEvents.map((e: any) => `  [${e.severity}] ${e.description}`).join('\n');

  return `You are the world engine of a medieval village simulation called Rocklaw.
The player is the god of this world and wants to inject an interesting event.

Current state:
Day ${worldState?.day ?? '?'}, ${worldState?.timeOfDay ?? '?'} — Tick ${worldState?.tick ?? '?'}
Tension: ${tension.score}/100 (agent stress: ${tension.breakdown.agentStress}, econ: ${tension.breakdown.econStress}, social: ${tension.breakdown.socialStress})

Agents:
${agentLines}

Economic shortages:
${shortages}

Active events already running:
${activeList}

Suggest 5 world events the god could inject to create interesting drama or escalate existing tensions.
Consider the specific agents, their relationships, the economic state, and what would feel natural.
Return ONLY a JSON array (no other text):
[
  { "type": "short_name", "description": "One or two sentences as the villagers would experience it.", "severity": "low|medium|high" },
  ...
]`;
}

function parseEventSuggestions(content: string): EventSuggestion[] {
  // Try JSON block first
  const blockMatch = content.match(/```json\s*([\s\S]*?)```/);
  const jsonStr = blockMatch ? blockMatch[1] : content;

  try {
    const arr = JSON.parse(jsonStr.trim());
    if (Array.isArray(arr)) {
      return arr
        .filter((e: any) => e.type && e.description && e.severity)
        .slice(0, 6) as EventSuggestion[];
    }
  } catch {
    // Try to find a JSON array in the content
    const arrMatch = content.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try {
        const arr = JSON.parse(arrMatch[0]);
        if (Array.isArray(arr)) return arr.slice(0, 6);
      } catch { /* fall through */ }
    }
  }

  return FALLBACK_SUGGESTIONS;
}

// ── Agent config mutations (god-mode) ─────────────────────────────────────────

export const pauseAgent = mutation({
  args: { agentName: v.string() },
  handler: async (ctx, { agentName }) => {
    const agent = await ctx.db
      .query('rl_agents')
      .withIndex('name', (q) => q.eq('name', agentName))
      .unique();
    if (agent) await ctx.db.patch(agent._id, { paused: true });
  },
});

export const resumeAgent = mutation({
  args: { agentName: v.string() },
  handler: async (ctx, { agentName }) => {
    const agent = await ctx.db
      .query('rl_agents')
      .withIndex('name', (q) => q.eq('name', agentName))
      .unique();
    if (!agent) return;
    await ctx.db.patch(agent._id, { paused: false });
    // Re-kick the agent's tick loop
    await ctx.scheduler.runAfter(0, internal.rocklaw.bridgeNode.tickAgent, { agentName });
  },
});

// Internal mutation — DB-only patch, called from the action below.
export const _patchAgentModel = internalMutation({
  args: {
    agentName: v.string(),
    modelOverride: v.string(),
    providerOverride: v.optional(v.string()),
    currentModelPromptPrice: v.optional(v.number()),
    currentModelCompletionPrice: v.optional(v.number()),
  },
  handler: async (ctx, { agentName, modelOverride, providerOverride, currentModelPromptPrice, currentModelCompletionPrice }) => {
    const agent = await ctx.db
      .query('rl_agents')
      .withIndex('name', (q) => q.eq('name', agentName))
      .unique();
    if (agent) {
      await ctx.db.patch(agent._id, {
        modelOverride,
        providerOverride,
        currentModelPromptPrice,
        currentModelCompletionPrice,
      });
    }
  },
});

export const getAgentDetail = query({
  args: { agentName: v.string() },
  handler: async (ctx, { agentName }) => {
    const agent = await ctx.db
      .query('rl_agents')
      .withIndex('name', (q) => q.eq('name', agentName))
      .unique();
    if (!agent) return null;
    const rep = await ctx.db
      .query('rl_reputation')
      .withIndex('agentName', (q) => q.eq('agentName', agentName))
      .unique();
    const recentActions = await ctx.db
      .query('rl_actions_log')
      .withIndex('agentName', (q) => q.eq('agentName', agentName))
      .order('desc')
      .take(20);
    return { agent, rep, recentActions };
  },
});

const FALLBACK_SUGGESTIONS: EventSuggestion[] = [
  { type: 'drought', description: 'A dry spell has set in. The fields are cracking and grain prices will rise unless the harvest comes soon.', severity: 'medium' },
  { type: 'stranger_arrives', description: 'A cloaked traveller arrives at the gate, asking questions about the village and offering coin for lodging.', severity: 'low' },
  { type: 'old_debt', description: 'Word spreads that an old debt between two villagers has been called in. Tension at the market is palpable.', severity: 'medium' },
  { type: 'fire_scare', description: 'Smoke is spotted near the forge. It turns out to be nothing serious, but everyone is shaken.', severity: 'low' },
  { type: 'merchant_caravan', description: 'A merchant caravan has stopped at the gate for the day. Rare goods are available but prices are steep.', severity: 'low' },
];
