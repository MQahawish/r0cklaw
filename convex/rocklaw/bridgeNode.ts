"use node";

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { TICK_INTERVAL_MS } from './engine';
import * as fs from 'fs/promises';
import * as path from 'path';
import WebSocket from 'ws';

type RocklawAction = {
  action: string;
  target?: string | null;
  location?: string | null;
  text?: string;
  intent?: string | null;
  offer_ref?: string | null;
  topic?: string;
  item?: string | null;
  quantity?: number | null;
  amount?: number | null;
  offer?: unknown[];
  request?: unknown[];
  duration_ticks?: number;
  thought?: string;
  message?: string;
  journal?: string;
  consumes?: unknown[];
  produces?: unknown[];
};

type WsEvent =
  | { type: 'session_start'; session_id?: string; resumed?: boolean; message_count?: number; name?: string }
  | { type: 'chunk'; content?: string }
  | { type: 'tool_call'; name?: string; args?: unknown }
  | { type: 'tool_result'; name?: string; output?: unknown }
  | { type: 'done'; full_response?: string }
  | { type: 'error'; message?: string; code?: string }
  | { type: string; [key: string]: unknown };

type PlannedTurnResult =
  | {
      status: 'action';
      agentName: string;
      action: RocklawAction;
    }
  | {
      status: 'rejected';
      agentName: string;
      outcome: 'transport_failed' | 'parse_failed' | 'invalid_action';
      note: string;
      heartbeatLine: string;
      pendingNote?: string;
    };

class ZeroClawTurnError extends Error {
  host?: string;
  events: WsEvent[];

  constructor(message: string, options?: { host?: string; events?: WsEvent[] }) {
    super(message);
    this.name = 'ZeroClawTurnError';
    this.host = options?.host;
    this.events = options?.events ?? [];
  }
}

type ZeroClawTurnSuccess = {
  kind: 'response';
  host: string;
  finalResponse: string;
  events: WsEvent[];
  retryAttempted: boolean;
};

type ZeroClawTurnFallback = {
  kind: 'fallback';
  action: RocklawAction;
  retryAttempted: boolean;
  retryFailure: string;
};

const VALID_ACTIONS = new Set([
  'chat', 'leave_chat', 'say', 'move', 'rest', 'sleep', 'eat', 'use',
  'pray',
  'work',
  'harvest', 'plant', 'water', 'check_field',
  'gather', 'brew',
  'buy_place', 'sell_place', 'deliver_place',
  'play',
]);

const GATEWAY_HOSTS = ['127.0.0.1', 'host.docker.internal'] as const;
const WS_TIMEOUT_MS = 120_000;

function isTimeoutFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Timed out waiting for ZeroClaw session response');
}

function hasActionHint(possibleValidActions: string[] | undefined, prefix: string): boolean {
  return Array.isArray(possibleValidActions)
    && possibleValidActions.some((hint) => hint.trim().startsWith(`- ${prefix}`));
}

function buildTransportFallbackAction(
  livePartner: string | undefined,
  possibleValidActions: string[] | undefined,
): RocklawAction | null {
  if (livePartner) {
    return {
      action: 'leave_chat',
      text: 'Talk later.',
      thought: 'The conversation should close cleanly if I fail to respond in time.',
    };
  }
  if (hasActionHint(possibleValidActions, 'sleep')) {
    return {
      action: 'sleep',
      journal: 'Nothing important changed tonight. I need proper sleep so I can continue tomorrow.',
      thought: 'Transport failed, so I am taking the safest valid action and will continue later.',
    };
  }
  if (hasActionHint(possibleValidActions, 'rest')) {
    return {
      action: 'rest',
      thought: 'Transport failed, so I am taking a safe low-risk action.',
    };
  }
  if (hasActionHint(possibleValidActions, 'say')) {
    return {
      action: 'say',
      text: 'I will check back in a bit.',
      thought: 'Transport failed, so I am falling back to a neutral public action.',
    };
  }
  return null;
}

async function runZeroClawTurnWithRecovery(
  port: number,
  sessionId: string,
  agentName: string,
  prompt: string,
  fallbackAction: RocklawAction | null,
): Promise<ZeroClawTurnSuccess | ZeroClawTurnFallback> {
  try {
    const result = await runZeroClawTurn(port, sessionId, agentName, prompt);
    return {
      kind: 'response',
      host: result.host,
      finalResponse: result.finalResponse,
      events: result.events,
      retryAttempted: false,
    };
  } catch (firstError) {
    if (!isTimeoutFailure(firstError)) {
      throw firstError;
    }

    const retrySessionId = `${sessionId}-retry-${Date.now()}`;
    try {
      const retryResult = await runZeroClawTurn(port, retrySessionId, agentName, prompt);
      return {
        kind: 'response',
        host: retryResult.host,
        finalResponse: retryResult.finalResponse,
        events: retryResult.events,
        retryAttempted: true,
      };
    } catch (retryError) {
      if (!fallbackAction) {
        throw retryError;
      }
      return {
        kind: 'fallback',
        action: fallbackAction,
        retryAttempted: true,
        retryFailure: retryError instanceof Error ? retryError.message : String(retryError),
      };
    }
  }
}

