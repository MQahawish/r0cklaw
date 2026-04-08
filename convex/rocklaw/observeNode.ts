"use node";

import { v } from 'convex/values';
import { action } from '../_generated/server';
import { api } from '../_generated/api';
import * as fs from 'fs/promises';
import * as path from 'path';

export type AgentFileEntry = {
  label: string;
  file: string;
  content: string | null;
  runtimeGenerated: boolean;
  editable: boolean;
};

export type AgentTraceEvent = {
  type: string;
  name?: string;
  preview: string;
  full: string | null;
};

export type AgentDebugTraceEntry = {
  timestamp: string | null;
  phase: string | null;
  tick: number | null;
  day: number | null;
  timeOfDay: string | null;
  sessionId: string | null;
  gatewayHost: string | null;
  retryAttempted: boolean;
  rawResponse: string | null;
  parsedActionJson: string | null;
  validationOutcome: string | null;
  validationNote: string | null;
  error: string | null;
  promptText: string | null;
  promptPreview: string | null;
  events: AgentTraceEvent[];
};

export const getAgentFiles = action({
  args: { agentName: v.string() },
  handler: async (ctx, { agentName }): Promise<{ files: AgentFileEntry[] }> => {
    const agents = await ctx.runQuery(api.rocklaw.observe.getAgentWorkspacePaths);
    const agent = agents.find((entry: { name: string; workspacePath: string }) => entry.name === agentName);
    if (!agent) return { files: [] };

    const workspacePath = resolveWorkspacePath(agent.workspacePath);
    const agentRoot = path.dirname(workspacePath);
    const markdownFiles = (await listMarkdownFiles(agentRoot)).filter(shouldIncludeFile);
    const files: AgentFileEntry[] = await Promise.all(
      markdownFiles.map(async (relativeFile) => {
        const runtimeGenerated = isRuntimeGenerated(relativeFile);
        const editable = isEditableFile(relativeFile);
        try {
          const content = await fs.readFile(path.join(agentRoot, relativeFile), 'utf8');
          return {
            label: buildLabel(relativeFile),
            file: relativeFile,
            content,
            runtimeGenerated,
            editable,
          };
        } catch {
          return {
            label: buildLabel(relativeFile),
            file: relativeFile,
            content: null,
            runtimeGenerated,
            editable,
          };
        }
      }),
    );

    return {
      files: files.sort((left, right) => fileSortKey(left.file).localeCompare(fileSortKey(right.file))),
    };
  },
});

export const getAgentDebugTrace = action({
  args: {
    agentName: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { agentName, limit = 8 }): Promise<{ entries: AgentDebugTraceEntry[] }> => {
    const agents = await ctx.runQuery(api.rocklaw.observe.getAgentWorkspacePaths);
    const agent = agents.find((entry: { name: string; workspacePath: string }) => entry.name === agentName);
    if (!agent) return { entries: [] };

    const workspacePath = resolveWorkspacePath(agent.workspacePath);
    const debugPath = path.join(workspacePath, 'state', 'tick-debug.jsonl');

    try {
      const content = await fs.readFile(debugPath, 'utf8');
      const entries = content
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => parseDebugTraceLine(line))
        .filter((entry): entry is AgentDebugTraceEntry => entry !== null)
        .slice(-Math.max(1, limit))
        .reverse();
      return { entries };
    } catch {
      return { entries: [] };
    }
  },
});

function resolveWorkspacePath(workspacePath: string): string {
  if (path.isAbsolute(workspacePath)) return workspacePath;
  const root = process.env.ROCKLAW_PROJECT_ROOT || process.cwd();
  return path.resolve(root, workspacePath);
}

async function listMarkdownFiles(root: string, relativeDir = ''): Promise<string[]> {
  const currentDir = path.join(root, relativeDir);
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const relativePath = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      const nested = await listMarkdownFiles(root, relativePath);
      results.push(...nested);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      results.push(relativePath);
    }
  }

  return results;
}

function buildLabel(file: string): string {
  const normalized = file.replace(/\\/g, '/');
  if (normalized.startsWith('workspace/skills/')) {
    return 'SKILL.md';
  }
  if (normalized.startsWith('workspace/')) {
    return normalized.slice('workspace/'.length);
  }
  return normalized;
}

function isRuntimeGenerated(file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  return normalized === 'workspace/AGENTS.md'
    || normalized === 'workspace/TOOLS.md'
    || normalized === 'workspace/HEARTBEAT.md'
    || normalized === 'workspace/TURN.md'
    || normalized === 'workspace/JOURNAL.md'
    || normalized.startsWith('workspace/skills/');
}

function isEditableFile(file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  return normalized === 'workspace/SOUL.md' || normalized === 'workspace/IDENTITY.md';
}

