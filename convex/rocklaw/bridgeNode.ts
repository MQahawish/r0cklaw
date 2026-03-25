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
  target: string | null;
  duration_ticks: number;
  message?: string;
  consumes: string[];
  produces: string[];
  memory_note?: string;
};

type WsEvent =
  | { type: 'session_start'; session_id?: string; resumed?: boolean; message_count?: number; name?: string }
  | { type: 'chunk'; content?: string }
  | { type: 'tool_call'; name?: string; args?: unknown }
  | { type: 'tool_result'; name?: string; output?: unknown }
  | { type: 'done'; full_response?: string }
  | { type: 'error'; message?: string; code?: string }
  | { type: string; [key: string]: unknown };

const VALID_ACTIONS = new Set([
  'talk', 'move', 'rest', 'sleep', 'eat', 'buy', 'sell', 'pay', 'give', 'trade',
  'observe', 'write', 'pray', 'leave_message', 'recall',
  'craft', 'repair', 'smelt', 'appraise',
  'negotiate', 'post_price', 'bulk_buy',
  'harvest', 'plant', 'water', 'check_field',
  'gather', 'brew', 'treat', 'identify',
  'serve', 'rent_room', 'eavesdrop', 'post_notice',
  'bless', 'counsel', 'preach', 'officiate',
  'play', 'run_errand',
  'patrol', 'train', 'recall_war',
]);

const GATEWAY_HOSTS = ['127.0.0.1', 'host.docker.internal'] as const;
const WS_TIMEOUT_MS = 120_000;

