"use node";

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import * as path from 'path';

export const runCompaction = internalAction({
  args: {},
  handler: async (ctx) => {
    const agents = await ctx.runQuery(internal.rocklaw.compact.getAllAgents);
    console.log(`[compact] Running compaction for ${agents.length} agents`);

    for (const agent of agents) {
      await ctx.runAction(internal.rocklaw.compactNode.compactAgent, {
        agentName: agent.name,
        workspacePath: agent.workspacePath,
      });
    }

    console.log('[compact] Compaction complete');
  },
});

export const compactAgent = internalAction({
  args: {
    agentName: v.string(),
    workspacePath: v.string(),
  },
  handler: async (_ctx, { agentName, workspacePath }) => {
    resolveWorkspacePath(workspacePath);
    console.log(`[compact] ${agentName}: no markdown compaction targets remain`);
  },
});

function resolveWorkspacePath(workspacePath: string): string {
  if (path.isAbsolute(workspacePath)) return workspacePath;
  const root = process.env.ROCKLAW_PROJECT_ROOT || process.cwd();
  return path.resolve(root, workspacePath);
}
