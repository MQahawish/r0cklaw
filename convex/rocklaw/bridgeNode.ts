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
  topic?: string;
  item?: string | null;
  quantity?: number | null;
  amount?: number | null;
  offer?: unknown[];
  request?: unknown[];
  duration_ticks: number;
  thought?: string;
  message?: string;
  consumes: unknown[];
  produces: unknown[];
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
      if (err instanceof ZeroClawTurnError) {
        debugRecord.gatewayHost = err.host;
        debugRecord.events = err.events;
      }
      console.error(`[bridge] Gateway call failed for ${agentName}:`, err);
      await appendTickDebug(agent.workspacePath, debugRecord);
      if (!_manual) {
        await ctx.scheduler.runAfter(TICK_INTERVAL_MS, internal.rocklaw.bridgeNode.tickAgent, { agentName });
      }
      return;
    }

    debugRecord.rawResponse = rawResponse;

    const trimmedResponse = rawResponse.trimStart();
    if (!trimmedResponse.startsWith('{')) {
      debugRecord.phase = 'parse_failed';
      debugRecord.timestamp = new Date().toISOString();
      debugRecord.validation = {
        outcome: 'parse_failed',
        note: 'Final response must start with { and contain only one JSON object.',
      };
      console.error(`[bridge] Non-JSON-prefixed response from ${agentName}:\n${rawResponse}`);
      await appendTickDebug(agent.workspacePath, debugRecord);
      await ctx.runMutation(internal.rocklaw.bridge.setAgentPendingNote, {
        agentName,
        note: 'SYSTEM: Next response must begin with { immediately. Return only one JSON object.',
      });
      if (!_manual) {
        await ctx.scheduler.runAfter(TICK_INTERVAL_MS, internal.rocklaw.bridgeNode.tickAgent, { agentName });
      }
      return;
    }

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
        note: 'SYSTEM: Next response must be JSON only. Start with { and end with }.',
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
    'Use your files and tools only to understand the situation and decide.',
    'Think silently. Read only the minimum files needed. In most ticks, 3-5 reads are enough.',
    'When you know what to do, stop using tools and return the final answer immediately.',
    'Return exactly one JSON object and nothing else.',
    'The first character must be { and the last character must be }.',
    'No prose before or after the JSON object.',
    'Do not ask clarifying questions. Do not emit tool_code. Do not execute shell commands for world actions.',
    'If you want to explain why, put it in "thought".',
    'Use "message" for outward wording. Use "memory_note" for the private takeaway.',
    '',
    'Final response schema:',
    '{"action":"...","duration_ticks":1,"target":"optional","location":"optional","text":"optional","topic":"optional","item":"optional","quantity":1,"amount":0,"consumes":[],"produces":[],"offer":[],"request":[],"thought":"optional","message":"optional","memory_note":"optional"}',
    '',
    'Examples:',
    '{"action":"rest","duration_ticks":1,"thought":"Energy is too low for demanding work.","message":"Resting for a bit."}',
    '{"action":"move","location":"market","duration_ticks":1,"thought":"Need supplies before work stalls.","message":"Going to the market."}',
    '{"action":"craft","item":"horseshoe","quantity":2,"duration_ticks":1,"consumes":[{"item":"iron_ore","quantity":4},{"item":"coal","quantity":2}],"produces":[{"item":"horseshoe","quantity":2}],"thought":"Market demand is severe and I have the materials.","message":"Crafting two horseshoes."}',
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
  if (typeof action.duration_ticks !== 'number' || action.duration_ticks < 1) return false;
  if (!Array.isArray(action.consumes) || !Array.isArray(action.produces)) return false;

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

  if (!isStringish(action.target) || !isStringish(action.location) || !isStringish(action.text) || !isStringish(action.topic) || !isStringish(action.item) || !isStringish(action.thought)) {
    return false;
  }
  if (!isNumberish(action.quantity) || !isNumberish(action.amount)) return false;
  if (!isEntityList(action.offer) || !isEntityList(action.request)) return false;

  switch (action.action) {
    case 'move':
      return typeof (action.location ?? action.target) === 'string';
    case 'talk':
    case 'leave_message':
    case 'write':
    case 'pray':
      return typeof (action.text ?? action.message) === 'string';
    case 'pay':
      return typeof action.target === 'string' && typeof action.amount === 'number';
    case 'buy':
    case 'sell':
    case 'give':
    case 'eat':
    case 'craft':
    case 'repair':
    case 'smelt':
    case 'appraise':
      return typeof (action.item ?? action.target) === 'string';
    case 'trade':
      return typeof action.target === 'string' && Array.isArray(action.offer) && Array.isArray(action.request);
    default:
      return true;
  }
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