async function resetOpenRouterFreeFailureState(ctx: any, agentName: string) {
  await ctx.runMutation(internal.rocklaw.bridge.resetOpenRouterFreeFailureState, { agentName });
}

async function handleOpenRouterFreeFailure(
  ctx: any,
  agentName: string,
  failureKind: 'transport_failed' | 'parse_failed' | 'invalid_action',
  summary: string,
) {
  const transition = await ctx.runMutation(internal.rocklaw.bridge.registerOpenRouterFreeFailure, {
    agentName,
    failureKind,
  });
  if (!transition) return;

  await ctx.runAction(internal.rocklaw.godNode.switchAgentModelInternal, {
    agentName,
    modelOverride: transition.model,
    providerOverride: transition.provider,
  });

  const switchLabel = transition.mode === 'fallback'
    ? `paid fallback model ${transition.model}`
    : `next free model ${transition.model}`;
  const previous = transition.previousModel ? ` from ${transition.previousModel}` : '';
  await ctx.runAction(internal.rocklaw.worldRefreshNode.appendHeartbeat, {
    agentName,
    line: `- Day model switch: openrouter-free ${failureKind}${previous} -> ${switchLabel}. ${summary}`,
  });
  await ctx.runMutation(internal.rocklaw.bridge.setAgentPendingNote, {
    agentName,
    note: `SYSTEM: Your model was switched to ${transition.model} after ${failureKind} in openrouter-free mode.`,
  });
}

