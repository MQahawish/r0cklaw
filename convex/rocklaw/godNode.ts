"use node";

import { v } from 'convex/values';
import { action } from '../_generated/server';
import { internal } from '../_generated/api';

export const setAgentModel = action({
  args: {
    agentName: v.string(),
    modelOverride: v.string(),
    providerOverride: v.optional(v.string()),
  },
  handler: async (ctx, { agentName, modelOverride, providerOverride }) => {
    await ctx.runMutation(internal.rocklaw.god._patchAgentModel, {
      agentName,
      modelOverride,
      providerOverride,
    });

    const fs = await import('fs/promises');
    const path = await import('path');
    const { execSync, spawn } = await import('child_process');
    const nodeFs = await import('fs');

    const agentDir = path.resolve(process.cwd(), 'agents', agentName.toLowerCase());
    const configPath = path.join(agentDir, 'config.toml');

    let toml = await fs.readFile(configPath, 'utf8');
    toml = toml.replace(/^default_model\s*=\s*.+$/m, `default_model = "${modelOverride}"`);

    const provider = providerOverride ?? 'openrouter';
    if (/^default_provider\s*=/m.test(toml)) {
      toml = toml.replace(/^default_provider\s*=\s*.+$/m, `default_provider = "${provider}"`);
    } else {
      toml = `default_provider = "${provider}"\n${toml}`;
    }

    await fs.writeFile(configPath, toml, 'utf8');

    const agentSlug = agentName.toLowerCase();
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
  },
});
