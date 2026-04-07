"use node";

import { v } from 'convex/values';
import { action, internalAction } from '../_generated/server';
import { api, internal } from '../_generated/api';

const AGENT_NAME_BY_SLUG: Record<string, string> = {
  elena: 'Elena Voss',
  marcus: 'Marcus Hale',
  finn: 'Finn',
  lena: 'Lena Marsh',
  sera: 'Sera',
};

const FALLBACK_AGENT_CONFIG_DEFAULTS: Record<string, { defaultProvider: string; defaultModel: string }> = {
  'Elena Voss': {
    defaultProvider: 'openrouter',
    defaultModel: 'nvidia/nemotron-3-super-120b-a12b:free',
  },
  'Marcus Hale': {
    defaultProvider: 'openrouter',
    defaultModel: 'qwen/qwen3-next-80b-a3b-instruct:free',
  },
  Finn: {
    defaultProvider: 'openrouter',
    defaultModel: 'qwen/qwen3.6-plus:free',
  },
  'Lena Marsh': {
    defaultProvider: 'openrouter',
    defaultModel: 'qwen/qwen3.6-plus:free',
  },
  Sera: {
    defaultProvider: 'openrouter',
    defaultModel: 'qwen/qwen3.6-plus:free',
  },
};

const ALL_AGENT_SLUGS = Object.keys(AGENT_NAME_BY_SLUG);

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

function parseConfigValue(toml: string, key: string): string | null {
  const match = toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm'));
  return match ? match[1] : null;
}

async function fetchOpenRouterFreeSelection(topN = 8) {
  const response = await fetch('https://openrouter.ai/api/v1/models');
  if (!response.ok) {
    throw new Error(`OpenRouter model fetch failed: ${response.status} ${response.statusText}`);
  }
  const payload = await response.json() as any;
  const models = Array.isArray(payload?.data) ? payload.data : [];
  const ranked = models
    .filter((model: any) =>
      model?.pricing?.prompt === '0'
      && model?.pricing?.completion === '0'
      && Array.isArray(model?.supported_parameters)
      && model.supported_parameters.includes('tools'))
    .map((model: any) => ({
      id: model.id,
      contextLength: model?.top_provider?.context_length ?? model?.context_length ?? 0,
    }))
    .sort((a: any, b: any) => b.contextLength - a.contextLength || String(a.id).localeCompare(String(b.id)))
    .slice(0, topN);
  if (ranked.length === 0) {
    throw new Error('No free OpenRouter models with tool support were found.');
  }
  return {
    selected: ranked[0].id as string,
    candidates: ranked.map((entry: any) => entry.id as string),
  };
}

async function fetchOpenRouterRecommendedModels(topN = 24) {
  const response = await fetch('https://openrouter.ai/api/v1/models');
  if (!response.ok) {
    throw new Error(`OpenRouter model fetch failed: ${response.status} ${response.statusText}`);
  }
  const payload = await response.json() as any;
  const models = Array.isArray(payload?.data) ? payload.data : [];
  const ranked = models
    .filter((model: any) =>
      model?.pricing?.prompt === '0'
      && model?.pricing?.completion === '0'
      && Array.isArray(model?.supported_parameters)
      && model.supported_parameters.includes('tools'))
    .map((model: any) => ({
      id: String(model.id),
      name: String(model.name ?? model.id),
      contextLength: model?.top_provider?.context_length ?? model?.context_length ?? 0,
    }))
    .sort((a: any, b: any) => b.contextLength - a.contextLength || a.id.localeCompare(b.id))
    .slice(0, topN);
  if (ranked.length === 0) {
    throw new Error('No free OpenRouter models with tool support were found.');
  }
  return {
    selected: ranked[0].id,
    candidates: ranked.map((entry: any) => entry.id),
    ranked,
  };
}

