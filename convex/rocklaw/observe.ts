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
import { canonicalizeItemQuantities, demandPressureForItem } from './economy';
import {
  RocklawLiveActionState,
  RocklawLiveMoveState,
  RocklawLiveSnapshot,
  ROCKLAW_AGENT_SPRITES,
  ROCKLAW_LIVE_TICK_INTERVAL_MS,
} from './liveScene';
import { ITEM_CONFIG } from './priceEngine';
import { getPlaceGraph } from './mapLayout';

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

function parsePendingAction(agent: any): Record<string, unknown> | null {
  if (typeof agent.pendingActionJson !== 'string') return null;
  try {
    return JSON.parse(agent.pendingActionJson) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toActionState(entry: any): RocklawLiveActionState {
  return {
    action: entry.action,
    target: entry.target ?? null,
    location: entry.location ?? null,
    message: entry.message ?? null,
    outcome: entry.outcome ?? null,
    outcomeNote: entry.outcomeNote ?? null,
  };
}

function inferMoveState(agent: any, pendingAction: Record<string, unknown> | null): RocklawLiveMoveState | null {
  if (!agent.busy || !pendingAction || pendingAction.action !== 'move') return null;
  const target = typeof pendingAction.location === 'string'
    ? pendingAction.location
    : typeof pendingAction.target === 'string'
      ? pendingAction.target
      : null;
  if (
    !target
    || typeof agent.pendingActionStartedTick !== 'number'
    || typeof agent.busyUntilTick !== 'number'
  ) {
    return null;
  }
  return {
    fromLocationId: agent.location,
    toLocationId: target,
    startedTick: agent.pendingActionStartedTick,
    endsTick: agent.busyUntilTick,
  };
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

export const getLiveSnapshot = query({
  args: {},
  handler: async (ctx): Promise<RocklawLiveSnapshot> => {
    const worldState = await ctx.db.query('rl_world_state').unique();
    const agents = await ctx.db.query('rl_agents').collect();
    const actions = await ctx.db.query('rl_actions_log').collect();
    const scenes = await ctx.db
      .query('rl_chat_scenes')
      .withIndex('status_location', (q) => q.eq('status', 'live'))
      .collect();

    const liveScenes = await Promise.all(
      scenes.map(async (scene) => ({
        sceneId: scene.sceneId,
        left: scene.agentA,
        right: scene.agentB,
        location: scene.location,
        nextSpeaker: scene.nextSpeaker,
        recentMessages: await getRenderableSceneMessages(ctx, scene, 3),
      })),
    );

    const latestActionByAgent = new Map<string, RocklawLiveActionState>();
    const recentActions = actions
      .slice()
      .sort((a, b) => b.tick - a.tick || b._creationTime - a._creationTime)
      .map((entry) => {
        const normalized = toActionState(entry);
        if (!latestActionByAgent.has(entry.agentName)) {
          latestActionByAgent.set(entry.agentName, normalized);
        }
        return normalized;
      })
      .slice(0, 16);

    const scenePartnerByAgent = new Map<string, string>();
    for (const scene of liveScenes) {
      scenePartnerByAgent.set(scene.left, scene.right);
      scenePartnerByAgent.set(scene.right, scene.left);
    }

    return {
      tick: worldState?.tick ?? 0,
      day: worldState?.day ?? 1,
      timeOfDay: worldState?.timeOfDay ?? 'morning',
      tickIntervalMs: ROCKLAW_LIVE_TICK_INTERVAL_MS,
      locations: getPlaceGraph(),
      agents: agents.map((agent) => {
        const pendingAction = parsePendingAction(agent);
        const moveState = inferMoveState(agent, pendingAction);
        const currentAction =
          pendingAction && typeof pendingAction.action === 'string'
            ? toActionState({
                action: pendingAction.action,
                target: pendingAction.target,
                location: pendingAction.location,
                message: pendingAction.text ?? pendingAction.message,
                outcome: 'pending',
                outcomeNote: null,
              })
            : latestActionByAgent.get(agent.name) ?? null;
        return {
          name: agent.name,
          role: agent.role,
          locationId: agent.location,
          busy: agent.busy,
          busyLabel: parsePendingActionLabel(agent),
          coin: agent.coin,
          energy: agent.energy,
          health: agent.health,
          hunger: agent.hunger,
          spriteKey: ROCKLAW_AGENT_SPRITES[agent.name] ?? 'villager',
          currentAction,
          moveState,
          scenePartner: scenePartnerByAgent.get(agent.name) ?? null,
        };
      }),
      liveScenes,
      recentActions,
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

function parseTransactionItems(itemsJson: string): Array<{ item: string; quantity: number }> {
  try {
    const parsed = JSON.parse(itemsJson) as Array<{ item?: string; quantity?: number }>;
    return Array.isArray(parsed)
      ? parsed
        .filter((entry) => typeof entry?.item === 'string' && typeof entry?.quantity === 'number' && entry.quantity > 0)
        .map((entry) => ({ item: entry.item!, quantity: entry.quantity! }))
      : [];
  } catch {
    return [];
  }
}

function summarizeTransactionItems(items: Array<{ item: string; quantity: number }>): string {
  if (items.length === 0) return 'nothing';
  return items
    .map((entry) => `${entry.quantity} ${entry.item}${entry.quantity === 1 ? '' : ''}`)
    .join(', ');
}

export const getStepSummary = query({
  args: {},
  handler: async (ctx) => {
    const worldState = await ctx.db.query('rl_world_state').unique();
    const agentDocs = await ctx.db.query('rl_agents').collect();
    const tick = worldState?.tick ?? 0;
    const day = worldState?.day ?? 1;
    const scenes = await ctx.db
      .query('rl_chat_scenes')
      .withIndex('status_location', (q) => q.eq('status', 'live'))
      .collect();
    const transactions = await ctx.db.query('rl_transactions').collect();
    const actions = await ctx.db.query('rl_actions_log').withIndex('tick', (q) => q.eq('tick', tick)).collect();
    const marketPrices = await ctx.db.query('rl_market_prices').collect();
    const priceHistory = await ctx.db.query('rl_price_history').withIndex('tick', (q) => q.eq('tick', tick)).collect();
    const allPriceHistory = await ctx.db.query('rl_price_history').collect();
    const reputations = await ctx.db.query('rl_reputation').collect();
    const reputationByAgent = new Map(reputations.map((entry) => [entry.agentName, entry.score]));

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
          sceneId: scene.sceneId,
          left: scene.agentA,
          right: scene.agentB,
          location: scene.location,
          nextSpeaker: scene.nextSpeaker,
          lastSpeaker: scene.lastSpeaker ?? null,
          stallTurns: scene.stallTurns ?? 0,
          openedTick: scene.openedTick,
          openedDay: scene.openedDay,
          recentMessages,
          pendingOffers: transactions
            .filter((txn) =>
              txn.status === 'pending'
              && ((txn.fromAgent === scene.agentA && txn.toAgent === scene.agentB)
                || (txn.fromAgent === scene.agentB && txn.toAgent === scene.agentA)),
            )
            .map((txn) => ({
              txnId: txn.txnId,
              fromAgent: txn.fromAgent,
              toAgent: txn.toAgent,
              kind: txn.kind,
              offerSummary: summarizeTransactionItems(parseTransactionItems(txn.offerJson)),
              requestSummary: summarizeTransactionItems(parseTransactionItems(txn.requestJson)),
            })),
          interruptionContext,
        };
      }),
    );

    const previousPriceByItem = new Map<string, { price: number; shortageLevel: string }>();
    for (const row of priceHistory) {
      const prior = allPriceHistory
        .filter((entry) => entry.item === row.item && (entry.tick < tick || (entry.tick === tick && entry.day < day)))
        .sort((a, b) => b.tick - a.tick || b.day - a.day)[0] ?? null;
      if (prior) {
        previousPriceByItem.set(row.item, {
          price: prior.price,
          shortageLevel: prior.shortageLevel,
        });
      }
    }

    const priceDeltas = priceHistory
      .map((row) => {
        const previous = previousPriceByItem.get(row.item) ?? null;
        let changePct = 0;
        if (previous && previous.price > 0) {
          changePct = ((row.price - previous.price) / previous.price) * 100;
        }
        return {
          item: row.item,
          price: row.price,
          changePct,
          shortageLevel: row.shortageLevel,
          previousPrice: previous?.price ?? null,
          previousShortageLevel: previous?.shortageLevel ?? null,
        };
      })
      .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
      .filter((d) => Math.abs(d.changePct) > 0.01);

    const transactionDeltas = transactions
      .filter((txn) =>
        (txn.createdTick === tick && txn.createdDay === day)
        || (txn.resolvedTick === tick && txn.resolvedDay === day),
      )
      .sort((a, b) =>
        ((b.resolvedTick ?? b.createdTick) - (a.resolvedTick ?? a.createdTick))
        || b._creationTime - a._creationTime,
      )
      .map((txn) => ({
        txnId: txn.txnId,
        fromAgent: txn.fromAgent,
        toAgent: txn.toAgent,
        kind: txn.kind,
        status: txn.status,
        createdThisTick: txn.createdTick === tick && txn.createdDay === day,
        resolvedThisTick: txn.resolvedTick === tick && txn.resolvedDay === day,
        offerSummary: summarizeTransactionItems(parseTransactionItems(txn.offerJson)),
        requestSummary: summarizeTransactionItems(parseTransactionItems(txn.requestJson)),
        message: txn.message ?? null,
        outcomeNote: txn.outcomeNote ?? null,
      }));

    const actionsByAgent = new Map<string, any[]>();
    // Sort by creation time to preserve the real sequence of events
    const sortedActions = [...actions].sort((a, b) => a._creationTime - b._creationTime);
    
    for (const action of sortedActions) {
      if (!actionsByAgent.has(action.agentName)) actionsByAgent.set(action.agentName, []);
      actionsByAgent.get(action.agentName)!.push(action);
    }

    const currentTickActions = [];
    for (const [agentName, agentActions] of actionsByAgent.entries()) {
      const latest = agentActions[agentActions.length - 1];
      
      if (agentActions.length === 1) {
        currentTickActions.push({
          agentName: latest.agentName,
          action: latest.action,
          target: latest.target ?? null,
          location: latest.location ?? null,
          message: latest.message ?? null,
          outcome: latest.outcome,
          outcomeNote: latest.outcomeNote ?? null,
        });
        continue;
      }

      // We have multiple actions for this agent in this tick. Merge them.
      let mergedAction = latest.action;
      let mergedTarget = latest.target ?? null;
      let mergedMessage = agentActions.find(a => a.message)?.message ?? null;
      
      const parts: string[] = [];
      const finished = agentActions.find(a => a.outcomeNote?.startsWith('Finished'));
      const started = agentActions.find(a => a.outcomeNote?.startsWith('Started'));
      const dialogue = agentActions.find(a => a.action === 'say' || a.action === 'chat');

      if (finished) {
        parts.push(finished.outcomeNote!);
      }
      
      if (dialogue && dialogue !== finished && dialogue !== started) {
        const verb = dialogue.action === 'say' ? 'said' : 'chatted';
        parts.push(verb + (dialogue.target ? ` with ${dialogue.target}` : ''));
      }

      if (started) {
        // If we finished and started the same thing, simplify
        if (finished && finished.action === started.action && finished.target === started.target) {
          parts.push(`started again ${started.outcomeNote!.replace('Started ', '').toLowerCase()}`);
        } else {
          parts.push(started.outcomeNote!.toLowerCase());
        }
      }

      // If we couldn't find specific started/finished patterns, just join everything unique
      let mergedNote = '';
      if (parts.length > 0) {
        // Capitalize first, join with commas and 'and'
        const sentence = parts.join(', ');
        const lastComma = sentence.lastIndexOf(', ');
        mergedNote = lastComma !== -1 
          ? sentence.substring(0, lastComma) + ' and ' + sentence.substring(lastComma + 2)
          : sentence;
      } else {
        mergedNote = agentActions
          .map(a => a.outcomeNote)
          .filter(Boolean)
          .filter((v, i, a) => a.indexOf(v) === i) // Unique
          .join(' · ');
      }

      currentTickActions.push({
        agentName,
        action: mergedAction,
        target: mergedTarget,
        location: latest.location ?? null,
        message: mergedMessage,
        outcome: latest.outcome,
        outcomeNote: mergedNote || null,
      });
    }

    const interruptLines: string[] = [];
    for (const scene of sceneSummaries) {
      if (scene.openedTick === tick && scene.openedDay === day && scene.interruptionContext) {
        const partnerForInterrupted = scene.interruptionContext.interruptedSpeaker === scene.left ? scene.right : scene.left;
        interruptLines.push(
          `${scene.interruptionContext.interruptedSpeaker} opener was interrupted when ${scene.interruptionContext.openingSpeaker} spoke first in their live chat with ${partnerForInterrupted}.`,
        );
      }
    }
    for (const entry of currentTickActions) {
      const note = entry.outcomeNote ?? '';
      if (!note) continue;
      if (note.includes('accepted your live opener')) {
        interruptLines.push(`${entry.agentName} live opener was accepted; the live scene is pending the other reply.`);
      } else if (note.includes('Your chat was sent to their thread instead')) {
        interruptLines.push(`${entry.agentName} live opener was deferred to thread.`);
      } else if (note.includes('replacing planned action') || note.includes('replying replaces')) {
        interruptLines.push(`${entry.agentName} replanned because of a live chat interrupt.`);
      }
    }

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
          ? describeBusyStatus(pendingAction, agent.busyUntilTick, tick)
          : null,
        provider: agent.providerOverride ?? null,
        model: agent.modelOverride ?? null,
        pendingNote: agent.pendingNote ?? null,
        coin: agent.coin,
        reputation: reputationByAgent.get(agent.name) ?? 50,
      };
    });

    return {
      tick,
      day,
      timeOfDay: worldState?.timeOfDay ?? 'morning',
      agents,
      liveScenes: sceneSummaries,
      currentTickActions,
      transactionDeltas,
      priceDeltas,
      interrupts: Array.from(new Set(interruptLines)),
      pendingOfferCount: transactions.filter((txn) => txn.status === 'pending').length,
      criticalShortages: marketPrices
        .filter((entry) => entry.shortageLevel === 'critical')
        .map((entry) => entry.item),
      biggestPriceMover: marketPrices
        .slice()
        .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))[0] ?? null,
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

export type EconomyDiagnostic = {
  item: string;
  price: number;
  basePrice: number;
  shortageLevel: 'none' | 'moderate' | 'critical';
  agentSupply: number;
  placeSupply: number;
  totalSupply: number;
  criticalSupply: number;
  moderateSupply: number;
  demandMultiplier: number;
  reasons: string[];
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

export const getEconomyDiagnostics = query({
  args: {},
  handler: async (ctx): Promise<EconomyDiagnostic[]> => {
    const agents = await ctx.db.query('rl_agents').collect();
    const placeStocks = await ctx.db.query('rl_place_stocks').collect();
    const events = await ctx.db
      .query('rl_world_events')
      .withIndex('active', (q) => q.eq('active', true))
      .collect();
    const marketPrices = await ctx.db.query('rl_market_prices').collect();
    const priceByItem = new Map(marketPrices.map((entry) => [entry.item, entry]));

    const totalHunger = agents.reduce((sum, agent) => sum + agent.hunger, 0);
    const lowHealthAgents = agents.filter((agent) => agent.health < 70).length;
    const blacksmiths = agents.filter((agent) => agent.role === 'Blacksmith').length;
    const innkeepers = agents.filter((agent) => agent.role === 'Innkeeper').length;

    return Object.entries(ITEM_CONFIG).map(([item, config]) => {
      const agentSupply = agents.reduce((sum, agent) => {
        const inventory = canonicalizeItemQuantities(JSON.parse(agent.inventory) as Record<string, number>);
        return sum + (inventory[item] ?? 0);
      }, 0);
      const placeSupply = placeStocks.reduce((sum, stock) => (
        stock.item === item ? sum + stock.quantity : sum
      ), 0);
      const totalSupply = agentSupply + placeSupply;
      const market = priceByItem.get(item);
      const shortageLevel = market?.shortageLevel ?? 'none';
      const demandMultiplier = demandPressureForItem(item, agents, events);
      const reasons: string[] = [];

      if (totalSupply <= config.criticalSupply) {
        reasons.push(`Supply is at ${totalSupply}, below the critical threshold of ${config.criticalSupply}.`);
      } else if (totalSupply <= config.moderateSupply) {
        reasons.push(`Supply is at ${totalSupply}, inside the shortage band up to ${config.moderateSupply}.`);
      } else {
        reasons.push(`Supply is at ${totalSupply}, above the shortage thresholds.`);
      }

      if (agentSupply === 0 && placeSupply > 0) {
        reasons.push(`All remaining stock is in market/storage listings (${placeSupply}); agents hold none directly.`);
      } else if (placeSupply === 0 && agentSupply > 0) {
        reasons.push(`No market stock is listed; the remaining ${agentSupply} units are held only by agents.`);
      } else if (placeSupply === 0 && agentSupply === 0) {
        reasons.push('There is no listed or carried supply anywhere in the village.');
      }

      if (demandMultiplier > 1.05) {
        reasons.push(`Demand pressure is ${demandMultiplier.toFixed(2)}x base.`);
      }

      if ((item === 'bread' || item === 'meal' || item === 'grain' || item === 'vegetable') && totalHunger > 0) {
        reasons.push(`Village hunger is ${totalHunger}, pushing food demand upward.`);
      }
      if ((item === 'medicine' || item === 'herb') && lowHealthAgents > 0) {
        reasons.push(`${lowHealthAgents} agent${lowHealthAgents === 1 ? '' : 's'} are below 70 health, increasing medical demand.`);
      }
      if ((item === 'iron_ore' || item === 'coal' || item === 'tool' || item === 'horseshoe' || item === 'knife') && blacksmiths > 0) {
        reasons.push(`${blacksmiths} blacksmith demand source${blacksmiths === 1 ? '' : 's'} depend on this supply chain.`);
      }
      if ((item === 'bread' || item === 'ale' || item === 'meal') && innkeepers > 0) {
        reasons.push(`${innkeepers} innkeeper demand source${innkeepers === 1 ? '' : 's'} increase hospitality demand.`);
      }

      const matchingEvents = events.filter((event) => {
        const description = event.description.toLowerCase();
        if ((item === 'grain' || item === 'bread' || item === 'meal') && /drought|famine|hunger/.test(description)) {
          return true;
        }
        if ((item === 'medicine' || item === 'herb') && /illness|plague|sick|fever/.test(description)) {
          return true;
        }
        return false;
      });
      for (const event of matchingEvents.slice(0, 2)) {
        reasons.push(`Active ${event.severity} event: ${event.description}`);
      }

      return {
        item,
        price: market?.price ?? config.basePrice,
        basePrice: market?.basePrice ?? config.basePrice,
        shortageLevel,
        agentSupply,
        placeSupply,
        totalSupply,
        criticalSupply: config.criticalSupply,
        moderateSupply: config.moderateSupply,
        demandMultiplier,
        reasons,
      };
    });
  },
});