export const tickAgent = internalAction({
  args: {
    agentName: v.string(),
    _manual: v.optional(v.boolean()),
  },
  handler: async (ctx, { agentName, _manual }): Promise<void> => {
    const worldState = await ctx.runQuery(internal.rocklaw.engine.getWorldState);
    if (!worldState) {
      console.error(`[bridge] No world state — ${agentName} tick aborted`);
      return;
    }
    if (!worldState.isRunning && !_manual) {
      console.log(`[bridge] ${agentName}: sim stopped, agent loop exiting`);
      return;
    }

    const { tick, day, timeOfDay } = worldState;
    let agent = await ctx.runQuery(internal.rocklaw.bridge.getAgent, { agentName });
    if (!agent) {
      console.error(`[bridge] Agent not found: ${agentName}`);
      return;
    }
    if (agent.paused && !_manual) {
      console.log(`[bridge] ${agentName} is paused — tick skipped`);
      return;
    }
    if (agent.busy) {
      if (agent.busyUntilTick !== undefined && agent.busyUntilTick <= tick) {
        const completion = await ctx.runMutation(internal.rocklaw.bridge.completePendingAction, {
          agentName,
          tick,
          day,
        });
        if (completion && 'action' in completion) {
          await ctx.runAction(internal.rocklaw.worldRefreshNode.appendHeartbeat, {
            agentName,
            line: summariseAction(completion.action, day, timeOfDay, completion.outcome, completion.note),
          });
        }
        agent = await ctx.runQuery(internal.rocklaw.bridge.getAgent, { agentName });
        if (!agent) {
          console.error(`[bridge] Agent disappeared during completion: ${agentName}`);
          return;
        }
      }
      if (agent.busy) {
        const waitMs = TICK_INTERVAL_MS / 2;
        if (!_manual) {
          await ctx.scheduler.runAfter(waitMs, internal.rocklaw.bridgeNode.tickAgent, { agentName });
        }
        console.log(`[bridge] ${agentName} still busy, retrying in ${waitMs}ms`);
        return;
      }
    }

    await ctx.runAction(internal.rocklaw.worldRefreshNode.refreshWorldFiles, {
      agentName,
      tick,
      day,
      timeOfDay,
    });

    const lastHeartbeatLine = await ctx.runAction(internal.rocklaw.worldRefreshNode.getLatestHeartbeatLine, {
      agentName,
    });
    const possibleValidActions = await ctx.runQuery(internal.rocklaw.bridge.getPromptActionHints, {
      agentName,
      tick,
    });
    const liveScene = await ctx.runQuery(internal.rocklaw.bridge.getLiveChatScene, {
      agentName,
    });
    const fallbackAction = buildTransportFallbackAction(liveScene?.partner, possibleValidActions);

    const tickMessage = buildTickMessage(
      day,
      timeOfDay,
      tick,
      agent.location,
      lastHeartbeatLine ?? undefined,
      undefined,
      possibleValidActions,
    );
    const sessionId = buildSessionId(agentName);
    const debugRecord: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      phase: 'started',
      agentName,
      tick,
      day,
      timeOfDay,
      gatewayPort: agent.gatewayPort,
      sessionId,
      prompt: tickMessage,
      events: [] as unknown[],
    };
    await appendTickDebug(agent.workspacePath, debugRecord);

    let rawResponse: string;
    let plannedActionFromRecovery: RocklawAction | null = null;
    try {
      const result = await runZeroClawTurnWithRecovery(
        agent.gatewayPort,
        sessionId,
        agentName,
        tickMessage,
        fallbackAction,
      );
      debugRecord.retryAttempted = result.retryAttempted;
      if (result.kind === 'response') {
        rawResponse = result.finalResponse;
        debugRecord.gatewayHost = result.host;
        debugRecord.events = result.events;
      } else {
        rawResponse = '';
        plannedActionFromRecovery = result.action;
        debugRecord.transportRecoveredWithFallback = true;
        debugRecord.fallbackAction = result.action;
        debugRecord.retryFailure = result.retryFailure;
      }
    } catch (err) {
      const failureMessage = err instanceof Error ? err.message : String(err);
      debugRecord.phase = 'transport_failed';
      debugRecord.timestamp = new Date().toISOString();
      debugRecord.error = failureMessage;
      if (err instanceof ZeroClawTurnError) {
        debugRecord.gatewayHost = err.host;
        debugRecord.events = err.events;
      }
      console.error(`[bridge] Gateway call failed for ${agentName}:`, err);
      await ctx.runAction(internal.rocklaw.worldRefreshNode.appendHeartbeat, {
        agentName,
        line: summariseFailure(day, timeOfDay, 'agent turn failed before a final action', failureMessage),
      });
      await handleOpenRouterFreeFailure(ctx, agentName, 'transport_failed', failureMessage);
      await appendTickDebug(agent.workspacePath, debugRecord);
      if (!_manual) {
        await ctx.scheduler.runAfter(TICK_INTERVAL_MS, internal.rocklaw.bridgeNode.tickAgent, { agentName });
      }
      return;
    }

    debugRecord.rawResponse = rawResponse;

    const trimmedResponse = rawResponse.trimStart();
    const extractedAction = plannedActionFromRecovery ?? extractAction(rawResponse);
    if (!plannedActionFromRecovery && !trimmedResponse.startsWith('{') && extractedAction) {
      debugRecord.responseSalvagedFromWrappedJson = true;
      console.warn(`[bridge] Salvaged wrapped JSON response from ${agentName}`);
    }

    if (!plannedActionFromRecovery && !trimmedResponse.startsWith('{') && !extractedAction) {
      const note = 'Final response must contain one valid Rocklaw action JSON object.';
      debugRecord.phase = 'parse_failed';
      debugRecord.timestamp = new Date().toISOString();
      debugRecord.validation = {
        outcome: 'parse_failed',
        note,
      };
      console.error(`[bridge] Non-JSON response from ${agentName} with no recoverable action:\n${rawResponse}`);
      await ctx.runAction(internal.rocklaw.worldRefreshNode.appendHeartbeat, {
        agentName,
        line: summariseFailure(day, timeOfDay, 'response rejected: no recoverable action JSON', note),
      });
      await handleOpenRouterFreeFailure(ctx, agentName, 'parse_failed', note);
      await appendTickDebug(agent.workspacePath, debugRecord);
      await ctx.runMutation(internal.rocklaw.bridge.setAgentPendingNote, {
        agentName,
        note: 'SYSTEM: Return one valid Rocklaw action JSON object. Do not wrap it in prose.',
      });
      if (!_manual) {
        await ctx.scheduler.runAfter(TICK_INTERVAL_MS, internal.rocklaw.bridgeNode.tickAgent, { agentName });
      }
      return;
    }

    if (!extractedAction) {
      const note = 'Could not parse final response as Rocklaw action JSON.';
      debugRecord.phase = 'parse_failed';
      debugRecord.timestamp = new Date().toISOString();
      debugRecord.validation = {
        outcome: 'parse_failed',
        note,
      };
      console.error(`[bridge] Could not parse action from ${agentName}'s response:\n${rawResponse}`);
      await ctx.runAction(internal.rocklaw.worldRefreshNode.appendHeartbeat, {
        agentName,
        line: summariseFailure(day, timeOfDay, 'response rejected: JSON parse failed', note),
      });
      await handleOpenRouterFreeFailure(ctx, agentName, 'parse_failed', note);
      await appendTickDebug(agent.workspacePath, debugRecord);
      await ctx.runMutation(internal.rocklaw.bridge.setAgentPendingNote, {
        agentName,
        note: 'SYSTEM: Next response must be JSON only. Start with { and end with }.',
      });
      if (!_manual) {
        await ctx.scheduler.runAfter(TICK_INTERVAL_MS, internal.rocklaw.bridgeNode.tickAgent, { agentName });
      }
      return;
    }

    const action = extractedAction;
    debugRecord.parsedAction = action;

    if (!validateAction(action)) {
      const note = pseudoActionCorrection(action) ?? 'Parsed JSON was structurally invalid for Rocklaw.';
      debugRecord.phase = 'invalid_action';
      debugRecord.timestamp = new Date().toISOString();
      debugRecord.validation = {
        outcome: 'invalid_action',
        note,
      };
      console.error(`[bridge] Invalid action from ${agentName}:`, action);
      await ctx.runAction(internal.rocklaw.worldRefreshNode.appendHeartbeat, {
        agentName,
        line: summariseRejectedAttempt(action, day, timeOfDay, note),
      });
      await handleOpenRouterFreeFailure(ctx, agentName, 'invalid_action', note);
      await appendTickDebug(agent.workspacePath, debugRecord);
      await ctx.runMutation(internal.rocklaw.bridge.setAgentPendingNote, {
        agentName,
        note: 'SYSTEM: Next response must be one valid JSON action object only.',
      });
      if (!_manual) {
        await ctx.scheduler.runAfter(TICK_INTERVAL_MS, internal.rocklaw.bridgeNode.tickAgent, { agentName });
      }
      return;
    }

    const result = await ctx.runMutation(internal.rocklaw.bridge.commitAction, {
      agentName,
      action: JSON.stringify(action),
      tick,
      day,
    });

    debugRecord.validation = {
      outcome: result?.outcome ?? 'success',
      note: result?.note ?? null,
    };
    debugRecord.phase = 'completed';
    debugRecord.timestamp = new Date().toISOString();

    await resetOpenRouterFreeFailureState(ctx, agentName);
    await ctx.runAction(internal.rocklaw.worldRefreshNode.appendHeartbeat, {
      agentName,
      line: summariseAction(action, day, timeOfDay, result?.outcome, result?.note),
    });

    await appendTickDebug(agent.workspacePath, debugRecord);

    const durationTicks = Math.max(1, result && 'durationTicks' in result ? result.durationTicks ?? 1 : 1);
    const nextMs = durationTicks * TICK_INTERVAL_MS;

    console.log(
      `[bridge] ${agentName} tick ${tick}: ${action.action} → ${action.target ?? 'null'} [${result?.outcome ?? 'success'}] next in ${nextMs}ms`,
    );

    if (!_manual) {
      await ctx.scheduler.runAfter(nextMs, internal.rocklaw.bridgeNode.tickAgent, { agentName });
    }
  },
});

