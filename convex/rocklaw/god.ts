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
      await ctx.scheduler.runAfter(0, internal.rocklaw.bridge.tickAgent, { agentName: agent.name });
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
          model: 'google/gemini-flash-1.5',
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
    await ctx.scheduler.runAfter(0, internal.rocklaw.bridge.tickAgent, { agentName });
  },
});

// Internal mutation — DB-only patch, called from the action below.
export const _patchAgentModel = internalMutation({
  args: {
    agentName: v.string(),
    modelOverride: v.string(),
    providerOverride: v.optional(v.string()),
  },
  handler: async (ctx, { agentName, modelOverride, providerOverride }) => {
    const agent = await ctx.db
      .query('rl_agents')
      .withIndex('name', (q) => q.eq('name', agentName))
      .unique();
    if (agent) await ctx.db.patch(agent._id, { modelOverride, providerOverride });
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
