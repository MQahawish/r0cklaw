"use node";

import { v } from 'convex/values';
import { action, internalAction } from '../_generated/server';
import { api, internal } from '../_generated/api';
import { Doc } from '../_generated/dataModel';

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

const KNOWN_MODEL_PRICING_USD_PER_TOKEN: Record<string, { input: number; output: number }> = {
  'openai:gpt-4.1': {
    input: 2 / 1_000_000,
    output: 8 / 1_000_000,
  },
  'openai:gpt-4.1-mini': {
    input: 0.4 / 1_000_000,
    output: 1.6 / 1_000_000,
  },
  'openai:gpt-4.1-nano': {
    input: 0.1 / 1_000_000,
    output: 0.4 / 1_000_000,
  },
  'openai:gpt-4o-mini': {
    input: 0.15 / 1_000_000,
    output: 0.6 / 1_000_000,
  },
};

function normalizeModelId(modelId: string | null | undefined): string | null {
  if (!modelId) return null;
  const trimmed = modelId.trim();
  if (!trimmed) return null;
  return trimmed.split(':')[0];
}

function lookupKnownModelPricing(
  provider: string | null | undefined,
  modelId: string | null | undefined,
): { promptPriceUsd: number; completionPriceUsd: number } | null {
  const normalizedProvider = provider?.trim().toLowerCase();
  const normalizedModel = normalizeModelId(modelId);
  if (!normalizedProvider || !normalizedModel) return null;
  const pricing = KNOWN_MODEL_PRICING_USD_PER_TOKEN[`${normalizedProvider}:${normalizedModel}`];
  if (!pricing) return null;
  return {
    promptPriceUsd: pricing.input,
    completionPriceUsd: pricing.output,
  };
}

async function applyAgentModelSwitch(
  ctx: any,
  agentName: string,
  modelOverride: string,
  providerOverride?: string,
  promptPriceUsd?: number,
  completionPriceUsd?: number,
) {
  const provider = providerOverride ?? 'openrouter';
  const resolvedPricing =
    promptPriceUsd !== undefined && completionPriceUsd !== undefined
      ? { promptPriceUsd, completionPriceUsd }
      : lookupKnownModelPricing(provider, modelOverride);
  await ctx.runMutation(internal.rocklaw.god._patchAgentModel, {
    agentName,
    modelOverride,
    providerOverride: provider,
    currentModelPromptPrice: resolvedPricing?.promptPriceUsd,
    currentModelCompletionPrice: resolvedPricing?.completionPriceUsd,
  });

  const agent = await ctx.runQuery(internal.rocklaw.bridge.getAgent, { agentName });
  if (!agent) {
    throw new Error(`Agent not found: ${agentName}`);
  }

  const fs = await import('fs/promises');
  const path = await import('path');
  const { execSync } = await import('child_process');

  const workspacePath = path.resolve(process.cwd(), agent.workspacePath);
  const agentDir = path.dirname(workspacePath);
  const configPath = path.join(agentDir, 'config.toml');

  let toml = await fs.readFile(configPath, 'utf8');
  if (/^default_model\s*=/m.test(toml)) {
    toml = toml.replace(/^default_model\s*=\s*.+$/m, `default_model = "${modelOverride}" # pinned`);
  } else {
    toml = `default_model = "${modelOverride}" # pinned\n${toml}`;
  }
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
    const pidString = (await fs.readFile(pidFile, 'utf8')).trim();
    if (pidString) {
      execSync(`kill ${pidString} 2>/dev/null || true`);
    }
  } catch {
    // already stopped or no pid file
  }

  const projectRoot = await resolveProjectRoot(workspacePath);
  await fs.rm(pidFile, { force: true });
  await startAgentGateway(agentSlug, projectRoot);

  // Force a UI refresh after model change
  await recordCurrentStepSummaryInternal(ctx);
}

function parseConfigValue(toml: string, key: string): string | null {
  const match = toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm'));
  return match ? match[1] : null;
}