export const planAgentAction = internalAction({
  args: {
    agentName: v.string(),
    tick: v.number(),
    day: v.number(),
    timeOfDay: v.string(),
    promptPrefix: v.optional(v.string()),
    pendingNote: v.optional(v.string()),
  },
  handler: async (ctx, { agentName, tick, day, timeOfDay, promptPrefix, pendingNote }): Promise<PlannedTurnResult> => {
    const agent = await ctx.runQuery(internal.rocklaw.bridge.getAgent, { agentName });
    if (!agent) {
      return {
        status: 'rejected',
        agentName,
        outcome: 'invalid_action',
        note: 'Agent not found.',
        heartbeatLine: summariseFailure(day, timeOfDay, 'agent planning failed', 'Agent not found.'),
      };
    }

    if (pendingNote) {
      await ctx.runMutation(internal.rocklaw.bridge.setAgentPendingNote, {
        agentName,
        note: pendingNote,
      });
    }

    try {
      await ctx.runAction(internal.rocklaw.worldRefreshNode.refreshWorldFiles, {
        agentName,
        tick,
        day,
        timeOfDay,
      });
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error);
      return {
        status: 'rejected',
        agentName,
        outcome: 'invalid_action',
        note,
        heartbeatLine: summariseFailure(day, timeOfDay, 'world file refresh failed', note),
        pendingNote: `SYSTEM: World refresh failed before your turn could be planned. ${note}`,
      };
    }

    const lastHeartbeatLine = await ctx.runAction(internal.rocklaw.worldRefreshNode.getLatestHeartbeatLine, {
      agentName,
    });
    const possibleValidActions = await ctx.runQuery(internal.rocklaw.bridge.getPromptActionHints, {
      agentName,
      tick,
    });
    const liveScene = await ctx.runQuery(internal.rocklaw.bridge.getLiveChatScene, {
      agentName,
    });
    const fallbackAction = buildTransportFallbackAction(liveScene?.partner, possibleValidActions);

    const tickMessage = buildTickMessage(
      day,
      timeOfDay,
      tick,
      agent.location,
      lastHeartbeatLine ?? undefined,
      promptPrefix ?? undefined,
      possibleValidActions,
    );
    const sessionId = buildSessionId(agentName);
    const debugRecord: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      phase: 'started',
      agentName,
      tick,
      day,
      timeOfDay,
      gatewayPort: agent.gatewayPort,
      sessionId,
      prompt: tickMessage,
      events: [] as unknown[],
    };

    let rawResponse: string;
    let plannedActionFromRecovery: RocklawAction | null = null;
    try {
      const result = await runZeroClawTurnWithRecovery(
        agent.gatewayPort,
        sessionId,
        agentName,
        tickMessage,
        fallbackAction,
      );
      debugRecord.retryAttempted = result.retryAttempted;
      if (result.kind === 'response') {
        rawResponse = result.finalResponse;
        debugRecord.gatewayHost = result.host;
        debugRecord.events = result.events;
      } else {
        rawResponse = '';
        plannedActionFromRecovery = result.action;
        debugRecord.transportRecoveredWithFallback = true;
        debugRecord.fallbackAction = result.action;
        debugRecord.retryFailure = result.retryFailure;
      }
    } catch (err) {
      const failureMessage = err instanceof Error ? err.message : String(err);
      debugRecord.phase = 'transport_failed';
      debugRecord.timestamp = new Date().toISOString();
      debugRecord.error = failureMessage;
      if (err instanceof ZeroClawTurnError) {
        debugRecord.gatewayHost = err.host;
        debugRecord.events = err.events;
      }
      await handleOpenRouterFreeFailure(ctx, agentName, 'transport_failed', failureMessage);
      await appendTickDebug(agent.workspacePath, debugRecord);
      return {
        status: 'rejected',
        agentName,
        outcome: 'transport_failed',
        note: failureMessage,
        heartbeatLine: summariseFailure(day, timeOfDay, 'agent turn failed before a final action', failureMessage),
      };
    }

    debugRecord.rawResponse = rawResponse;
    const trimmedResponse = rawResponse.trimStart();
    const extractedAction = plannedActionFromRecovery ?? extractAction(rawResponse);
    if (!plannedActionFromRecovery && !trimmedResponse.startsWith('{') && extractedAction) {
      debugRecord.responseSalvagedFromWrappedJson = true;
    }

    if (!plannedActionFromRecovery && !trimmedResponse.startsWith('{') && !extractedAction) {
      const note = 'Final response must contain one valid Rocklaw action JSON object.';
      debugRecord.phase = 'parse_failed';
      debugRecord.timestamp = new Date().toISOString();
      debugRecord.validation = { outcome: 'parse_failed', note };
      await handleOpenRouterFreeFailure(ctx, agentName, 'parse_failed', note);
      await appendTickDebug(agent.workspacePath, debugRecord);
      return {
        status: 'rejected',
        agentName,
        outcome: 'parse_failed',
        note,
        heartbeatLine: summariseFailure(day, timeOfDay, 'response rejected: no recoverable action JSON', note),
        pendingNote: 'SYSTEM: Return one valid Rocklaw action JSON object. Do not wrap it in prose.',
      };
    }

    if (!extractedAction) {
      const note = 'Could not parse final response as Rocklaw action JSON.';
      debugRecord.phase = 'parse_failed';
      debugRecord.timestamp = new Date().toISOString();
      debugRecord.validation = { outcome: 'parse_failed', note };
      await handleOpenRouterFreeFailure(ctx, agentName, 'parse_failed', note);
      await appendTickDebug(agent.workspacePath, debugRecord);
      return {
        status: 'rejected',
        agentName,
        outcome: 'parse_failed',
        note,
        heartbeatLine: summariseFailure(day, timeOfDay, 'response rejected: JSON parse failed', note),
        pendingNote: 'SYSTEM: Next response must be JSON only. Start with { and end with }.',
      };
    }

    const action = extractedAction;
    debugRecord.parsedAction = action;

    if (!validateAction(action)) {
      const note = pseudoActionCorrection(action) ?? 'Parsed JSON was structurally invalid for Rocklaw.';
      debugRecord.phase = 'invalid_action';
      debugRecord.timestamp = new Date().toISOString();
      debugRecord.validation = { outcome: 'invalid_action', note };
      await handleOpenRouterFreeFailure(ctx, agentName, 'invalid_action', note);
      await appendTickDebug(agent.workspacePath, debugRecord);
      return {
        status: 'rejected',
        agentName,
        outcome: 'invalid_action',
        note,
        heartbeatLine: summariseRejectedAttempt(action, day, timeOfDay, note),
        pendingNote: 'SYSTEM: Next response must be one valid JSON action object only.',
      };
    }

    debugRecord.phase = 'planned';
    debugRecord.timestamp = new Date().toISOString();
    debugRecord.validation = { outcome: 'planned', note: null };
    await resetOpenRouterFreeFailureState(ctx, agentName);
    await appendTickDebug(agent.workspacePath, debugRecord);

    return {
      status: 'action',
      agentName,
      action,
    };
  },
});