async function stopAllAgentProcesses() {
  const { execFileSync } = await import('child_process');
  const path = await import('path');
  const root = process.cwd();
  execFileSync('bash', [path.join(root, 'scripts', 'stop-all-agents.sh')], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
}

async function resetAgentSession(agentSlug: string, profile: 'blank-self' | 'seeded') {
  const { execFileSync } = await import('child_process');
  const path = await import('path');
  const root = process.cwd();
  execFileSync('bash', [path.join(root, 'scripts', 'reset-agent-session.sh'), agentSlug, profile === 'blank-self' ? '--blank-self' : '--seeded'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
}

async function startAgentGateway(agentSlug: string) {
  const fs = await import('fs/promises');
  const nodeFs = await import('fs');
  const path = await import('path');
  const { spawn } = await import('child_process');
  const root = process.cwd();
  const agentDir = path.join(root, 'agents', agentSlug);
  const logFile = `/tmp/zeroclaw-${agentSlug}.log`;
  const pidFile = `/tmp/zeroclaw-${agentSlug}.pid`;

  const child = spawn('zeroclaw', ['--config-dir', agentDir, 'gateway', 'start'], {
    cwd: agentDir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  await fs.writeFile(pidFile, String(child.pid), 'utf8');
  const logStream = nodeFs.createWriteStream(logFile, { flags: 'a' });
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);
  child.unref();
}

async function recordCurrentStepSummary(ctx: any): Promise<any> {
  const summary: any = await ctx.runQuery(api.rocklaw.observe.getStepSummary, {});
  await ctx.runMutation(internal.rocklaw.god._recordRunTickSummary, {
    tick: summary.tick,
    day: summary.day,
    timeOfDay: summary.timeOfDay,
    summaryJson: JSON.stringify(summary),
  });
  await ctx.runMutation(internal.rocklaw.god._upsertRunConsoleState, {
    lastSummaryTick: summary.tick,
  });
  return summary;
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

export const getAgentConfigDefaults = action({
  args: {
    agentName: v.string(),
  },
  handler: async (ctx, { agentName }) => {
    const agent = await ctx.runQuery(internal.rocklaw.bridge.getAgent, { agentName });
    if (!agent) {
      throw new Error(`Agent not found: ${agentName}`);
    }

    const fs = await import('fs/promises');
    const path = await import('path');
    const workspacePath = path.resolve(process.cwd(), agent.workspacePath);
    const agentDir = path.dirname(workspacePath);
    const configPath = path.join(agentDir, 'config.toml');
    const fallback = FALLBACK_AGENT_CONFIG_DEFAULTS[agentName] ?? null;

    try {
      const toml = await fs.readFile(configPath, 'utf8');

      return {
        defaultProvider: parseConfigValue(toml, 'default_provider') ?? fallback?.defaultProvider ?? null,
        defaultModel: parseConfigValue(toml, 'default_model') ?? fallback?.defaultModel ?? null,
      };
    } catch {
      return {
        defaultProvider: fallback?.defaultProvider ?? null,
        defaultModel: fallback?.defaultModel ?? null,
      };
    }
  },
});

export const listOpenRouterRecommendedModels = action({
  args: {
    topN: v.optional(v.number()),
  },
  handler: async (_ctx, { topN }) => {
    return await fetchOpenRouterRecommendedModels(topN ?? 24);
  },
});

// ─── Multi-provider model listing ────────────────────────────────────────────

type ProviderModel = {
  id: string;
  name: string;
  contextLength: number;
  pricing?: { prompt: string; completion: string };
};

const ANTHROPIC_MODELS: ProviderModel[] = [
  { id: 'claude-opus-4-6',   name: 'Claude Opus 4.6',   contextLength: 200000 },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextLength: 200000 },
  { id: 'claude-haiku-4-5',  name: 'Claude Haiku 4.5',  contextLength: 200000 },
];

const OPENAI_FALLBACK_MODELS: ProviderModel[] = [
  { id: 'gpt-4.1',      name: 'GPT-4.1',      contextLength: 1047576 },
  { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', contextLength: 1047576 },
  { id: 'o4-mini',      name: 'o4-mini',       contextLength: 200000 },
  { id: 'o3',           name: 'o3',            contextLength: 200000 },
];

const GOOGLE_FALLBACK_MODELS: ProviderModel[] = [
  { id: 'gemini-2.5-pro',   name: 'Gemini 2.5 Pro',   contextLength: 1048576 },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextLength: 1048576 },
];

async function fetchAllOpenRouterModels(topN = 80): Promise<ProviderModel[]> {
  const response = await fetch('https://openrouter.ai/api/v1/models');
  if (!response.ok) return [];
  const payload = await response.json() as any;
  const models: any[] = Array.isArray(payload?.data) ? payload.data : [];
  return models
    .filter((m) =>
      Array.isArray(m?.supported_parameters) &&
      m.supported_parameters.includes('tools'))
    .map((m) => ({
      id: String(m.id),
      name: String(m.name ?? m.id),
      contextLength: (m?.top_provider?.context_length ?? m?.context_length ?? 0) as number,
      pricing: {
        prompt: String(m?.pricing?.prompt ?? '0'),
        completion: String(m?.pricing?.completion ?? '0'),
      },
    }))
    .sort((a, b) => {
      const aFree = a.pricing!.prompt === '0' && a.pricing!.completion === '0';
      const bFree = b.pricing!.prompt === '0' && b.pricing!.completion === '0';
      if (aFree && !bFree) return -1;
      if (!aFree && bFree) return 1;
      return b.contextLength - a.contextLength || a.id.localeCompare(b.id);
    })
    .slice(0, topN);
}

async function fetchOpenAIModels(): Promise<ProviderModel[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return OPENAI_FALLBACK_MODELS;
  const response = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) return OPENAI_FALLBACK_MODELS;
  const payload = await response.json() as any;
  const models: any[] = Array.isArray(payload?.data) ? payload.data : [];
  const CHAT_PREFIXES = ['gpt-4', 'gpt-3.5-turbo', 'o1', 'o3', 'o4'];
  const SKIP = ['instruct', 'audio', 'realtime', 'search', 'transcribe', 'tts', 'whisper', 'dall-e', 'embedding', 'babbage', 'davinci', 'ada', 'curie'];
  return models
    .filter((m) => {
      const id = String(m.id);
      return CHAT_PREFIXES.some((p) => id.startsWith(p)) && !SKIP.some((s) => id.includes(s));
    })
    .map((m) => ({ id: String(m.id), name: String(m.id), contextLength: 0 }))
    .sort((a, b) => b.id.localeCompare(a.id));
}

async function fetchGoogleModels(): Promise<ProviderModel[]> {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) return GOOGLE_FALLBACK_MODELS;
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
    headers: { 'x-goog-api-key': apiKey },
  });
  if (!response.ok) return GOOGLE_FALLBACK_MODELS;
  const payload = await response.json() as any;
  const models: any[] = Array.isArray(payload?.models) ? payload.models : [];
  return models
    .filter((m) =>
      Array.isArray(m?.supportedGenerationMethods) &&
      m.supportedGenerationMethods.includes('generateContent') &&
      String(m.name).includes('gemini'))
    .map((m) => ({
      id: String(m.name).replace('models/', ''),
      name: String(m.displayName ?? m.name),
      contextLength: (m?.inputTokenLimit ?? 0) as number,
    }))
    .sort((a, b) => b.contextLength - a.contextLength || a.id.localeCompare(b.id));
}