async function readAgentConfigDefaults(agent: { workspacePath: string }, agentName: string) {
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

async function resolveProjectRoot(pathHint?: string | null) {
  const path = await import('path');
  if (pathHint && path.isAbsolute(pathHint)) {
    const normalized = pathHint.replace(/\\/g, '/');
    if (normalized.endsWith('/workspace') || normalized.includes('/agents/')) {
      return path.resolve(pathHint, '..', '..', '..');
    }
    return pathHint;
  }
  return process.env.ROCKLAW_PROJECT_ROOT || process.cwd();
}

async function resolveProjectOwner(projectRoot: string) {
  const { execFileSync } = await import('child_process');
  try {
    const owner = execFileSync('stat', ['-c', '%U', projectRoot], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    return owner || null;
  } catch {
    return null;
  }
}

async function resolveZeroClawBinary(pathHint?: string | null) {
  const path = await import('path');
  const os = await import('os');
  const nodeFs = await import('fs');
  const { execFileSync } = await import('child_process');
  const projectRoot = await resolveProjectRoot(pathHint);

  const homes = Array.from(new Set([
    process.env.HOME,
    os.homedir?.(),
    '/home/mahmoudqahawish',
  ].filter((value): value is string => Boolean(value))));

  const candidates = [
    path.join(projectRoot, '.rocklaw/bin/zeroclaw'),
    ...homes.flatMap((home) => [
      path.join(home, '.cargo/bin/zeroclaw'),
      path.join(home, '.local/bin/zeroclaw'),
    ]),
    '/usr/local/bin/zeroclaw',
    '/usr/bin/zeroclaw',
  ];

  for (const cand of candidates) {
    if (nodeFs.existsSync(cand)) return cand;
  }

  try {
    const resolved = execFileSync('bash', ['-lc', 'command -v zeroclaw'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      env: { ...process.env },
    }).trim();
    if (resolved) return resolved;
  } catch {
    // fall through
  }

  throw new Error('Unable to locate zeroclaw binary.');
}

async function buildGatewayEnv() {
  const path = await import('path');
  const os = await import('os');
  const home = process.env.HOME || os.homedir?.() || '/home/mahmoudqahawish';
  return {
    ...process.env,
    PATH: [
      path.join(home, '.cargo/bin'),
      path.join(home, '.local/bin'),
      '/usr/local/bin',
      '/usr/bin',
      process.env.PATH || '',
    ].filter(Boolean).join(':'),
    ZEROCLAW_DISABLE_PROVIDER_STREAMING: '1',
  };
}

async function stopAllAgentProcesses(projectRoot?: string | null) {
  const { execFileSync } = await import('child_process');
  const path = await import('path');
  const root = await resolveProjectRoot(projectRoot);
  execFileSync('bash', [path.join(root, 'scripts', 'stop-all-agents.sh')], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
}

async function resetAgentSession(agentSlug: string, profile: 'blank-self' | 'seeded', projectRoot?: string | null) {
  const { execFileSync } = await import('child_process');
  const path = await import('path');
  const root = await resolveProjectRoot(projectRoot);
  execFileSync('bash', [path.join(root, 'scripts', 'reset-agent-session.sh'), agentSlug, profile === 'blank-self' ? '--blank-self' : '--seeded'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
}

async function startAgentGateway(agentSlug: string, projectRoot?: string | null) {
  const fs = await import('fs/promises');
  const path = await import('path');
  const { spawn } = await import('child_process');
  const root = await resolveProjectRoot(projectRoot);
  const pidFile = `/tmp/zeroclaw-${agentSlug}.pid`;
  await fs.rm(pidFile, { force: true });

  const launcherScript = path.join(root, 'scripts', 'start-agent.sh');
  const owner = await resolveProjectOwner(root);
  const shouldDropPrivileges = typeof process.getuid === 'function' && process.getuid() === 0 && owner && owner !== 'root';
  const child = shouldDropPrivileges
    ? spawn('runuser', ['-u', owner, '--', 'bash', launcherScript, agentSlug], {
        cwd: root,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
      })
    : spawn('bash', [launcherScript, agentSlug], {
        cwd: root,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
      });
  child.on('error', (err) => {
    console.error(`Failed to launch gateway start script for ${agentSlug}:`, err);
  });
  child.unref();
}

export const recordCurrentStepSummary = internalAction({
  args: {
    tick: v.optional(v.number()),
    day: v.optional(v.number()),
    timeOfDay: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    return await recordCurrentStepSummaryInternal(ctx, args);
  },
});

async function recordCurrentStepSummaryInternal(
  ctx: any,
  args?: { tick?: number; day?: number; timeOfDay?: string },
): Promise<any> {
  const summary: any = await ctx.runQuery(api.rocklaw.observe.getStepSummary, args ?? {});
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
    promptPriceUsd: v.optional(v.number()),
    completionPriceUsd: v.optional(v.number()),
  },
  handler: async (ctx, { agentName, modelOverride, providerOverride, promptPriceUsd, completionPriceUsd }) => {
    await applyAgentModelSwitch(ctx, agentName, modelOverride, providerOverride, promptPriceUsd, completionPriceUsd);
  },
});

export const getAgentConfigDefaults = action({
  args: {
    agentName: v.string(),
  },
  handler: async (
    ctx,
    { agentName },
  ): Promise<{ defaultProvider: string | null; defaultModel: string | null }> => {
    const agent: { workspacePath: string } | null = await ctx.runQuery(internal.rocklaw.bridge.getAgent, { agentName });
    if (!agent) {
      throw new Error(`Agent not found: ${agentName}`);
    }
    return await readAgentConfigDefaults(agent, agentName);
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

type ProviderModelsResult = {
  models: ProviderModel[];
  isLive: boolean;
};

type CostTraceSource =
  | { path: string; kind: 'costs' | 'runtime-trace'; fileSize: number };

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
    .filter((m) => {
      const prompt = parseFloat(m?.pricing?.prompt ?? '0');
      const completion = parseFloat(m?.pricing?.completion ?? '0');
      return (
        Array.isArray(m?.supported_parameters) &&
        m.supported_parameters.includes('tools') &&
        prompt >= 0 && completion >= 0
      );
    })
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

async function fetchOpenAIModels(): Promise<ProviderModelsResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { models: OPENAI_FALLBACK_MODELS, isLive: false };
  const response = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) return { models: OPENAI_FALLBACK_MODELS, isLive: false };
  const payload = await response.json() as any;
  const models: any[] = Array.isArray(payload?.data) ? payload.data : [];
  const CHAT_PREFIXES = ['gpt-4', 'gpt-3.5-turbo', 'o1', 'o3', 'o4'];
  const SKIP = ['instruct', 'audio', 'realtime', 'search', 'transcribe', 'tts', 'whisper', 'dall-e', 'embedding', 'diarize', 'deep-research'];
  const DATED = /-\d{4}(-\d{2}-\d{2})?$/; // matches -2024-05-13 or legacy -0125 / -0613
  const CTX: Record<string, number> = {
    'gpt-4.1': 1047576, 'gpt-4.1-mini': 1047576, 'gpt-4.1-nano': 1047576,
    'gpt-4o': 128000, 'gpt-4o-mini': 128000,
    'gpt-4-turbo': 128000, 'gpt-4': 8192,
    'gpt-3.5-turbo': 16385, 'gpt-3.5-turbo-16k': 16385,
    'o1': 200000, 'o1-pro': 200000,
    'o3': 200000, 'o3-mini': 200000, 'o4-mini': 200000,
  };
  return {
    models: models
      .filter((m) => {
        const id = String(m.id);
        return CHAT_PREFIXES.some((p) => id.startsWith(p)) && !SKIP.some((s) => id.includes(s)) && !DATED.test(id);
      })
      .map((m) => ({ id: String(m.id), name: String(m.id), contextLength: CTX[String(m.id)] ?? 0 }))
      .sort((a, b) => b.id.localeCompare(a.id)),
    isLive: true,
  };
}

async function fetchGoogleModels(): Promise<ProviderModelsResult> {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) return { models: GOOGLE_FALLBACK_MODELS, isLive: false };
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
    headers: { 'x-goog-api-key': apiKey },
  });
  if (!response.ok) return { models: GOOGLE_FALLBACK_MODELS, isLive: false };
  const payload = await response.json() as any;
  const models: any[] = Array.isArray(payload?.models) ? payload.models : [];
  return {
    models: models
      .filter((m) => {
        const name = String(m.name);
        const SKIP = ['tts', 'image', 'native-audio', 'robotics', 'computer-use'];
        return (
          name.startsWith('models/gemini-') &&
          Array.isArray(m?.supportedGenerationMethods) &&
          m.supportedGenerationMethods.includes('generateContent') &&
          !SKIP.some((s) => name.includes(s))
        );
      })
      .map((m) => ({
        id: String(m.name).replace('models/', ''),
        name: String(m.displayName ?? m.name),
        contextLength: (m?.inputTokenLimit ?? 0) as number,
      }))
      .sort((a, b) => b.contextLength - a.contextLength || a.id.localeCompare(b.id)),
    isLive: true,
  };
}

export const listProviderModels = action({
  args: {
    provider: v.string(),
    topN: v.optional(v.number()),
  },
  handler: async (_ctx, { provider, topN }): Promise<ProviderModelsResult> => {
    switch (provider) {
      case 'openrouter':
        return { models: await fetchAllOpenRouterModels(topN ?? 80), isLive: true };
      case 'openai':
        return await fetchOpenAIModels();
      case 'google':
        return await fetchGoogleModels();
      case 'anthropic':
        return { models: ANTHROPIC_MODELS, isLive: true };
      default:
        return { models: [], isLive: false };
    }
  },
});

export const getRunAgentConfigs = action({
  args: {
    selectedAgentSlugs: v.array(v.string()),
  },
  handler: async (ctx, { selectedAgentSlugs }): Promise<Array<{
    slug: string;
    agentName: string;
    effectiveProvider: string;
    effectiveModel: string;
    providerSource: 'override' | 'config';
    modelSource: 'override' | 'config';
  }>> => {
    const slugs = Array.from(new Set(selectedAgentSlugs))
      .filter((slug) => ALL_AGENT_SLUGS.includes(slug));

    return await Promise.all(
      slugs.map(async (slug) => {
        const agentName = AGENT_NAME_BY_SLUG[slug];
        const agent: Doc<'rl_agents'> | null = await ctx.runQuery(internal.rocklaw.bridge.getAgent, { agentName });
        const defaultsFromConfig = agent ? await readAgentConfigDefaults(agent, agentName) : {
          defaultProvider: FALLBACK_AGENT_CONFIG_DEFAULTS[agentName]?.defaultProvider ?? null,
          defaultModel: FALLBACK_AGENT_CONFIG_DEFAULTS[agentName]?.defaultModel ?? null,
        };

        return {
          slug,
          agentName,
          effectiveProvider: agent?.providerOverride ?? defaultsFromConfig.defaultProvider ?? 'openrouter',
          effectiveModel: agent?.modelOverride ?? defaultsFromConfig.defaultModel ?? 'unknown',
          providerSource: agent?.providerOverride ? 'override' : 'config',
          modelSource: agent?.modelOverride ? 'override' : 'config',
        };
      }),
    );
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
    const isOSeries = /^o\d/.test(modelId);
    const tokenParam = isOSeries ? { max_completion_tokens: 32 } : { max_tokens: 32 };
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, messages, ...tokenParam }),
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

export const readAgentCostsDelta = internalAction({
  args: { agentName: v.string() },
  handler: async (ctx, { agentName }): Promise<void> => {
    const agent = await ctx.runQuery(internal.rocklaw.bridge.getAgent, { agentName });
    if (!agent) return;

    const fs = await import('fs/promises');
    const path = await import('path');

    const currentOffset = agent.costsFileOffset ?? 0;
    const stateDir = path.resolve(process.cwd(), agent.workspacePath, 'state');

    const traceSource = await resolveCostTraceSource(fs, path.join(stateDir, 'costs.jsonl'), path.join(stateDir, 'runtime-trace.jsonl'));
    if (!traceSource) {
      return;
    }

    const { path: tracePath, kind: traceKind, fileSize } = traceSource;

    let newBytes: Buffer;
    try {
      if (fileSize > currentOffset) {
        const fd = await fs.open(tracePath, 'r');
        try {
          const readSize = fileSize - currentOffset;
          const buf = Buffer.alloc(readSize);
          await fd.read(buf, 0, readSize, currentOffset);
          newBytes = buf;
        } finally {
          await fd.close();
        }
      } else {
        newBytes = Buffer.alloc(0);
      }
    } catch {
      return;
    }

    const lines = newBytes.toString('utf8').split('\n').filter((l) => l.trim().length > 0);
    let deltaInputTokens = 0;
    let deltaOutputTokens = 0;
    let deltaCostUsd = 0;

    const configDefaults = await readAgentConfigDefaults(agent, agentName);
    const inferredPricing = lookupKnownModelPricing(
      agent.providerOverride ?? configDefaults.defaultProvider,
      agent.modelOverride ?? configDefaults.defaultModel,
    );
    const promptPrice = agent.currentModelPromptPrice ?? inferredPricing?.promptPriceUsd ?? null;
    const completionPrice = agent.currentModelCompletionPrice ?? inferredPricing?.completionPriceUsd ?? null;

    let totalCostUsdFromTrace = 0;
    try {
      const fullText = await fs.readFile(tracePath, 'utf8');
      const fullLines = fullText.split('\n').filter((l) => l.trim().length > 0);
      for (const line of fullLines) {
        const parsed = parseCostTraceLine(line, traceKind);
        if (!parsed) continue;
        const { inputTokens, outputTokens, costUsd } = parsed;
        if (promptPrice !== null && completionPrice !== null) {
          totalCostUsdFromTrace += inputTokens * promptPrice + outputTokens * completionPrice;
        } else {
          totalCostUsdFromTrace += costUsd;
        }
      }
    } catch {
      totalCostUsdFromTrace = agent.lifetimeCostUsd ?? 0;
    }

    for (const line of lines) {
      const parsed = parseCostTraceLine(line, traceKind);
      if (!parsed) continue;

      const { inputTokens, outputTokens, costUsd } = parsed;
      deltaInputTokens += inputTokens;
      deltaOutputTokens += outputTokens;

      if (promptPrice !== null && completionPrice !== null) {
        deltaCostUsd += inputTokens * promptPrice + outputTokens * completionPrice;
      } else {
        deltaCostUsd += costUsd;
      }
    }

    if (totalCostUsdFromTrace > (agent.lifetimeCostUsd ?? 0)) {
      deltaCostUsd = totalCostUsdFromTrace - (agent.lifetimeCostUsd ?? 0);
    }

    if (deltaInputTokens === 0 && deltaOutputTokens === 0 && deltaCostUsd === 0) return;

    await ctx.runMutation(internal.rocklaw.god._patchAgentCosts, {
      agentName,
      deltaCostUsd,
      deltaInputTokens,
      deltaOutputTokens,
      newOffset: fileSize,
    });
  },
});

export const clearCostStats = action({
  args: {},
  handler: async (ctx): Promise<void> => {
    const fs = await import('fs/promises');
    const path = await import('path');

    const agentNames = Object.values(AGENT_NAME_BY_SLUG);
    const agentUpdates: Array<{ agentName: string; costsFileOffset: number }> = [];

    for (const agentName of agentNames) {
      const agent = await ctx.runQuery(internal.rocklaw.bridge.getAgent, { agentName });
      if (!agent) continue;
      const stateDir = path.resolve(process.cwd(), agent.workspacePath, 'state');
      const traceSource = await resolveCostTraceSource(fs, path.join(stateDir, 'costs.jsonl'), path.join(stateDir, 'runtime-trace.jsonl'));
      const fileSize = traceSource?.fileSize ?? 0;
      agentUpdates.push({ agentName, costsFileOffset: fileSize });
    }

    await ctx.runMutation(internal.rocklaw.god._clearAgentCosts, { agentUpdates });
  },
});

async function resolveCostTraceSource(
  fs: typeof import('fs/promises'),
  costsPath: string,
  runtimeTracePath: string,
): Promise<CostTraceSource | null> {
  try {
    const stat = await fs.stat(costsPath);
    return { path: costsPath, kind: 'costs', fileSize: stat.size };
  } catch {
    // Fall through to runtime trace fallback.
  }

  try {
    const stat = await fs.stat(runtimeTracePath);
    return { path: runtimeTracePath, kind: 'runtime-trace', fileSize: stat.size };
  } catch {
    return null;
  }
}

function parseCostTraceLine(
  line: string,
  kind: CostTraceSource['kind'],
): { inputTokens: number; outputTokens: number; costUsd: number } | null {
  let record: any;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }

  if (kind === 'costs') {
    const usage = record?.usage;
    if (!usage) return null;
    return {
      inputTokens: Number(usage.input_tokens ?? 0),
      outputTokens: Number(usage.output_tokens ?? 0),
      costUsd: Number(usage.cost_usd ?? 0),
    };
  }

  if (record?.event_type !== 'llm_response' || record?.success !== true) {
    return null;
  }

  const payload = record?.payload;
  if (!payload) return null;
  return {
    inputTokens: Number(payload.input_tokens ?? 0),
    outputTokens: Number(payload.output_tokens ?? 0),
    costUsd: Number(payload.cost_usd ?? 0),
  };
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
    const currentAgent = await ctx.runQuery(internal.rocklaw.bridge.getAgent, {
      agentName: AGENT_NAME_BY_SLUG[selectedAgentSlugs[0]],
    });
    const projectRoot = await resolveProjectRoot(currentAgent?.workspacePath ?? null);

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
      await stopAllAgentProcesses(projectRoot);
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
        await resetAgentSession(slug, args.profile, projectRoot);
        await ctx.runMutation(api.rocklaw.init.setAgentBlankProfile, {
          agentName: AGENT_NAME_BY_SLUG[slug],
          blankSelf: args.profile === 'blank-self',
        });
      }

      await ctx.runMutation(api.rocklaw.init.setWorkspaceRoot, { rootPath: projectRoot });
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
        await startAgentGateway(slug, projectRoot);
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
      const summary: any = await recordCurrentStepSummaryInternal(ctx);
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
        await recordCurrentStepSummaryInternal(ctx);
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