export const resolveChatInterrupt = internalAction({
  args: {
    agentName: v.string(),
    tick: v.number(),
    day: v.number(),
    timeOfDay: v.string(),
    previousActionJson: v.string(),
    incomingJson: v.string(),
  },
  handler: async (ctx, { agentName, tick, day, timeOfDay, previousActionJson, incomingJson }): Promise<PlannedTurnResult> => {
    const previousAction = JSON.parse(previousActionJson) as RocklawAction;
    const incoming = JSON.parse(incomingJson) as Array<{ fromAgent: string; text: string }>;
    const incomingLines = incoming.map((entry, index) => `${index + 1}. ${entry.fromAgent}: "${entry.text}"`).join('\n');
    const promptPrefix = [
      'LIVE CHAT INTERRUPT:',
      'You already planned a world action for this tick, but one or more people who are online right now are trying to chat with you live.',
      'If you return a chat action to one of the people listed below, that chat reply will replace your previously planned action for this tick.',
      'If you want to keep your previously planned action, return that planned action JSON unchanged.',
      'Incoming live chats:',
      incomingLines,
      '',
      'Previously planned action JSON:',
      JSON.stringify(previousAction),
    ].join('\n');

    return await ctx.runAction(internal.rocklaw.bridgeNode.planAgentAction, {
      agentName,
      tick,
      day,
      timeOfDay,
      promptPrefix,
      pendingNote: `Live chats now: ${incoming.map((entry) => `${entry.fromAgent}`).join(', ')}. Replying replaces your planned action this tick.`,
    });
  },
});