export const listProviderModels = action({
  args: {
    provider: v.string(),
    topN: v.optional(v.number()),
  },
  handler: async (_ctx, { provider, topN }): Promise<{ models: ProviderModel[] }> => {
    switch (provider) {
      case 'openrouter':
        return { models: await fetchAllOpenRouterModels(topN ?? 80) };
      case 'openai':
        return { models: await fetchOpenAIModels() };
      case 'google':
        return { models: await fetchGoogleModels() };
      case 'anthropic':
        return { models: ANTHROPIC_MODELS };
      default:
        return { models: [] };
    }
  },
});

async function callModelTest(provider: string, modelId: string): Promise<string> {
  const messages = [{ role: 'user', content: 'Reply with exactly one word: ok' }];

  if (provider === 'openrouter') {
    const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.ZEROCLAW_API_KEY;
    if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, messages, max_tokens: 32 }),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const data = await res.json() as any;
    return String(data?.choices?.[0]?.message?.content ?? '(empty)').trim();
  }

  if (provider === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, messages, max_tokens: 32 }),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const data = await res.json() as any;
    return String(data?.choices?.[0]?.message?.content ?? '(empty)').trim();
  }

  if (provider === 'google') {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Reply with exactly one word: ok' }] }],
          generationConfig: { maxOutputTokens: 32 },
        }),
      },
    );
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const data = await res.json() as any;
    return String(data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '(empty)').trim();
  }

  if (provider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: modelId, messages, max_tokens: 32 }),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const data = await res.json() as any;
    return String(data?.content?.[0]?.text ?? '(empty)').trim();
  }

  throw new Error(`Unknown provider: ${provider}`);
}

