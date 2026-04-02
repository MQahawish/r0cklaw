"use node";

import { v } from 'convex/values';
import { action } from '../_generated/server';
import { api } from '../_generated/api';
import * as fs from 'fs/promises';
import * as path from 'path';

const INSPECTOR_FILES = [
  { label: 'Soul', file: 'SOUL.md' },
  { label: 'Heartbeat', file: 'HEARTBEAT.md' },
  { label: 'Journal', file: 'JOURNAL.md' },
  { label: 'Turn', file: 'TURN.md' },
];

export type AgentFileEntry = {
  label: string;
  file: string;
  content: string | null;
};

export type SocialFileEntry = {
  otherAgent: string;
  content: string;
};

export const getAgentFiles = action({
  args: { agentName: v.string() },
  handler: async (ctx, { agentName }): Promise<{ files: AgentFileEntry[]; social: SocialFileEntry[] }> => {
    const agents = await ctx.runQuery(api.rocklaw.observe.getAgentWorkspacePaths);
    const agent = agents.find((entry) => entry.name === agentName);
    if (!agent) return { files: [], social: [] };

    const absPath = resolveWorkspacePath(agent.workspacePath);

    const files: AgentFileEntry[] = await Promise.all(
      INSPECTOR_FILES.map(async ({ label, file }) => {
        try {
          const content = await fs.readFile(path.join(absPath, file), 'utf8');
          return { label, file, content };
        } catch {
          return { label, file, content: null };
        }
      }),
    );

    return { files, social: [] };
  },
});

function resolveWorkspacePath(workspacePath: string): string {
  if (path.isAbsolute(workspacePath)) return workspacePath;
  const root = process.env.ROCKLAW_PROJECT_ROOT || process.cwd();
  return path.resolve(root, workspacePath);
}