export const appendTickDebugRecord = internalAction({
  args: {
    workspacePath: v.string(),
    recordJson: v.string(),
  },
  handler: async (_ctx, { workspacePath, recordJson }) => {
    await appendTickDebug(workspacePath, JSON.parse(recordJson) as Record<string, unknown>);
  },
});

function buildTickMessage(
  day: number,
  timeOfDay: string,
  tick: number,
  location: string,
  lastHeartbeatLine?: string,
  promptPrefix?: string,
  possibleValidActions?: string[],
): string {
  const sections = [
    `It is ${timeOfDay}, Day ${day}, tick ${tick} in Rocklaw.`,
    `You are in ${location}.`,
    `Last tick: ${lastHeartbeatLine ?? 'none yet'}`,
    ...(promptPrefix ? ['', promptPrefix] : []),
    ...(Array.isArray(possibleValidActions) && possibleValidActions.length > 0
      ? ['', 'Possible valid actions now:', ...possibleValidActions]
      : []),
    'Read HEARTBEAT.md, then TURN.md.',
    'Read JOURNAL.md only if TURN.md is not enough and you truly need older private memory.',
    'Read at most one chat/<name>/CHAT.md only if needed.',
    'If TURN.md already shows an obvious valid action, do not keep exploring. Take the action immediately.',
    'Ground your choice in TURN.md first.',
    'Only choose an action that appears under "Possible valid actions now". If it is not listed there, do not choose it.',
    'For buy_place, sell_place, and deliver_place, use only items listed under "Available place trading here" in TURN.md.',
    'Do not infer direct place trading from the village price table alone.',
    'Use only people, places, items, offers, and relationships that actually appear in TURN.md, JOURNAL.md, or an active chat thread.',
    'If no valid person is shown there, do not choose chat.',
    'If an active interaction directly addresses you, respond to it before starting unrelated work unless you have a clear reason not to.',
    'Use tools only to read files before your final action.',
    'Do not use tools or shell commands to perform world actions.',
    'Do not edit JOURNAL.md directly. Long-term private memory is recorded through the required `journal` field on `sleep`.',
    '',
    'Final output rule:',
    'Return exactly one Rocklaw action JSON object.',
    'No prose. No explanation. No reasoning. No fenced code.',
    'If you describe what you want to do instead of outputting JSON, your turn fails.',
  ];

  return sections.join('\n');
}

function buildSessionId(agentName: string): string {
  return `rocklaw-${agentName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

async function runZeroClawTurn(
  port: number,
  sessionId: string,
  agentName: string,
  prompt: string,
): Promise<{ host: string; finalResponse: string; events: WsEvent[] }> {
  let lastError: unknown;

  for (const host of GATEWAY_HOSTS) {
    const url = `ws://${host}:${port}/ws/chat?session_id=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(`Rocklaw ${agentName}`)}`;
    try {
      const result = await runZeroClawTurnOnUrl(url, prompt);
      return { host, finalResponse: result.finalResponse, events: result.events };
    } catch (error) {
      if (error instanceof ZeroClawTurnError) {
        lastError = new ZeroClawTurnError(`${url}: ${error.message}`, {
          host,
          events: error.events,
        });
      } else {
        lastError = new ZeroClawTurnError(`${url}: ${error instanceof Error ? error.message : String(error)}`, {
          host,
          events: [],
        });
      }
    }
  }

  throw lastError instanceof Error ? lastError : new ZeroClawTurnError(`ZeroClaw gateway unavailable on port ${port}`);
}

async function runZeroClawTurnOnUrl(
  url: string,
  prompt: string,
): Promise<{ finalResponse: string; events: WsEvent[] }> {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const events: WsEvent[] = [];
    let resolved = false;

    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // noop
      }
      if (!resolved) {
        resolved = true;
        reject(new ZeroClawTurnError(`Timed out waiting for ZeroClaw session response after ${WS_TIMEOUT_MS}ms`, {
          events,
        }));
      }
    }, WS_TIMEOUT_MS);

    const settleError = (error: Error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      reject(new ZeroClawTurnError(error.message, { events }));
    };

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'message', content: prompt }));
    });

    ws.addEventListener('error', () => {
      settleError(new Error('WebSocket transport error'));
    });

    ws.addEventListener('message', (event) => {
      const text = typeof event.data === 'string' ? event.data : String(event.data);
      let parsed: WsEvent;
      try {
        parsed = JSON.parse(text) as WsEvent;
      } catch {
        parsed = { type: 'unparsed', raw: text };
      }
      events.push(parsed);

      if (parsed.type === 'error') {
        try {
          ws.close();
        } catch {
          // noop
        }
        settleError(new Error(typeof parsed.message === 'string' ? parsed.message : 'ZeroClaw session returned an error event'));
        return;
      }

      if (parsed.type === 'done') {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        try {
          ws.close();
        } catch {
          // noop
        }
        resolve({
          finalResponse: typeof parsed.full_response === 'string' ? parsed.full_response : '',
          events,
        });
      }
    });

    ws.addEventListener('close', (event) => {
      if (resolved) return;
      clearTimeout(timeout);
      if (event.code !== 1000 && event.code !== 1005) {
        reject(new Error(`WebSocket closed before completion (${event.code})`));
      } else {
        reject(new Error('WebSocket closed before a done event was received'));
      }
    });
  });
}