export const testModel = action({
  args: {
    provider: v.string(),
    modelId: v.string(),
  },
  handler: async (
    _ctx,
    { provider, modelId },
  ): Promise<{ ok: boolean; reply?: string; latencyMs: number; error?: string }> => {
    const start = Date.now();
    try {
      const reply = await callModelTest(provider, modelId);
      return { ok: true, reply, latencyMs: Date.now() - start };
    } catch (e) {
      return { ok: false, error: String(e), latencyMs: Date.now() - start };
    }
  },
});

export const prepareRunConsole = action({
  args: {
    mode: v.union(v.literal('fresh'), v.literal('continue')),
    profile: v.union(v.literal('blank-self'), v.literal('seeded')),
    selectedAgentSlugs: v.array(v.string()),
    providerPreset: v.string(),
    modelProvider: v.optional(v.string()),
    modelId: v.optional(v.string()),
    fallbackProvider: v.optional(v.string()),
    fallbackModel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const selectedAgentSlugs = Array.from(new Set(args.selectedAgentSlugs))
      .filter((slug) => ALL_AGENT_SLUGS.includes(slug));
    if (selectedAgentSlugs.length === 0) {
      throw new Error('Select at least one agent.');
    }

    await ctx.runMutation(api.rocklaw.god.stopRunAuto, {});
    await ctx.runMutation(api.rocklaw.god.stopSim, {});
    await ctx.runMutation(internal.rocklaw.god._upsertRunConsoleState, {
      controlStatus: 'preparing',
      selectedAgentSlugsJson: JSON.stringify(selectedAgentSlugs),
      mode: args.mode,
      profile: args.profile,
      providerPreset: args.providerPreset,
      modelProvider: args.modelProvider,
      modelId: args.modelId,
      fallbackProvider: args.fallbackProvider,
      fallbackModel: args.fallbackModel,
      clearLastError: true,
    });

    try {
      await stopAllAgentProcesses();
      if (args.mode === 'fresh') {
        await ctx.runMutation(api.rocklaw.init.initRocklaw, {
          force: true,
          agentNames: selectedAgentSlugs.map((slug) => AGENT_NAME_BY_SLUG[slug]),
        });
      } else {
        await ctx.runMutation(api.rocklaw.init.initRocklaw, {});
      }

      await ctx.runMutation(api.rocklaw.init.setAllAgentsBlankProfile, { blankSelf: false });
      for (const slug of selectedAgentSlugs) {
        await resetAgentSession(slug, args.profile);
        await ctx.runMutation(api.rocklaw.init.setAgentBlankProfile, {
          agentName: AGENT_NAME_BY_SLUG[slug],
          blankSelf: args.profile === 'blank-self',
        });
      }

      await ctx.runMutation(api.rocklaw.init.setWorkspaceRoot, { rootPath: process.cwd() });
      await ctx.runMutation(internal.rocklaw.god._setRunAgentSelection, {
        selectedAgentNames: selectedAgentSlugs.map((slug) => AGENT_NAME_BY_SLUG[slug]),
      });

      if (args.providerPreset === 'openrouter-free') {
        if (!args.fallbackModel) {
          throw new Error('Fallback model is required for openrouter-free.');
        }
        const selection = await fetchOpenRouterRecommendedModels();
        const currentModel = args.modelId && selection.candidates.includes(args.modelId)
          ? args.modelId
          : selection.selected;
        for (const slug of selectedAgentSlugs) {
          const agentName = AGENT_NAME_BY_SLUG[slug];
          await ctx.runAction(api.rocklaw.godNode.configureOpenRouterFreeAgent, {
            agentName,
            currentModel,
            fallbackModel: args.fallbackModel,
            fallbackProvider: args.fallbackProvider ?? 'openrouter',
            candidatesJson: JSON.stringify(selection.candidates),
          });
        }
      } else if (args.modelId) {
        for (const slug of selectedAgentSlugs) {
          await ctx.runAction(api.rocklaw.godNode.setAgentModel, {
            agentName: AGENT_NAME_BY_SLUG[slug],
            modelOverride: args.modelId,
            providerOverride: args.modelProvider ?? 'openrouter',
          });
          await ctx.runAction(api.rocklaw.godNode.clearOpenRouterFreeAgent, {
            agentName: AGENT_NAME_BY_SLUG[slug],
          });
        }
      }

      for (const slug of selectedAgentSlugs) {
        await startAgentGateway(slug);
      }

      await ctx.runMutation(internal.rocklaw.god._clearRunTickSummaries, {});
      const worldState = await ctx.runQuery(internal.rocklaw.engine.getWorldState, {});
      await ctx.runMutation(internal.rocklaw.god._upsertRunConsoleState, {
        controlStatus: 'ready',
        autoRunning: false,
        stepInProgress: false,
        lastPreparedTick: worldState?.tick ?? 0,
        clearLastSummaryTick: true,
        clearLastError: true,
      });
      return { status: 'ready', selectedAgentSlugs };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internal.rocklaw.god._upsertRunConsoleState, {
        controlStatus: 'error',
        autoRunning: false,
        stepInProgress: false,
        lastError: message,
      });
      throw error;
    }
  },
});

