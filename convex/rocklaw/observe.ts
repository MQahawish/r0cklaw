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

function parseInventory(inventoryJson: string): Array<{ item: string; quantity: number }> {
  try {
    const parsed = JSON.parse(inventoryJson) as Record<string, number>;
    return Object.entries(parsed)
      .filter(([, quantity]) => typeof quantity === 'number' && quantity > 0)
      .sort((a: [string, number], b: [string, number]) => b[1] - a[1])
      .map(([item, quantity]: [string, number]) => ({ item, quantity }));
  } catch {
    return [];
  }
}

function parsePendingActionLabel(agent: any): string | null {
  if (!agent.busy || !agent.pendingActionJson || agent.busyUntilTick === undefined) return null;
  try {
    const parsed = JSON.parse(agent.pendingActionJson) as Record<string, unknown>;
    return describeBusyStatus(parsed, agent.busyUntilTick);
  } catch {
    return `busy until tick ${agent.busyUntilTick}`;
  }
}

function createSceneThreadKey(scene: { agentA: string; agentB: string }) {
  return createChatThreadKey(scene.agentA, scene.agentB);
}

function compareChatMessageOrder(a: any, b: any) {
  return (
    a.sentDay - b.sentDay
    || a.sentTick - b.sentTick
    || (a.sceneOrder ?? 0) - (b.sceneOrder ?? 0)
  );
}

async function getRenderableSceneMessages(ctx: any, scene: { agentA: string; agentB: string }, limit?: number) {
  const threadKey = createSceneThreadKey(scene);
  const threadMessages = await ctx.db
    .query('rl_chat_messages')
    .withIndex('thread_sent', (q: any) => q.eq('threadKey', threadKey))
    .collect();
  const renderable = threadMessages
    .slice()
    .filter((entry: any) => !entry.sceneId || entry.sceneId === (scene as any).sceneId)
    .sort(compareChatMessageOrder)
    .filter((entry: any) => isRenderableSceneMessage(entry.text))
    .map((entry: any) => ({
      fromAgent: entry.fromAgent,
      text: entry.text,
      sentDay: entry.sentDay,
      sentTick: entry.sentTick,
    }));
  return typeof limit === 'number' ? renderable.slice(-limit) : renderable;
}

export const getFrontendWorld = query({
  args: {},
  handler: async (ctx) => {
    const worldState = await ctx.db.query('rl_world_state').unique();
    const agents = await ctx.db.query('rl_agents').collect();
    const actions = await ctx.db.query('rl_actions_log').collect();
    const scenes = await ctx.db
      .query('rl_chat_scenes')
      .withIndex('status_location', (q) => q.eq('status', 'live'))
      .collect();
    const transactions = await ctx.db.query('rl_transactions').collect();

    const liveScenes = await Promise.all(
      scenes.map(async (scene) => ({
        sceneId: scene.sceneId,
        left: scene.agentA,
        right: scene.agentB,
        location: scene.location,
        nextSpeaker: scene.nextSpeaker,
        recentMessages: await getRenderableSceneMessages(ctx, scene),
      })),
    );

    const latestActionByAgent = new Map<string, {
      action: string;
      target: string | null;
      location: string | null;
      message: string | null;
      tick: number;
      day: number;
      outcome: string;
      outcomeNote: string | null;
    }>();

    const recentActions = actions
      .slice()
      .sort((a, b) => b.tick - a.tick || b._creationTime - a._creationTime)
      .map((entry) => {
        const normalized = {
          agentName: entry.agentName,
          action: entry.action,
          target: entry.target ?? null,
          location: entry.location ?? null,
          message: entry.message ?? null,
          tick: entry.tick,
          day: entry.day,
          outcome: entry.outcome,
          outcomeNote: entry.outcomeNote ?? null,
        };
        if (!latestActionByAgent.has(entry.agentName)) {
          latestActionByAgent.set(entry.agentName, normalized);
        }
        return normalized;
      })
      .slice(0, 12);

    const recentTransactions = transactions
      .filter((txn) => txn.status !== 'pending')
      .slice()
      .sort((a, b) => (b.resolvedTick ?? b.createdTick) - (a.resolvedTick ?? a.createdTick) || b._creationTime - a._creationTime)
      .slice(0, 8)
      .map((txn) => ({
        txnId: txn.txnId,
        fromAgent: txn.fromAgent,
        toAgent: txn.toAgent,
        kind: txn.kind,
        status: txn.status,
        message: txn.message ?? null,
        outcomeNote: txn.outcomeNote ?? null,
      }));

    const liveSceneByAgent = new Map<string, {
      partner: string;
      recentMessages: Array<{ fromAgent: string; text: string; sentDay: number; sentTick: number }>;
    }>();
    for (const scene of liveScenes) {
      liveSceneByAgent.set(scene.left, {
        partner: scene.right,
        recentMessages: scene.recentMessages,
      });
      liveSceneByAgent.set(scene.right, {
        partner: scene.left,
        recentMessages: scene.recentMessages,
      });
    }

    return {
      tick: worldState?.tick ?? 0,
      day: worldState?.day ?? 1,
      timeOfDay: worldState?.timeOfDay ?? 'morning',
      agents: agents.map((agent) => ({
        name: agent.name,
        role: agent.role,
        location: agent.location,
        busy: agent.busy,
        busyLabel: parsePendingActionLabel(agent),
        coin: agent.coin,
        latestAction: latestActionByAgent.get(agent.name) ?? null,
        currentScene: liveSceneByAgent.get(agent.name) ?? null,
      })),
      liveScenes,
      recentActions,
      recentTransactions,
    };
  },
});