function extractAction(response: string): RocklawAction | null {
  const jsonBlockMatch = response.match(/```json\s*([\s\S]*?)```/);
  if (jsonBlockMatch) {
    try {
      return JSON.parse(jsonBlockMatch[1].trim());
    } catch {
      // fall through
    }
  }

  const jsonCandidates = extractJsonObjects(response);
  for (let i = jsonCandidates.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(jsonCandidates[i]);
      if (parsed && typeof parsed === 'object' && 'action' in parsed) {
        return parsed as RocklawAction;
      }
    } catch {
      // keep looking
    }
  }
  return null;
}

function extractJsonObjects(text: string): string[] {
  const results: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (ch === '\\') {
        escaping = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (ch === '}') {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        results.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return results;
}

function validateAction(action: RocklawAction): boolean {
  if (typeof action.action !== 'string' || !VALID_ACTIONS.has(action.action)) return false;
  if (action.consumes !== undefined && !Array.isArray(action.consumes)) return false;
  if (action.produces !== undefined && !Array.isArray(action.produces)) return false;

  const isStringish = (value: unknown) => value === undefined || value === null || typeof value === 'string';
  const isNumberish = (value: unknown) => value === undefined || value === null || typeof value === 'number';
  const isEntityList = (value: unknown) =>
    value === undefined ||
    (Array.isArray(value) &&
      value.every((entry) =>
        typeof entry === 'string' ||
        (typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as Record<string, unknown>).item === 'string' &&
          typeof (entry as Record<string, unknown>).quantity === 'number')));

  if (!isStringish(action.target) || !isStringish(action.location) || !isStringish(action.text) || !isStringish(action.intent) || !isStringish(action.offer_ref) || !isStringish(action.topic) || !isStringish(action.item) || !isStringish(action.thought) || !isStringish(action.journal)) {
    return false;
  }
  if (!isNumberish(action.quantity) || !isNumberish(action.amount)) return false;
  if (!isEntityList(action.offer) || !isEntityList(action.request)) return false;

  switch (action.action) {
    case 'move':
      return typeof (action.location ?? action.target) === 'string';
    case 'buy_place':
    case 'sell_place':
    case 'deliver_place':
      return typeof action.target === 'string' && typeof action.item === 'string';
    case 'chat':
      if (typeof (action.text ?? action.message) !== 'string') return false;
      if (action.intent === undefined || action.intent === null || action.intent === '') return true;
      if (!['buy', 'sell', 'trade', 'give', 'pay', 'accept_transaction', 'reject_transaction'].includes(action.intent)) return false;
      if (action.intent === 'accept_transaction' || action.intent === 'reject_transaction') {
        return typeof action.offer_ref === 'string' && typeof action.target === 'string';
      }
      if (action.intent === 'trade') {
        return typeof action.target === 'string' && Array.isArray(action.offer) && Array.isArray(action.request);
      }
      if (action.intent === 'pay') {
        return typeof action.target === 'string' && typeof action.amount === 'number';
      }
      return typeof action.target === 'string' && typeof action.item === 'string';
    case 'say':
    case 'pray':
      return typeof (action.text ?? action.message) === 'string';
    case 'leave_chat':
      return true;
    case 'sleep':
      return typeof action.journal === 'string' && action.journal.trim().length > 0;
    case 'eat':
    case 'repair':
    case 'appraise':
      return typeof (action.item ?? action.target) === 'string';
    case 'work':
      return action.item === undefined || action.item === null || typeof action.item === 'string';
    default:
      return true;
  }
}

function pseudoActionCorrection(action: Partial<RocklawAction> | null | undefined): string | null {
  const raw = typeof action?.action === 'string' ? action.action.trim().toLowerCase() : '';
  if (!raw) return null;
  if (raw === 'look' || raw === 'inspect' || raw === 'observe' || raw === 'survey' || raw === 'file_write' || raw === 'write_file') {
    return 'Observation is done through file reads and notes, not as a final world action. Choose a real Rocklaw action like move, chat, say, rest, sleep, or a role action.';
  }
  if (raw === 'gaze' || raw === 'stare' || raw === 'glance') {
    return 'There is no gaze action. Read files to inspect the situation, then choose a real Rocklaw action like move, chat, say, or a role action.';
  }
  if (raw === 'no_action' || raw === 'noop') {
    return 'There is no no_action verb. If nothing urgent is happening, choose a real Rocklaw action such as move, eat, rest, sleep, chat, or say.';
  }
  if (raw === 'wait') {
    return 'There is no wait action in your current contract. If nothing urgent is happening, choose a real Rocklaw action such as move, say, eat, rest, sleep, chat, or a role action.';
  }
  if (['buy', 'sell', 'trade', 'give', 'pay', 'accept_transaction', 'reject_transaction'].includes(raw)) {
    return `Do not use top-level ${raw}. In a live chat scene, use action:"chat" with text plus intent:"${raw}" and the relevant fields instead.`;
  }
  if (raw === 'bless') {
    return 'There is no bless action. Use chat to give a blessing to one person, or use pray for a prayer spoken into the world.';
  }
  const itemLike = typeof action?.item === 'string'
    ? action.item.trim().toLowerCase()
    : typeof action?.target === 'string'
    ? action.target.trim().toLowerCase()
    : '';
  if ((raw === 'craft' || raw === 'smelt') && itemLike === 'meal') {
    return 'Meals are not crafted as inventory items. Use sell with item:"meal" when someone is here to be served, or choose another real action.';
  }
  if (raw === 'craft' || raw === 'smelt') {
    return 'Blacksmith production now uses action:"work". Choose work with an item like horseshoe, tool, knife, or iron_ingot.';
  }
  return null;
}

function summariseAction(
  action: RocklawAction,
  day: number,
  timeOfDay: string,
  outcome?: string,
  outcomeNote?: string | null,
): string {
  const destination = action.location ?? action.target ?? action.item ?? null;
  const target = destination ? ` → ${destination}` : '';
  const note = (action.message ?? action.text) ? ` (${(action.message ?? action.text ?? '').slice(0, 60)})` : '';
  const failed = outcome === 'failed' ? ' [FAILED]' : '';
  const warning = outcomeNote ? ` ⚠ ${outcomeNote.slice(0, 80)}` : '';
  return `- Day ${day} ${timeOfDay}: ${action.action}${target}${note}${failed}${warning}`;
}

function summariseFailure(
  day: number,
  timeOfDay: string,
  summary: string,
  detail?: string | null,
): string {
  const warning = detail ? ` ⚠ ${detail.slice(0, 80)}` : '';
  return `- Day ${day} ${timeOfDay}: ${summary} [FAILED]${warning}`;
}

function summariseRejectedAttempt(
  action: RocklawAction,
  day: number,
  timeOfDay: string,
  detail?: string | null,
): string {
  let narrative = action.action;
  switch (action.action) {
    case 'move': narrative = `go to ${action.location}`; break;
    case 'chat': narrative = `chat with ${action.target}${action.intent ? ` (intent: ${action.intent})` : ''}`; break;
    case 'say': narrative = `speak to the room`; break;
    case 'rest': narrative = `take a rest`; break;
    case 'sleep': narrative = `go to sleep`; break;
    case 'eat': narrative = `eat ${action.item}`; break;
    case 'use': narrative = `use ${action.item}`; break;
    case 'pray': narrative = `offer a prayer`; break;
    case 'work': narrative = `do work${action.item ? ` for ${action.quantity || 1} ${action.item}` : ''}`; break;
    case 'harvest': narrative = `harvest crops`; break;
    case 'plant': narrative = `plant crops`; break;
    case 'water': narrative = `water the fields`; break;
    case 'check_field': narrative = `check the fields`; break;
    case 'gather': narrative = `gather herb`; break;
    case 'brew': narrative = `brew ${action.quantity || 1} ${action.item}`; break;
    case 'play': narrative = `play`; break;
    case 'leave_chat': narrative = `leave the conversation`; break;
    default:
      const destination = action.location ?? action.target ?? action.item ?? null;
      narrative = `use ${action.action}${destination ? ` on ${destination}` : ''}`;
  }

  const noteSource = action.message ?? action.text ?? '';
  const note = noteSource ? ` ("${noteSource.slice(0, 60)}")` : '';
  const warning = detail ? ` ⚠ ${detail.slice(0, 80)}` : '';
  return `- Day ${day} ${timeOfDay}: You attempted to ${narrative}${note} [FAILED]${warning}`;
}

async function appendTickDebug(workspacePath: string, record: Record<string, unknown>) {
  const stateDir = path.join(resolveWorkspacePath(workspacePath), 'state');
  const debugPath = path.join(stateDir, 'tick-debug.jsonl');
  await fs.mkdir(stateDir, { recursive: true });
  await fs.appendFile(debugPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function resolveWorkspacePath(workspacePath: string): string {
  if (path.isAbsolute(workspacePath)) return workspacePath;
  const root = process.env.ROCKLAW_PROJECT_ROOT || process.cwd();
  return path.resolve(root, workspacePath);
}