export const stepRunConsole = action({
  args: {},
  handler: async (ctx): Promise<{ status: 'busy' } | { status: 'ok'; tick: number }> => {
    const state = await ctx.runQuery(api.rocklaw.god.getRunConsole, {});
    if (state.state.stepInProgress) {
      return { status: 'busy' as const };
    }

    await ctx.runMutation(internal.rocklaw.god._upsertRunConsoleState, {
      stepInProgress: true,
      controlStatus: 'running',
      clearLastError: true,
    });

    try {
      await ctx.runAction(api.rocklaw.engine.manualTick, {});
      const summary: any = await recordCurrentStepSummary(ctx);
      await ctx.runMutation(internal.rocklaw.god._upsertRunConsoleState, {
        stepInProgress: false,
        controlStatus: 'ready',
        lastSummaryTick: summary.tick,
      });
      return { status: 'ok' as const, tick: summary.tick };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internal.rocklaw.god._upsertRunConsoleState, {
        stepInProgress: false,
        autoRunning: false,
        controlStatus: 'error',
        lastError: message,
      });
      throw error;
    }
  },
});

export const runConsoleAutoLoop = internalAction({
  args: { loopToken: v.number() },
  handler: async (ctx, { loopToken }) => {
    const runConsole = await ctx.runQuery(api.rocklaw.god.getRunConsole, {});
    if (!runConsole.state.autoRunning || runConsole.state.loopToken !== loopToken || runConsole.state.stepInProgress) {
      return;
    }

    await ctx.runMutation(internal.rocklaw.god._upsertRunConsoleState, {
      stepInProgress: true,
      controlStatus: 'running',
      clearLastError: true,
    });

    try {
      const batchSize = Math.max(1, Math.min(20, runConsole.state.stepBatchSize ?? 1));
      for (let index = 0; index < batchSize; index += 1) {
        const latest = await ctx.runQuery(api.rocklaw.god.getRunConsole, {});
        if (!latest.state.autoRunning || latest.state.loopToken !== loopToken) break;
        await ctx.runAction(api.rocklaw.engine.manualTick, {});
        await recordCurrentStepSummary(ctx);
      }

      const latest = await ctx.runQuery(api.rocklaw.god.getRunConsole, {});
      await ctx.runMutation(internal.rocklaw.god._upsertRunConsoleState, {
        stepInProgress: false,
        controlStatus: latest.state.autoRunning ? 'running' : 'ready',
      });
      if (latest.state.autoRunning && latest.state.loopToken === loopToken) {
        await ctx.scheduler.runAfter(250, internal.rocklaw.godNode.runConsoleAutoLoop, { loopToken });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internal.rocklaw.god._upsertRunConsoleState, {
        autoRunning: false,
        stepInProgress: false,
        controlStatus: 'error',
        lastError: message,
      });
    }
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