export const getFrontendAgentDetails = query({
  args: { agentName: v.string() },
  handler: async (ctx, { agentName }) => {
    const agent = await ctx.db.query('rl_agents').withIndex('name', (q) => q.eq('name', agentName)).unique();
    if (!agent) return null;

    const reputation = await ctx.db
      .query('rl_reputation')
      .withIndex('agentName', (q) => q.eq('agentName', agentName))
      .unique();

    const actions = (await ctx.db.query('rl_actions_log').collect())
      .filter((entry) => entry.agentName === agentName)
      .sort((a, b) => b.tick - a.tick || b._creationTime - a._creationTime);

    const allScenes = await ctx.db
      .query('rl_chat_scenes')
      .withIndex('status_location', (q) => q.eq('status', 'live'))
      .collect();
    const currentScene = allScenes.find((scene) => scene.agentA === agentName || scene.agentB === agentName) ?? null;
    const scenePartner = currentScene
      ? currentScene.agentA === agentName ? currentScene.agentB : currentScene.agentA
      : null;
    const recentSceneMessages = currentScene ? await getRenderableSceneMessages(ctx, currentScene, 6) : [];

    const transactions = await ctx.db.query('rl_transactions').collect();
    const incomingOffers = transactions
      .filter((txn) => txn.toAgent === agentName && txn.status === 'pending')
      .sort((a, b) => b.createdTick - a.createdTick || b._creationTime - a._creationTime)
      .map((txn) => ({
        txnId: txn.txnId,
        fromAgent: txn.fromAgent,
        kind: txn.kind,
        message: txn.message ?? null,
      }));
    const outgoingOffers = transactions
      .filter((txn) => txn.fromAgent === agentName && txn.status === 'pending')
      .sort((a, b) => b.createdTick - a.createdTick || b._creationTime - a._creationTime)
      .map((txn) => ({
        txnId: txn.txnId,
        toAgent: txn.toAgent,
        kind: txn.kind,
        message: txn.message ?? null,
      }));

    return {
      name: agent.name,
      role: agent.role,
      location: agent.location,
      coin: agent.coin,
      energy: agent.energy,
      health: agent.health,
      hunger: agent.hunger,
      reputation: reputation?.score ?? 50,
      busy: agent.busy,
      busyLabel: parsePendingActionLabel(agent),
      pendingNote: agent.pendingNote ?? null,
      inventory: parseInventory(agent.inventory),
      latestAction: actions[0]
        ? {
            action: actions[0].action,
            target: actions[0].target ?? null,
            location: actions[0].location ?? null,
            message: actions[0].message ?? null,
            tick: actions[0].tick,
            day: actions[0].day,
            outcome: actions[0].outcome,
            outcomeNote: actions[0].outcomeNote ?? null,
          }
        : null,
      recentActions: actions.slice(0, 8).map((entry) => ({
        action: entry.action,
        target: entry.target ?? null,
        location: entry.location ?? null,
        message: entry.message ?? null,
        tick: entry.tick,
        day: entry.day,
        outcome: entry.outcome,
        outcomeNote: entry.outcomeNote ?? null,
      })),
      currentScene: currentScene
        ? {
            partner: scenePartner,
            location: currentScene.location,
            nextSpeaker: currentScene.nextSpeaker,
            recentMessages: recentSceneMessages,
          }
        : null,
      incomingOffers,
      outgoingOffers,
    };
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
          .filter((entry: any) => !entry.sceneId || entry.sceneId === scene.sceneId)
          .sort(compareChatMessageOrder)
          .filter((entry) => isRenderableSceneMessage(entry.text))
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
        provider: agent.providerOverride ?? null,
        model: agent.modelOverride ?? null,
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