export const tickAgent = internalAction({
  args: {
    agentName: v.string(),
    _manual: v.optional(v.boolean()),
  },
  handler: async (ctx, { agentName, _manual }) => {
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
    const agent = await ctx.runQuery(internal.rocklaw.bridge.getAgent, { agentName });
    if (!agent) {
      console.error(`[bridge] Agent not found: ${agentName}`);
      return;
    }
    if (agent.paused && !_manual) {
      console.log(`[bridge] ${agentName} is paused — tick skipped`);
      return;
    }
    if (agent.busy) {
      const waitMs = TICK_INTERVAL_MS / 2;
      if (!_manual) {
        await ctx.scheduler.runAfter(waitMs, internal.rocklaw.bridgeNode.tickAgent, { agentName });
      }
      console.log(`[bridge] ${agentName} still busy, retrying in ${waitMs}ms`);
      return;
    }

    await ctx.runAction(internal.rocklaw.worldRefreshNode.refreshWorldFiles, {
      agentName,
      tick,
      day,
      timeOfDay,
    });

    const letterWarning = await ctx.runQuery(internal.rocklaw.bridge.checkUnreadLetters, {
      agentName,
      currentTick: tick,
    });

    const tickMessage = buildTickMessage(day, timeOfDay, tick, letterWarning ?? undefined);
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
    try {
      const result = await runZeroClawTurn(agent.gatewayPort, sessionId, agentName, tickMessage);
      rawResponse = result.finalResponse;
      debugRecord.gatewayHost = result.host;
      debugRecord.events = result.events;
    } catch (err) {
      debugRecord.phase = 'transport_failed';
      debugRecord.timestamp = new Date().toISOString();
      debugRecord.error = err instanceof Error ? err.message : String(err);
      console.error(`[bridge] Gateway call failed for ${agentName}:`, err);
      await appendTickDebug(agent.workspacePath, debugRecord);
      if (!_manual) {
        await ctx.scheduler.runAfter(TICK_INTERVAL_MS, internal.rocklaw.bridgeNode.tickAgent, { agentName });
      }
      return;
    }

    debugRecord.rawResponse = rawResponse;

    const action = extractAction(rawResponse);
    if (!action) {
      debugRecord.phase = 'parse_failed';
      debugRecord.timestamp = new Date().toISOString();
      debugRecord.validation = {
        outcome: 'parse_failed',
        note: 'Could not parse final response as Rocklaw action JSON.',
      };
      console.error(`[bridge] Could not parse action from ${agentName}'s response:\n${rawResponse}`);
      await appendTickDebug(agent.workspacePath, debugRecord);
      await ctx.runMutation(internal.rocklaw.bridge.setAgentPendingNote, {
        agentName,
        note: 'SYSTEM: Your final response could not be parsed as valid JSON. Use tools if needed, but finish with exactly one JSON action object and nothing else.',
      });
      if (!_manual) {
        await ctx.scheduler.runAfter(TICK_INTERVAL_MS, internal.rocklaw.bridgeNode.tickAgent, { agentName });
      }
      return;
    }

    debugRecord.parsedAction = action;

    if (!validateAction(action)) {
      debugRecord.phase = 'invalid_action';
      debugRecord.timestamp = new Date().toISOString();
      debugRecord.validation = {
        outcome: 'invalid_action',
        note: 'Parsed JSON was structurally invalid for Rocklaw.',
      };
      console.error(`[bridge] Invalid action from ${agentName}:`, action);
      await appendTickDebug(agent.workspacePath, debugRecord);
      await ctx.runMutation(internal.rocklaw.bridge.setAgentPendingNote, {
        agentName,
        note: 'SYSTEM: Your final JSON action was structurally invalid. Return one JSON object with action, target, duration_ticks, consumes, produces, and optional message/memory_note.',
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

    await ctx.runAction(internal.rocklaw.worldRefreshNode.appendHeartbeat, {
      agentName,
      line: summariseAction(action, day, timeOfDay, result?.outcome, result?.note),
    });

    await appendTickDebug(agent.workspacePath, debugRecord);

    const durationTicks = Math.max(1, action.duration_ticks ?? 1);
    const nextMs = durationTicks * TICK_INTERVAL_MS;

    console.log(
      `[bridge] ${agentName} tick ${tick}: ${action.action} → ${action.target ?? 'null'} [${result?.outcome ?? 'success'}] next in ${nextMs}ms`,
    );

    if (!_manual) {
      await ctx.scheduler.runAfter(nextMs, internal.rocklaw.bridgeNode.tickAgent, { agentName });
    }
  },
});

function buildTickMessage(day: number, timeOfDay: string, tick: number, letterWarning?: string): string {
  const sections = [
    `It is ${timeOfDay}, Day ${day}, tick ${tick} in Rocklaw.`,
    'Use your files and tools as needed to understand your situation before deciding.',
    'Think silently. Use tools for reading, recall, and note updates only.',
    'Do not ask clarifying questions. Do not emit tool_code. Do not execute shell commands for world actions.',
    'Your FINAL response must be exactly one JSON object for the world engine and nothing else.',
    'The first character of your final response must be { and the last character must be }.',
    'Do not include prose, markdown fences, commentary, repetition, or explanation outside the JSON object.',
    'If you want to explain intent, put it inside "message" or "memory_note" fields in the JSON.',
    '',
    'Final response schema:',
    '{"action":"...","target":"agent_name|location_name|item_name|null","duration_ticks":1,"message":"optional","consumes":[],"produces":[],"memory_note":"optional"}',
  ];

  if (letterWarning) {
    sections.push('', letterWarning);
  }

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
      lastError = new Error(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`ZeroClaw gateway unavailable on port ${port}`);
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
        reject(new Error(`Timed out waiting for ZeroClaw session response after ${WS_TIMEOUT_MS}ms`));
      }
    }, WS_TIMEOUT_MS);

    const settleError = (error: Error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      reject(error);
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

  const jsonMatches = [...response.matchAll(/\{[\s\S]*?\}/g)];
  for (let i = jsonMatches.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(jsonMatches[i][0]);
      if (parsed.action) return parsed;
    } catch {
      // keep looking
    }
  }
  return null;
}

function validateAction(action: RocklawAction): boolean {
  return (
    typeof action.action === 'string' &&
    VALID_ACTIONS.has(action.action) &&
    typeof action.duration_ticks === 'number' &&
    action.duration_ticks >= 1 &&
    Array.isArray(action.consumes) &&
    Array.isArray(action.produces)
  );
}

function summariseAction(
  action: RocklawAction,
  day: number,
  timeOfDay: string,
  outcome?: string,
  outcomeNote?: string | null,
): string {
  const target = action.target ? ` → ${action.target}` : '';
  const note = action.message ? ` (${action.message.slice(0, 60)})` : '';
  const failed = outcome === 'failed' ? ' [FAILED]' : '';
  const warning = outcomeNote ? ` ⚠ ${outcomeNote.slice(0, 80)}` : '';
  return `- Day ${day} ${timeOfDay}: ${action.action}${target}${note}${failed}${warning}`;
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
