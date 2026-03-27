"use node";

import { v } from 'convex/values';
import { action } from '../_generated/server';
import { api } from '../_generated/api';
import * as fs from 'fs/promises';
import * as path from 'path';

const INSPECTOR_FILES = [
  { label: 'Soul', file: 'SOUL.md' },
  { label: 'Memory', file: 'MEMORY.md' },
  { label: 'Heartbeat', file: 'HEARTBEAT.md' },
  { label: 'Beliefs', file: 'self/beliefs.md' },
  { label: 'Goals', file: 'self/goals.md' },
  { label: 'Plans', file: 'self/plans.md' },
  { label: 'Secrets', file: 'self/secrets.md' },
  { label: 'Desires', file: 'self/desires.md' },
  { label: 'Status', file: 'world/status.md' },
  { label: 'Inventory', file: 'world/inventory.md' },
  { label: 'Location', file: 'world/location.md' },
  { label: 'Chat', file: 'world/CHAT.md' },
  { label: 'Offers', file: 'world/OFFERS.md' },
  { label: 'News', file: 'world/village_news.md' },
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

    const social: SocialFileEntry[] = [];
    const socialDir = path.join(absPath, 'self', 'social');
    try {
      const entries = await fs.readdir(socialDir);
      for (const entry of entries) {
        try {
          const content = await fs.readFile(path.join(socialDir, entry, 'private.md'), 'utf8');
          social.push({ otherAgent: entry, content });
        } catch {
          // no private.md yet
        }
      }
    } catch {
      // no social dir yet
    }

    return { files, social };
  },
});

function resolveWorkspacePath(workspacePath: string): string {
  if (path.isAbsolute(workspacePath)) return workspacePath;
  const root = process.env.ROCKLAW_PROJECT_ROOT || process.cwd();
  return path.resolve(root, workspacePath);
}
