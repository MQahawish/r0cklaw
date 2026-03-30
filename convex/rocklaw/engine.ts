/**
 * Rocklaw World Clock -- Phase 6 (action-driven ticks)
 *
 * The engine is now purely a world clock:
 *   1. Advances the global tick counter + time-of-day every TICK_INTERVAL_MS
 *   2. Clears stale busy flags
 *   3. Runs compaction every 10 ticks
 *
 * Agents are NO LONGER fired by the global loop.
 * Each agent self-schedules its own next tick from bridgeNode.tickAgent,
 * waiting the engine-owned action duration before waking again.
 *
 * startRocklaw() starts the world clock AND fires the first tick for every agent.
 * stopRocklaw() sets isRunning = false; the clock exits after the next tick.
 */

import { v } from 'convex/values';
import { action, mutation, internalAction, internalMutation, internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';
import { DayPeriod } from './dayCycle';

// Base tick duration in ms. 1 tick = one time-of-day period in the 6-period day cycle.
// 30 s per period = ~180 s per simulated day. Easy to watch in dev.
export const TICK_INTERVAL_MS = 30_000;

// How often compaction runs (in ticks).
const COMPACT_EVERY_N_TICKS = 10;

// ── Internal helpers ─────────────────────────────────────────────────────────

export const getWorldState = internalQuery({
  args: {},
  handler: async (ctx) => ctx.db.query('rl_world_state').unique(),
});

export const setRunning = internalMutation({
  args: { isRunning: v.boolean() },
  handler: async (ctx, { isRunning }) => {
    const state = await ctx.db.query('rl_world_state').unique();
    if (!state) throw new Error('[engine] rl_world_state not found — run initRocklaw first');
    await ctx.db.patch(state._id, { isRunning });
  },
});

// ── World clock loop ─────────────────────────────────────────────────────────

/**
 * The world clock.  Runs every TICK_INTERVAL_MS.
 * Only advances time and handles housekeeping.
 * Does NOT fire agents — they self-schedule from bridgeNode.tickAgent.
 */
export const runRocklawTick = internalAction({
  args: {},
  handler: async (ctx) => {
    const state = await ctx.runQuery(internal.rocklaw.engine.getWorldState);
    if (!state) {
      console.error('[engine] No world state — bailing out');
      return;
    }
    if (!state.isRunning) {
      console.log('[engine] isRunning = false, world clock stopping');
      return;
    }

    // Advance tick counter + time-of-day
    const next = await ctx.runMutation(internal.rocklaw.init.advanceTick, {});
    if (!next) {
      console.error('[engine] advanceTick returned nothing');
      return;
    }

    const { tick, day, timeOfDay } = next;
    console.log(`[engine] clock tick ${tick} — Day ${day}, ${timeOfDay}`);

    await ctx.runMutation((internal as any).rocklaw.economy.advanceEconomicState, {
      tick,
      day,
      timeOfDay,
    });

    // Clear any stale busy flags
    await ctx.runMutation(internal.rocklaw.engine.clearStaleBusy, { tick });

    // Refresh lastInput for Rocklaw sprites — prevents AI Town idle-kick after 5 min
    await ctx.runMutation(internal.rocklaw.visualBridge.keepAliveVisualAgents, {});

    // Run compaction every COMPACT_EVERY_N_TICKS
    if (tick % COMPACT_EVERY_N_TICKS === 0) {
      console.log(`[engine] tick ${tick}: triggering compaction`);
      await ctx.runAction(internal.rocklaw.compactNode.runCompaction, {});
    }

    // Reschedule the clock
    await ctx.scheduler.runAfter(TICK_INTERVAL_MS, internal.rocklaw.engine.runRocklawTick, {});
  },
});

// ── Busy-flag cleanup ─────────────────────────────────────────────────────────

export const clearStaleBusy = internalMutation({
  args: { tick: v.number() },
  handler: async (ctx, { tick }) => {
    const allAgents = await ctx.db.query('rl_agents').collect();
    for (const agent of allAgents) {
      if (
        agent.busy
        && agent.busyUntilTick !== undefined
        && agent.busyUntilTick <= tick
        && !agent.pendingActionJson
      ) {
        await ctx.db.patch(agent._id, {
          busy: false,
          busyUntilTick: undefined,
          pendingActionStartedTick: undefined,
          pendingActionStartedDay: undefined,
        });
      }
    }
  },
});

export const getNonBusyAgents = internalQuery({
  args: { tick: v.number() },
  handler: async (ctx, { tick }) => {
    const agents = await ctx.db.query('rl_agents').collect();
    return agents
      .filter((a) => !a.busy || (a.busyUntilTick !== undefined && a.busyUntilTick <= tick))
      .map((a) => a.name);
  },
});

// ── Public controls ──────────────────────────────────────────────────────────

export const startRocklaw = mutation({
  args: {},
  handler: async (ctx) => {
    const state = await ctx.db.query('rl_world_state').unique();
    if (!state) throw new Error('[engine] Run initRocklaw first');
    if (state.isRunning) {
      console.log('[engine] Already running');
      return { status: 'already_running' };
    }
    await ctx.db.patch(state._id, { isRunning: true });

    // Start the world clock
    await ctx.scheduler.runAfter(0, internal.rocklaw.engine.runRocklawTick, {});

    // Kick off each agent's individual tick loop
    const agents = await ctx.db.query('rl_agents').collect();
    for (const agent of agents) {
      await ctx.scheduler.runAfter(0, internal.rocklaw.bridgeNode.tickAgent, { agentName: agent.name });
    }

    console.log(`[engine] Rocklaw started — world clock + ${agents.length} agent loops`);
    return { status: 'started', agentCount: agents.length };
  },
});

export const stopRocklaw = mutation({
  args: {},
  handler: async (ctx) => {
    const state = await ctx.db.query('rl_world_state').unique();
    if (!state) return { status: 'no_world_state' };
    await ctx.db.patch(state._id, { isRunning: false });
    console.log('[engine] Rocklaw stopping (clock exits after next tick; agent loops will drain)');
    return { status: 'stopped' };
  },
});

/**
 * Fire exactly one tick for one or all agents, without starting the continuous loop.
 * Useful for testing / Phase 1 verification.
 *
 * Usage:  npx convex run rocklaw/engine:manualTick
 *         npx convex run rocklaw/engine:manualTick '{"agentName":"Elena Voss"}'
 */
export const manualTick = action({
  args: {
    agentName: v.optional(v.string()),
  },
  handler: async (ctx, { agentName }): Promise<{
    tick: number;
    day: number;
    timeOfDay: DayPeriod;
    agents: string[];
  }> => {
    const state = await ctx.runQuery(internal.rocklaw.engine.getWorldState);
    if (!state) throw new Error('[engine] Run initRocklaw first');

    // Advance time
    const next:
      | { tick: number; day: number; timeOfDay: DayPeriod }
      | null = await ctx.runMutation(internal.rocklaw.init.advanceTick, {});
    if (!next) throw new Error('[engine] advanceTick failed');

    const { tick, day, timeOfDay } = next;
    console.log(`[engine] manualTick — tick ${tick}, Day ${day}, ${timeOfDay}`);

    await ctx.runMutation((internal as any).rocklaw.economy.advanceEconomicState, {
      tick,
      day,
      timeOfDay,
    });

    if (agentName) {
      await ctx.runAction(internal.rocklaw.bridgeNode.tickAgent, { agentName, _manual: true });
      return { tick, day, timeOfDay, agents: [agentName] };
    }

    const candidateAgents = await ctx.runQuery(internal.rocklaw.engine.getNonBusyAgents, { tick });
    const allAgents: string[] = [];
    for (const name of candidateAgents) {
      const agentDoc = await ctx.runQuery(internal.rocklaw.bridge.getAgent, { agentName: name });
      if (agentDoc?.busy && agentDoc.pendingActionJson && agentDoc.busyUntilTick !== undefined && agentDoc.busyUntilTick <= tick) {
        const completion = await ctx.runMutation(internal.rocklaw.bridge.completePendingAction, {
          agentName: name,
          tick,
          day,
        });
        if (completion && 'action' in completion) {
          await ctx.runAction(internal.rocklaw.worldRefreshNode.appendHeartbeat, {
            agentName: name,
            line: summariseManualAction(completion.action, day, timeOfDay, completion.outcome, completion.note),
          });
        }
      }
      const refreshed = await ctx.runQuery(internal.rocklaw.bridge.getAgent, { agentName: name });
      if (refreshed && !refreshed.busy) {
        allAgents.push(name);
      }
    }

    // Process existing live chat scenes first. Participants do not take normal
    // world actions while the scene is active.
    const liveScenes = await ctx.runQuery(internal.rocklaw.bridge.listLiveChatScenes, {});
    const sceneParticipants = new Set<string>();
    for (const scene of liveScenes) {
      sceneParticipants.add(scene.agentA);
      sceneParticipants.add(scene.agentB);
    }

    for (const scene of liveScenes) {
      const speaker = scene.nextSpeaker;
      const currentScene = await ctx.runQuery(internal.rocklaw.bridge.getLiveChatScene, {
        agentName: speaker,
      });
      if (!currentScene) continue;

      const partner = currentScene.partner;
      let interruptedDraftContext: string | null = null;
      if (currentScene.interruptedContextPending && currentScene.interruptedSpeaker === speaker && currentScene.interruptedActionJson) {
        try {
          const interruptedAction = JSON.parse(currentScene.interruptedActionJson) as Record<string, unknown>;
          if (typeof interruptedAction.intent === 'string') {
            interruptedDraftContext = `Your interrupted draft also carried intent:"${interruptedAction.intent}". If you still want that commerce move, restate it naturally in this turn's chat.`;
          }
        } catch {
          // ignore malformed stored draft context
        }
      }
      const interruptedContext =
        currentScene.interruptedContextPending && currentScene.interruptedSpeaker === speaker
          ? [
              `You were about to say: "${currentScene.interruptedText ?? ''}"`,
              `But ${currentScene.openingSpeaker ?? partner} spoke first and said: "${currentScene.openingText ?? ''}"`,
              ...(interruptedDraftContext ? [interruptedDraftContext] : []),
              'Respond naturally from there.',
            ].join('\n')
          : null;
      const speakerPlan = await ctx.runAction(internal.rocklaw.bridgeNode.planAgentAction, {
        agentName: speaker,
        tick,
        day,
        timeOfDay,
        promptPrefix: [
          `You are already in a live chat with ${partner} at ${currentScene.location}.`,
          'Your valid actions right now are `chat` and `leave_chat`.',
          'If you want to buy, sell, trade, give, pay, accept, or reject inside this scene, do it through `chat` using a spoken `text` plus `intent` and the relevant fields.',
          'You cannot take a normal world action until you leave this chat scene.',
          'Make progress. Do one of these each turn: ask one direct question, make one concrete offer, accept/reject a pending offer with the exact structured fields, answer the partner\'s last question, or leave_chat.',
          'Do not repeat yourself, do not restate the same offer twice, and do not use filler like "..." or "waiting for your response".',
          'If this conversation is no longer moving toward a concrete result, end it with leave_chat and a brief goodbye.',
          ...(interruptedContext ? ['', interruptedContext] : []),
        ].join('\n'),
        pendingNote: interruptedContext
          ? `LIVE CHAT: You are speaking with ${partner}. ${interruptedContext} Make concrete progress or end the chat.`
          : `LIVE CHAT: You are speaking with ${partner}. Use chat to make concrete progress with one clear step, or leave_chat to end the scene.`,
      });

      if (speakerPlan.status === 'rejected') {
        await ctx.runAction(internal.rocklaw.worldRefreshNode.appendHeartbeat, {
          agentName: speakerPlan.agentName,
          line: speakerPlan.heartbeatLine,
        });
        if (speakerPlan.pendingNote) {
          await ctx.runMutation(internal.rocklaw.bridge.setAgentPendingNote, {
            agentName: speakerPlan.agentName,
            note: speakerPlan.pendingNote,
          });
        }
      } else {
        const sceneResult = await ctx.runMutation(internal.rocklaw.bridge.commitAction, {
          agentName: speaker,
          action: JSON.stringify(speakerPlan.action),
          tick,
          day,
          chatDeliveryOverride: speakerPlan.action.action === 'chat' ? 'live' : undefined,
        });
        if (currentScene.interruptedContextPending && currentScene.interruptedSpeaker === speaker) {
          await ctx.runMutation(internal.rocklaw.bridge.consumeInterruptedChatContext, {
            agentName: speaker,
          });
        }
        await ctx.runAction(internal.rocklaw.worldRefreshNode.appendHeartbeat, {
          agentName: speaker,
          line: summariseManualAction(speakerPlan.action, day, timeOfDay, sceneResult?.outcome, sceneResult?.note),
        });
        const speakerDoc = await ctx.runQuery(internal.rocklaw.bridge.getAgent, { agentName: speaker });
        if (speakerDoc) {
          await ctx.runAction(internal.rocklaw.bridgeNode.appendTickDebugRecord, {
            workspacePath: speakerDoc.workspacePath,
            recordJson: JSON.stringify({
              timestamp: new Date().toISOString(),
              phase: 'completed',
              agentName: speaker,
              tick,
              day,
              timeOfDay,
              parsedAction: speakerPlan.action,
              validation: {
                outcome: sceneResult?.outcome ?? 'success',
                note: sceneResult?.note ?? null,
              },
            }),
          });
        }
      }

      const partnerScene = await ctx.runQuery(internal.rocklaw.bridge.getLiveChatScene, { agentName: partner });
      if (partnerScene) {
        await ctx.runAction(internal.rocklaw.worldRefreshNode.appendHeartbeat, {
          agentName: partner,
          line: `- Day ${day} ${timeOfDay}: chatting with ${partnerScene.partner} (${partnerScene.yourTurn ? 'your turn' : 'waiting'})`,
        });
      }
    }

    // In manual mode, stage non-scene actions first so new live chats can
    // interrupt and replace other planned actions before anything commits.
    const agents = allAgents
      .filter((name: string) => !sceneParticipants.has(name));
    const plannedResults = [];
    const PLAN_BATCH_SIZE = 2;
    for (let index = 0; index < agents.length; index += PLAN_BATCH_SIZE) {
      const batch = agents.slice(index, index + PLAN_BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((name: string) =>
          ctx.runAction(internal.rocklaw.bridgeNode.planAgentAction, {
            agentName: name,
            tick,
            day,
            timeOfDay,
          })),
      );
      plannedResults.push(...batchResults);
    }

    for (const result of plannedResults) {
      if (result.status !== 'rejected') continue;
      await ctx.runAction(internal.rocklaw.worldRefreshNode.appendHeartbeat, {
        agentName: result.agentName,
        line: result.heartbeatLine,
      });
      if (result.pendingNote) {
        await ctx.runMutation(internal.rocklaw.bridge.setAgentPendingNote, {
          agentName: result.agentName,
          note: result.pendingNote,
        });
      }
    }

    const actionablePlans = plannedResults
      .filter((result: any) => result.status === 'action') as Array<{ status: 'action'; agentName: string; action: any }>;
    const agentDocs = await Promise.all(
      actionablePlans.map((plan) => ctx.runQuery(internal.rocklaw.bridge.getAgent, { agentName: plan.agentName })),
    );
    const agentByName = new Map(
      agentDocs.filter(Boolean).map((doc) => [doc!.name, doc!]),
    );
    const activeTalkPartnerLists = await Promise.all(
      actionablePlans.map((plan) => ctx.runQuery(internal.rocklaw.bridge.getActiveTalkPartners, { agentName: plan.agentName })),
    );
    const activeTalkPartners = new Map(
      actionablePlans.map((plan, index) => [plan.agentName, activeTalkPartnerLists[index] ?? []]),
    );

    const finalActions = new Map(actionablePlans.map((plan) => [plan.agentName, plan.action]));
    const deferredChats = new Set<string>();
    const deferredChatReasons = new Map<string, string>();
    const engagedAgents = new Set<string>(sceneParticipants);
    const interruptedOpeners = new Set<string>();
    const interruptedOpenerNotes = new Map<string, string>();

    const liveIncomingByTarget = new Map<string, Array<{ fromAgent: string; text: string; actionDoc: any }>>();
    for (const plan of actionablePlans) {
      const actionDoc = plan.action;
      if (actionDoc.action !== 'chat' || typeof actionDoc.target !== 'string') continue;
      const sender = agentByName.get(plan.agentName);
      const target = agentByName.get(actionDoc.target);
      if (!sender || !target) continue;
      const targetActivePartners = activeTalkPartners.get(actionDoc.target) ?? [];
      if (targetActivePartners.some((partner: string) => partner !== plan.agentName)) {
        deferredChats.add(plan.agentName);
        deferredChatReasons.set(
          plan.agentName,
          `${actionDoc.target} is already busy chatting with someone else. Your chat was sent to their thread instead.`,
        );
        continue;
      }
      if (sender.location !== target.location) continue;
      const incoming = liveIncomingByTarget.get(actionDoc.target) ?? [];
      incoming.push({
        fromAgent: plan.agentName,
        text: typeof actionDoc.text === 'string'
          ? actionDoc.text
          : typeof actionDoc.message === 'string'
          ? actionDoc.message
          : '',
        actionDoc,
      });
      liveIncomingByTarget.set(actionDoc.target, incoming);
    }

    for (const [targetName, incoming] of liveIncomingByTarget.entries()) {
      if (engagedAgents.has(targetName)) {
        const targetScene = await ctx.runQuery(internal.rocklaw.bridge.getLiveChatScene, {
          agentName: targetName,
        });
        incoming.forEach((entry) => {
          if (targetScene && targetScene.partner === entry.fromAgent) {
            deferredChats.delete(entry.fromAgent);
            deferredChatReasons.delete(entry.fromAgent);
            engagedAgents.add(entry.fromAgent);
            return;
          }
          deferredChats.add(entry.fromAgent);
          deferredChatReasons.set(
            entry.fromAgent,
            `${targetName} stayed busy in another live chat. Your chat was sent to their thread instead.`,
          );
        });
        continue;
      }

      const targetPlanned = finalActions.get(targetName);
      if (!targetPlanned) {
        incoming.forEach((entry) => {
          deferredChats.add(entry.fromAgent);
          deferredChatReasons.set(
            entry.fromAgent,
            `${targetName} was not available to reply live. Your chat was sent to their thread instead.`,
          );
        });
        continue;
      }

      const mutualIncoming = incoming.find((entry) =>
        targetPlanned.action === 'chat' && targetPlanned.target === entry.fromAgent,
      );
      if (mutualIncoming) {
        const targetDoc = agentByName.get(targetName);
        if (targetDoc) {
          const openingText = typeof targetPlanned.text === 'string'
            ? targetPlanned.text
            : typeof targetPlanned.message === 'string'
            ? targetPlanned.message
            : '';
          await ctx.runMutation(internal.rocklaw.bridge.createLiveChatScene, {
            agentA: targetName,
            agentB: mutualIncoming.fromAgent,
            location: targetDoc.location,
            nextSpeaker: mutualIncoming.fromAgent,
            openingSpeaker: targetName,
            openingText,
            interruptedSpeaker: mutualIncoming.fromAgent,
            interruptedText: mutualIncoming.text,
            interruptedActionJson: JSON.stringify(mutualIncoming.actionDoc),
            tick,
            day,
          });
        }
        deferredChats.delete(targetName);
        deferredChatReasons.delete(targetName);
        deferredChats.delete(mutualIncoming.fromAgent);
        deferredChatReasons.delete(mutualIncoming.fromAgent);
        engagedAgents.add(targetName);
        engagedAgents.add(mutualIncoming.fromAgent);
        interruptedOpeners.add(mutualIncoming.fromAgent);
        interruptedOpenerNotes.set(
          mutualIncoming.fromAgent,
          `You were about to say "${mutualIncoming.text}", but ${targetName} spoke first: "${typeof targetPlanned.text === 'string' ? targetPlanned.text : typeof targetPlanned.message === 'string' ? targetPlanned.message : ''}"`,
        );
        incoming
          .filter((entry) => entry.fromAgent !== mutualIncoming.fromAgent)
          .forEach((entry) => {
            deferredChats.add(entry.fromAgent);
            deferredChatReasons.set(
              entry.fromAgent,
              `${targetName} decided to continue a live chat with ${mutualIncoming.fromAgent} instead. Your chat was sent to their thread.`,
            );
          });
        continue;
      }

      const interruptResult = await ctx.runAction(internal.rocklaw.bridgeNode.resolveChatInterrupt, {
        agentName: targetName,
        tick,
        day,
        timeOfDay,
        previousActionJson: JSON.stringify(targetPlanned),
        incomingJson: JSON.stringify(incoming),
      });

      if (interruptResult.status === 'rejected') {
        await ctx.runAction(internal.rocklaw.worldRefreshNode.appendHeartbeat, {
          agentName: interruptResult.agentName,
          line: interruptResult.heartbeatLine,
        });
        if (interruptResult.pendingNote) {
          await ctx.runMutation(internal.rocklaw.bridge.setAgentPendingNote, {
            agentName: interruptResult.agentName,
            note: interruptResult.pendingNote,
          });
        }
        incoming.forEach((entry) => {
          deferredChats.add(entry.fromAgent);
          deferredChatReasons.set(
            entry.fromAgent,
            `${targetName} did not take your live chat this tick. Your chat was sent to their thread instead.`,
          );
        });
        continue;
      }

      deferredChats.delete(targetName);
      deferredChatReasons.delete(targetName);
      finalActions.set(targetName, interruptResult.action);
      const chosenSender =
        interruptResult.action.action === 'chat' && typeof interruptResult.action.target === 'string'
          ? interruptResult.action.target
          : null;
      if (chosenSender && incoming.some((entry) => entry.fromAgent === chosenSender)) {
        const targetDoc = agentByName.get(targetName);
        if (targetDoc) {
          await ctx.runMutation(internal.rocklaw.bridge.createLiveChatScene, {
            agentA: targetName,
            agentB: chosenSender,
            location: targetDoc.location,
            nextSpeaker: chosenSender,
            tick,
            day,
          });
        }
        deferredChats.delete(chosenSender);
        deferredChatReasons.delete(chosenSender);
        engagedAgents.add(targetName);
        engagedAgents.add(chosenSender);
      }
      incoming
        .filter((entry) => entry.fromAgent !== chosenSender)
        .forEach((entry) => {
          deferredChats.add(entry.fromAgent);
          deferredChatReasons.set(
            entry.fromAgent,
            chosenSender
              ? `${targetName} decided to continue a live chat with ${chosenSender} instead. Your chat was sent to their thread.`
              : `${targetName} kept their planned action instead of replying live. Your chat was sent to their thread.`,
          );
        });
    }

    for (const name of agents) {
      const actionDoc = finalActions.get(name);
      if (!actionDoc) continue;
      if (interruptedOpeners.has(name) && actionDoc.action === 'chat') {
        await ctx.runAction(internal.rocklaw.worldRefreshNode.appendHeartbeat, {
          agentName: name,
          line: `- Day ${day} ${timeOfDay}: live chat opened with ${actionDoc.target} (your opener was interrupted and saved for context)`,
        });
        const agentDoc = agentByName.get(name);
        if (agentDoc) {
          await ctx.runAction(internal.rocklaw.bridgeNode.appendTickDebugRecord, {
            workspacePath: agentDoc.workspacePath,
            recordJson: JSON.stringify({
              timestamp: new Date().toISOString(),
              phase: 'completed',
              agentName: name,
              tick,
              day,
              timeOfDay,
              parsedAction: actionDoc,
              validation: {
                outcome: 'success',
                note: interruptedOpenerNotes.get(name) ?? 'Your live opener was interrupted and stored as scene context.',
              },
            }),
          });
        }
        continue;
      }
      const isForcedLiveChat =
        actionDoc.action === 'chat'
        && typeof actionDoc.target === 'string'
        && !deferredChats.has(name)
        && engagedAgents.has(name)
        && engagedAgents.has(actionDoc.target);
      const result = await ctx.runMutation(internal.rocklaw.bridge.commitAction, {
        agentName: name,
        action: JSON.stringify(actionDoc),
        tick,
        day,
        chatDeliveryOverride:
          actionDoc.action === 'chat'
            ? deferredChats.has(name)
              ? 'deferred'
              : isForcedLiveChat
              ? 'live'
              : undefined
            : undefined,
        chatDeferredReason:
          actionDoc.action === 'chat' && deferredChats.has(name)
            ? deferredChatReasons.get(name)
            : undefined,
      });
      await ctx.runAction(internal.rocklaw.worldRefreshNode.appendHeartbeat, {
        agentName: name,
        line: summariseManualAction(actionDoc, day, timeOfDay, result?.outcome, result?.note),
      });
      const agentDoc = agentByName.get(name);
      if (agentDoc) {
        await ctx.runAction(internal.rocklaw.bridgeNode.appendTickDebugRecord, {
          workspacePath: agentDoc.workspacePath,
          recordJson: JSON.stringify({
            timestamp: new Date().toISOString(),
            phase: 'completed',
            agentName: name,
            tick,
            day,
            timeOfDay,
            parsedAction: actionDoc,
            validation: {
              outcome: result?.outcome ?? 'success',
              note: result?.note ?? null,
            },
          }),
        });
      }
    }

    return { tick, day, timeOfDay, agents: allAgents };
  },
});

function summariseManualAction(
  action: Record<string, unknown>,
  day: number,
  timeOfDay: string,
  outcome?: string,
  outcomeNote?: string | null,
) {
  let narrative = String(action.action);
  switch (action.action) {
    case 'move': narrative = `You decided to go to ${action.location}`; break;
    case 'chat': narrative = `You chatted with ${action.target}${action.intent ? ` (intent: ${action.intent})` : ''}`; break;
    case 'say': narrative = `You spoke to the room`; break;
    case 'rest': narrative = `You took a rest`; break;
    case 'sleep': narrative = `You went to sleep`; break;
    case 'eat': narrative = `You ate ${action.item}`; break;
    case 'pray': narrative = `You offered a prayer`; break;
    case 'craft': narrative = `You crafted ${action.quantity || 1} ${action.item}`; break;
    case 'smelt': narrative = `You smelted ${action.quantity || 1} ${action.item}`; break;
    case 'harvest': narrative = `You harvested crops`; break;
    case 'plant': narrative = `You planted crops`; break;
    case 'water': narrative = `You watered the fields`; break;
    case 'check_field': narrative = `You checked the fields`; break;
    case 'gather': narrative = `You gathered herbs`; break;
    case 'brew': narrative = `You brewed ${action.quantity || 1} ${action.item}`; break;
    case 'play': narrative = `You played`; break;
    case 'leave_chat': narrative = `You left the conversation`; break;
    default:
      const destination = action.location ?? action.target ?? action.item ?? null;
      narrative = `You used ${String(action.action)}${destination ? ` on ${destination}` : ''}`;
  }

  const noteSource = typeof action.message === 'string' ? action.message : typeof action.text === 'string' ? action.text : '';
  const note = noteSource ? ` ("${noteSource.slice(0, 60)}")` : '';
  const failed = outcome === 'failed' ? ' [FAILED]' : '';
  const warning = outcomeNote ? ` ⚠ ${String(outcomeNote).slice(0, 80)}` : '';
  return `- Day ${day} ${timeOfDay}: ${narrative}${note}${failed}${warning}`;
}