function fileSortKey(file: string): string {
  const priority = runtimePriority(file);
  return `${priority}-${file.toLowerCase()}`;
}

function runtimePriority(file: string): string {
  const normalized = file.replace(/\\/g, '/');
  if (normalized === 'workspace/IDENTITY.md') return '00';
  if (normalized === 'workspace/SOUL.md') return '01';
  if (normalized === 'workspace/AGENTS.md') return '02';
  if (normalized === 'workspace/TOOLS.md') return '03';
  if (normalized === 'workspace/HEARTBEAT.md') return '10';
  if (normalized === 'workspace/TURN.md') return '11';
  if (normalized === 'workspace/JOURNAL.md') return '12';
  if (normalized.startsWith('workspace/skills/')) return '20';
  return '30';
}

function shouldIncludeFile(file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  return normalized === 'workspace/IDENTITY.md'
    || normalized === 'workspace/SOUL.md'
    || normalized === 'workspace/AGENTS.md'
    || normalized === 'workspace/TOOLS.md'
    || normalized === 'workspace/HEARTBEAT.md'
    || normalized === 'workspace/TURN.md'
    || normalized === 'workspace/JOURNAL.md'
    || normalized.startsWith('workspace/skills/');
}

function parseDebugTraceLine(line: string): AgentDebugTraceEntry | null {
  try {
    const record = JSON.parse(line) as Record<string, any>;
    const validation = typeof record.validation === 'object' && record.validation !== null
      ? record.validation as Record<string, any>
      : null;
    const events = Array.isArray(record.events)
      ? record.events.map((event) => summarizeTraceEvent(event)).filter((event): event is AgentTraceEvent => event !== null)
      : [];

    return {
      timestamp: typeof record.timestamp === 'string' ? record.timestamp : null,
      phase: typeof record.phase === 'string' ? record.phase : null,
      tick: typeof record.tick === 'number' ? record.tick : null,
      day: typeof record.day === 'number' ? record.day : null,
      timeOfDay: typeof record.timeOfDay === 'string' ? record.timeOfDay : null,
      sessionId: typeof record.sessionId === 'string' ? record.sessionId : null,
      gatewayHost: typeof record.gatewayHost === 'string' ? record.gatewayHost : null,
      retryAttempted: record.retryAttempted === true,
      rawResponse: typeof record.rawResponse === 'string' ? record.rawResponse : null,
      parsedActionJson: record.parsedAction ? safeJson(record.parsedAction) : null,
      validationOutcome: validation && typeof validation.outcome === 'string' ? validation.outcome : null,
      validationNote: validation && typeof validation.note === 'string' ? validation.note : null,
      error: typeof record.error === 'string' ? record.error : null,
      promptText: typeof record.prompt === 'string' ? record.prompt : null,
      promptPreview: typeof record.prompt === 'string' ? firstLine(record.prompt) : null,
      events,
    };
  } catch {
    return null;
  }
}

function summarizeTraceEvent(event: any): AgentTraceEvent | null {
  if (!event || typeof event !== 'object') return null;
  const type = typeof event.type === 'string' ? event.type : 'unknown';
  const name = typeof event.name === 'string' ? event.name : undefined;

  if (type === 'tool_call') {
    return {
      type,
      name,
      preview: `${name ?? 'tool'}(${previewValue(event.args)})`,
      full: safeJson(event.args),
    };
  }

  if (type === 'tool_result') {
    return {
      type,
      name,
      preview: `${name ?? 'tool'} => ${previewValue(event.output)}`,
      full: safeJson(event.output),
    };
  }

  if (type === 'chunk') {
    return {
      type,
      preview: previewValue(event.content),
      full: typeof event.content === 'string' ? event.content : safeJson(event.content),
    };
  }

  if (type === 'done') {
    return {
      type,
      preview: previewValue(event.full_response),
      full: typeof event.full_response === 'string' ? event.full_response : safeJson(event.full_response),
    };
  }

  if (type === 'session_start') {
    return {
      type,
      name: typeof event.name === 'string' ? event.name : undefined,
      preview: `session ${event.resumed ? 'resumed' : 'started'}${typeof event.message_count === 'number' ? ` · ${event.message_count} msgs` : ''}`,
      full: safeJson(event),
    };
  }

  if (type === 'error') {
    return {
      type,
      preview: previewValue(event.message),
      full: typeof event.message === 'string' ? event.message : safeJson(event),
    };
  }

  return {
    type,
    name,
    preview: previewValue(event),
    full: safeJson(event),
  };
}

function previewValue(value: unknown, maxLength = 160): string {
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else {
    text = safeJson(value);
  }
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return '(empty)';
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? '';
}
