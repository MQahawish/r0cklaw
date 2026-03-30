/**
 * Observation Layer -- Phase 7
 *
 * Backend for the three observation panels:
 *   getAgentFiles   -- reads live workspace files for the agent inspector
 *   getRelationships -- computes interaction matrix from rl_actions_log
 *   getPriceHistory  -- returns price snapshots for economy charts
 */

import { v } from 'convex/values';
import { query } from '../_generated/server';
import { describeBusyStatus } from './actionTiming';

export type AgentFileEntry = {
  label: string;
  file: string;
  content: string | null; // null = file doesn't exist yet
};

export type SocialFileEntry = {
  otherAgent: string;
  content: string;
};

export const getAgentWorkspacePaths = query({
  args: {},
  handler: async (ctx) => {
    const agents = await ctx.db.query('rl_agents').collect();
    return agents.map((a) => ({ name: a.name, workspacePath: a.workspacePath }));
  },
});

function createChatThreadKey(agentA: string, agentB: string): string {
  return [agentA, agentB].sort((a, b) => a.localeCompare(b)).join('::');
}

function isRenderableSceneMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed === '...') return false;
  if (trimmed === '(waiting)') return false;
  return true;
}

export const getStepSummary = query({
  args: {},
  handler: async (ctx) => {
    const worldState = await ctx.db.query('rl_world_state').unique();
    const agentDocs = await ctx.db.query('rl_agents').collect();
    const scenes = await ctx.db
      .query('rl_chat_scenes')
      .withIndex('status_location', (q) => q.eq('status', 'live'))
      .collect();

    const sceneSummaries = await Promise.all(
      scenes.map(async (scene) => {
        const threadKey = createChatThreadKey(scene.agentA, scene.agentB);
        const threadMessages = await ctx.db
          .query('rl_chat_messages')
          .withIndex('thread_sent', (q) => q.eq('threadKey', threadKey))
          .collect();
        const recentMessages = threadMessages
          .slice()
          .sort((a, b) => a.sentDay - b.sentDay || a.sentTick - b.sentTick)
          .filter((entry) => isRenderableSceneMessage(entry.text))
          .slice(-4)
          .map((entry) => ({
            fromAgent: entry.fromAgent,
            text: entry.text,
          }));
        const interruptionContext =
          scene.interruptedContextPending && scene.interruptedSpeaker
            ? {
                interruptedSpeaker: scene.interruptedSpeaker,
                interruptedText: scene.interruptedText ?? '',
                openingSpeaker: scene.openingSpeaker ?? '',
                openingText: scene.openingText ?? '',
              }
            : null;
        return {
          left: scene.agentA,
          right: scene.agentB,
          location: scene.location,
          recentMessages,
          interruptionContext,
        };
      }),
    );

    const agents = agentDocs.map((agent) => {
      let pendingAction: Record<string, unknown> | null = null;
      if (typeof agent.pendingActionJson === 'string') {
        try {
          pendingAction = JSON.parse(agent.pendingActionJson) as Record<string, unknown>;
        } catch {
          pendingAction = null;
        }
      }
      return {
        name: agent.name,
        busy: agent.busy,
        busyUntilTick: agent.busyUntilTick ?? null,
        busyLabel: agent.busy
          ? describeBusyStatus(pendingAction, agent.busyUntilTick)
          : null,
      };
    });

    return {
      tick: worldState?.tick ?? 0,
      day: worldState?.day ?? 1,
      timeOfDay: worldState?.timeOfDay ?? 'morning',
      agents,
      liveScenes: sceneSummaries,
    };
  },
});

// ── Relationship graph ────────────────────────────────────────────────────────

// Action types considered cooperative (green edges)
const COOPERATIVE_ACTIONS = new Set([
  'give', 'trade', 'treat', 'counsel', 'bless', 'officiate',
  'run_errand', 'repair', // helping out
]);

export type RelationshipEdge = {
  from: string;
  to: string;
  count: number;         // total interactions
  cooperative: number;   // cooperative action count
  transactional: number; // buy/sell/negotiate count
};

export type RelationshipData = {
  agents: string[];
  edges: RelationshipEdge[];
};

export const getRelationships = query({
  args: {},
  handler: async (ctx): Promise<RelationshipData> => {
    const agentDocs = await ctx.db.query('rl_agents').collect();
    const agentNames = new Set(agentDocs.map((a) => a.name));

    // Pull all actions that have a target which is another agent
    const allActions = await ctx.db.query('rl_actions_log').collect();
    const relevant = allActions.filter(
      (a) => a.target && agentNames.has(a.target) && a.outcome !== 'failed',
    );

    // Build interaction map: key = "from→to"
    const edgeMap = new Map<string, RelationshipEdge>();
    for (const entry of relevant) {
      const key = `${entry.agentName}→${entry.target}`;
      if (!edgeMap.has(key)) {
        edgeMap.set(key, {
          from: entry.agentName,
          to: entry.target!,
          count: 0,
          cooperative: 0,
          transactional: 0,
        });
      }
      const edge = edgeMap.get(key)!;
      edge.count++;
      if (COOPERATIVE_ACTIONS.has(entry.action)) edge.cooperative++;
      if (['buy', 'sell', 'negotiate', 'trade'].includes(entry.action)) edge.transactional++;
    }

    // Merge bidirectional edges (A→B + B→A = one undirected edge)
    const merged = new Map<string, RelationshipEdge>();
    for (const [, edge] of edgeMap) {
      const canonical = [edge.from, edge.to].sort().join('↔');
      if (!merged.has(canonical)) {
        merged.set(canonical, { ...edge });
      } else {
        const m = merged.get(canonical)!;
        m.count += edge.count;
        m.cooperative += edge.cooperative;
        m.transactional += edge.transactional;
      }
    }

    return {
      agents: agentDocs.map((a) => a.name),
      edges: Array.from(merged.values()),
    };
  },
});

// ── Price history ─────────────────────────────────────────────────────────────

export type PricePoint = {
  tick: number;
  day: number;
  price: number;
  shortageLevel: 'none' | 'moderate' | 'critical';
};

export type ItemPriceHistory = {
  item: string;
  basePrice: number;
  history: PricePoint[]; // newest last
};

export const getPriceHistory = query({
  args: { ticks: v.optional(v.number()) },
  handler: async (ctx, { ticks = 50 }): Promise<ItemPriceHistory[]> => {
    const worldState = await ctx.db.query('rl_world_state').unique();
    const currentTick = worldState?.tick ?? 0;
    const since = Math.max(0, currentTick - ticks);

    // Current prices (for basePrice reference)
    const currentPrices = await ctx.db.query('rl_market_prices').collect();
    const basePriceMap = new Map(currentPrices.map((p) => [p.item, p.basePrice]));

    // History snapshots
    const snapshots = await ctx.db
      .query('rl_price_history')
      .withIndex('tick', (q) => q.gte('tick', since))
      .order('asc')
      .collect();

    // Group by item
    const byItem = new Map<string, PricePoint[]>();
    for (const snap of snapshots) {
      if (!byItem.has(snap.item)) byItem.set(snap.item, []);
      byItem.get(snap.item)!.push({
        tick: snap.tick,
        day: snap.day,
        price: snap.price,
        shortageLevel: snap.shortageLevel,
      });
    }

    return Array.from(byItem.entries()).map(([item, history]) => ({
      item,
      basePrice: basePriceMap.get(item) ?? 0,
      history,
    }));
  },
});
