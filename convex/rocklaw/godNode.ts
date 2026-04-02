"use node";

import { v } from 'convex/values';
import { action, internalAction } from '../_generated/server';
import { internal } from '../_generated/api';

async function applyAgentModelSwitch(
  ctx: any,
  agentName: string,
  modelOverride: string,
  providerOverride?: string,
) {
  await ctx.runMutation(internal.rocklaw.god._patchAgentModel, {
    agentName,
    modelOverride,
    providerOverride,
  });

  const agent = await ctx.runQuery(internal.rocklaw.bridge.getAgent, { agentName });
  if (!agent) {
    throw new Error(`Agent not found: ${agentName}`);
  }

  const fs = await import('fs/promises');
  const path = await import('path');
  const { execSync, spawn } = await import('child_process');
  const nodeFs = await import('fs');

  const workspacePath = path.resolve(process.cwd(), agent.workspacePath);
  const agentDir = path.dirname(workspacePath);
  const configPath = path.join(agentDir, 'config.toml');

  let toml = await fs.readFile(configPath, 'utf8');
  if (/^default_model\s*=/m.test(toml)) {
    toml = toml.replace(/^default_model\s*=\s*.+$/m, `default_model = "${modelOverride}"`);
  } else {
    toml = `default_model = "${modelOverride}"\n${toml}`;
  }

  const provider = providerOverride ?? 'openrouter';
  if (/^default_provider\s*=/m.test(toml)) {
    toml = toml.replace(/^default_provider\s*=\s*.+$/m, `default_provider = "${provider}"`);
  } else {
    toml = `default_provider = "${provider}"\n${toml}`;
  }

  await fs.writeFile(configPath, toml, 'utf8');

  const agentSlug = path.basename(agentDir);
  const pidFile = `/tmp/zeroclaw-${agentSlug}.pid`;
  const logFile = `/tmp/zeroclaw-${agentSlug}.log`;

  try {
    const pid = (await fs.readFile(pidFile, 'utf8')).trim();
    execSync(`kill ${pid} 2>/dev/null || true`);
  } catch {
    // already stopped or no pid file
  }

  const child = spawn(
    'zeroclaw',
    ['--config-dir', agentDir, 'gateway', 'start'],
    {
      cwd: agentDir,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    },
  );
  await fs.writeFile(pidFile, String(child.pid), 'utf8');

  const logStream = nodeFs.createWriteStream(logFile, { flags: 'a' });
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);
  child.unref();
}

export const switchAgentModelInternal = internalAction({
  args: {
    agentName: v.string(),
    modelOverride: v.string(),
    providerOverride: v.optional(v.string()),
  },
  handler: async (ctx, { agentName, modelOverride, providerOverride }) => {
    await applyAgentModelSwitch(ctx, agentName, modelOverride, providerOverride);
  },
});

export const setAgentModel = action({
  args: {
    agentName: v.string(),
    modelOverride: v.string(),
    providerOverride: v.optional(v.string()),
  },
  handler: async (ctx, { agentName, modelOverride, providerOverride }) => {
    await applyAgentModelSwitch(ctx, agentName, modelOverride, providerOverride);
  },
});

export const configureOpenRouterFreeAgent = action({
  args: {
    agentName: v.string(),
    currentModel: v.string(),
    fallbackModel: v.string(),
    fallbackProvider: v.optional(v.string()),
    candidatesJson: v.string(),
  },
  handler: async (ctx, { agentName, currentModel, fallbackModel, fallbackProvider, candidatesJson }) => {
    await ctx.runMutation(internal.rocklaw.bridge.configureOpenRouterFreeAgent, {
      agentName,
      currentModel,
      fallbackModel,
      fallbackProvider,
      candidatesJson,
    });
  },
});

export const clearOpenRouterFreeAgent = action({
  args: { agentName: v.string() },
  handler: async (ctx, { agentName }) => {
    await ctx.runMutation(internal.rocklaw.bridge.clearOpenRouterFreeAgent, { agentName });
  },
});
