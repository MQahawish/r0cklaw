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

export const getAgentFiles = action({
  args: { agentName: v.string() },
  handler: async (ctx, { agentName }): Promise<{ files: AgentFileEntry[] }> => {
    const agents = await ctx.runQuery(api.rocklaw.observe.getAgentWorkspacePaths);
    const agent = agents.find((entry) => entry.name === agentName);
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
