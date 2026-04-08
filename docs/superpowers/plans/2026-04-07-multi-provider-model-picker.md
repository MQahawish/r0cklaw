# Multi-Provider Model Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Extend the agents tab to fetch and display live model lists from OpenRouter (all models + pricing), OpenAI, and Google; keep Anthropic as a static list; add a test button that sends a tiny completion to verify the model works.

**Architecture:** Two new Convex actions (`listProviderModels`, `testModel`) in `godNode.ts` handle all provider API calls server-side using env keys. The UI in `AgentConfigPanel.tsx` fires fetches for all providers in parallel on panel mount and caches results in state, so switching providers is instant. The existing `listOpenRouterRecommendedModels` and `RunConsolePanel` boot flow are untouched.

**Tech Stack:** Convex actions (Node.js runtime, `"use node"`), React hooks, provider REST APIs (OpenRouter, OpenAI, Google Gemini, Anthropic).

---

## File Map

| File | Change |
|------|--------|
| `convex/rocklaw/godNode.ts` | Add `listProviderModels` action + helper functions per provider; add `testModel` action |
| `src/components/AgentConfigPanel.tsx` | Replace static model arrays with live-fetched state; add pricing display; add test button + result |

---

## Task 1: Add `listProviderModels` Convex action

**Files:**
- Modify: `convex/rocklaw/godNode.ts` (insert after line 296, after `listOpenRouterRecommendedModels`)

- [x] **Step 1: Add type + static Anthropic list + helper functions**

Insert the following block into `godNode.ts` directly after the closing `});` of `listOpenRouterRecommendedModels` (after line 296):

```typescript
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
  if (!response.ok) throw new Error(`OpenRouter fetch failed: ${response.status}`);
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
  if (!response.ok) throw new Error(`OpenAI fetch failed: ${response.status}`);
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
    .sort((a, b) => b.id.localeCompare(a.id)); // newest first
}

async function fetchGoogleModels(): Promise<ProviderModel[]> {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) return GOOGLE_FALLBACK_MODELS;
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
  );
  if (!response.ok) throw new Error(`Google fetch failed: ${response.status}`);
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
```

- [x] **Step 2: Add the `listProviderModels` exported action**

Directly after the helper functions block from Step 1, add:

```typescript
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
```

- [x] **Step 3: Verify Convex regenerates types**

Run in a terminal where `npx convex dev` is running (or trigger a build):
```bash
npx convex dev --once 2>&1 | tail -20
```
Expected: No TypeScript errors. The `api.rocklaw.godNode.listProviderModels` symbol will now be available.

- [x] **Step 4: Commit**

```bash
git add convex/rocklaw/godNode.ts
git commit -m "feat: add listProviderModels action (openrouter/openai/google/anthropic)"
```

---

## Task 2: Add `testModel` Convex action

**Files:**
- Modify: `convex/rocklaw/godNode.ts` (insert after `listProviderModels`)

- [x] **Step 1: Add the `callModelTest` helper + `testModel` action**

Append directly after the `listProviderModels` export:

```typescript
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
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
```

- [x] **Step 2: Verify Convex builds cleanly**

```bash
npx convex dev --once 2>&1 | tail -20
```
Expected: No errors. `api.rocklaw.godNode.testModel` available.

- [x] **Step 3: Commit**

```bash
git add convex/rocklaw/godNode.ts
git commit -m "feat: add testModel action for live provider verification"
```

---

## Task 3: Update AgentConfigPanel — live model fetching

**Files:**
- Modify: `src/components/AgentConfigPanel.tsx`

This task replaces the static `MODEL_OPTIONS_BY_PROVIDER` map with live-fetched state and wires up `listProviderModels`.

- [x] **Step 1: Add `listProviderModels` and `testModel` useAction hooks inside `AgentDetail`**

In `AgentDetail` (around line 188–191 where the other `useAction` calls are), add two more:

```typescript
const listProviderModels = useAction(api.rocklaw.godNode.listProviderModels);
const testModel = useAction(api.rocklaw.godNode.testModel);
```

- [x] **Step 2: Add state for all-provider model cache and test result**

Add these state declarations inside `AgentDetail` after the existing `useState` declarations (after `openRouterOptions` state around line 198):

```typescript
type ProviderModel = { id: string; name: string; contextLength: number; pricing?: { prompt: string; completion: string } };

const [allProviderModels, setAllProviderModels] = useState<Record<string, ProviderModel[]>>({});
const [testResult, setTestResult] = useState<{ ok: boolean; reply?: string; latencyMs: number; error?: string } | null>(null);
const [testing, setTesting] = useState(false);
```

- [x] **Step 3: Replace the `openRouterOptions` fetch useEffect with a parallel all-provider fetch**

Remove the existing `useEffect` that calls `listOpenRouterRecommendedModels` (lines ~220–240). Replace it with:

```typescript
useEffect(() => {
  let cancelled = false;
  const providers = ['openrouter', 'openai', 'google', 'anthropic'];
  void Promise.all(
    providers.map((p) =>
      listProviderModels({ provider: p })
        .then((res) => ({ provider: p, models: res.models }))
        .catch(() => ({ provider: p, models: [] as ProviderModel[] })),
    ),
  ).then((results) => {
    if (cancelled) return;
    const map: Record<string, ProviderModel[]> = {};
    for (const { provider, models } of results) {
      map[provider] = models;
    }
    setAllProviderModels(map);
    // Back-compat: keep openRouterOptions for the useMemo below
    setOpenRouterOptions(
      (map.openrouter ?? []).map((m) => ({
        value: m.id,
        label: formatModelLabel(m),
      })),
    );
  });
  return () => { cancelled = true; };
}, [listProviderModels]);
```

- [x] **Step 4: Add `formatModelLabel` helper at module level**

Add this before the `AgentDetail` component (near the top of the file, after the `MODEL_OPTIONS_BY_PROVIDER` constant):

```typescript
function formatPricing(pricing: { prompt: string; completion: string }): string {
  const pIn = parseFloat(pricing.prompt);
  const pOut = parseFloat(pricing.completion);
  if (pIn === 0 && pOut === 0) return 'free';
  const fmt = (n: number) => n === 0 ? '$0' : `$${(n * 1_000_000).toFixed(2)}/M`;
  return `${fmt(pIn)} in · ${fmt(pOut)} out`;
}

function formatModelLabel(m: { id: string; name: string; contextLength: number; pricing?: { prompt: string; completion: string } }): string {
  const ctx = m.contextLength > 0 ? ` (${(m.contextLength / 1000).toFixed(0)}k ctx)` : '';
  const price = m.pricing ? ` · ${formatPricing(m.pricing)}` : '';
  return `${m.name}${ctx}${price}`;
}
```

- [x] **Step 5: Update `modelOptions` useMemo to use `allProviderModels`**

Replace the existing `modelOptions` useMemo (lines ~200–206) with:

```typescript
const modelOptions = useMemo(() => {
  const fetched = allProviderModels[providerInput] ?? [];
  if (fetched.length > 0) {
    return [
      ...fetched.map((m) => ({ value: m.id, label: formatModelLabel(m) })),
      { value: 'custom', label: 'Custom model id' },
    ];
  }
  // Fallback to static list while loading
  return MODEL_OPTIONS_BY_PROVIDER[providerInput] ?? MODEL_OPTIONS_BY_PROVIDER.custom;
}, [allProviderModels, providerInput]);
```

- [x] **Step 6: Remove `openRouterOptions` from the dependency in the detail sync useEffect**

The `useEffect` that syncs provider/model from `detail` (lines ~242–269) references `openRouterOptions`. It can now use `allProviderModels` for the openrouter case. Update just the options lookup inside that effect:

```typescript
const currentOptions =
  nextProvider === 'openrouter' && (allProviderModels.openrouter?.length ?? 0) > 0
    ? [
        ...(allProviderModels.openrouter ?? []).map((m: ProviderModel) => ({ value: m.id, label: formatModelLabel(m) })),
        { value: 'custom', label: 'Custom model id' },
      ]
    : MODEL_OPTIONS_BY_PROVIDER[nextProvider] ?? MODEL_OPTIONS_BY_PROVIDER.custom;
```

And add `allProviderModels` to that effect's dependency array.

- [x] **Step 7: Commit checkpoint**

```bash
git add src/components/AgentConfigPanel.tsx
git commit -m "feat: fetch live model lists for all providers in agents tab"
```

---

## Task 4: Add test button to AgentConfigPanel

**Files:**
- Modify: `src/components/AgentConfigPanel.tsx`

- [x] **Step 1: Reset test result when model or provider changes**

In the `onChange` handler of the provider `<select>` (around line 340), add `setTestResult(null)` alongside `setModelChoice('')`. In the `onChange` of the model `<select>`, also add `setTestResult(null)`:

```typescript
// Provider select onChange:
onChange={(e) => {
  setProviderInput(e.target.value);
  setModelChoice('');
  setCustomModelInput('');
  setTestResult(null);
}}

// Model select onChange:
onChange={(e) => {
  setModelChoice(e.target.value);
  setTestResult(null);
}}
```

- [x] **Step 2: Add `handleTest` function inside `AgentDetail`**

Add this next to `handleSaveModel`:

```typescript
const handleTest = async () => {
  if (!resolvedModel || !resolvedProvider) return;
  setTesting(true);
  setTestResult(null);
  try {
    const result = await testModel({ provider: resolvedProvider, modelId: resolvedModel });
    setTestResult(result);
  } finally {
    setTesting(false);
  }
};
```

- [x] **Step 3: Add Test button next to Save button in the JSX**

The current button row (around line 360–370) has `[provider select] [model select] [Save button]`. Add a Test button after Save:

```tsx
<button
  onClick={handleTest}
  disabled={!resolvedModel || testing}
  style={{
    fontSize: 11, padding: '4px 10px', borderRadius: 4,
    cursor: resolvedModel && !testing ? 'pointer' : 'default',
    background: resolvedModel && !testing ? '#065f46' : '#1f2937',
    color: resolvedModel && !testing ? '#6ee7b7' : '#4b5563',
    border: 'none', flexShrink: 0,
  }}
>
  {testing ? '...' : 'Test'}
</button>
```

Update the grid template to fit the extra button — change `gridTemplateColumns: '130px minmax(0, 1fr) auto'` to `gridTemplateColumns: '130px minmax(0, 1fr) auto auto'`.

- [x] **Step 4: Add test result display below the button row**

After the button row `<div>` (the one with gridTemplateColumns) and before the custom provider/model inputs, add:

```tsx
{testResult && (
  <div style={{
    fontSize: 11,
    padding: '4px 8px',
    borderRadius: 4,
    background: testResult.ok ? '#052e1622' : '#2d0a0a',
    border: `1px solid ${testResult.ok ? '#065f46' : '#7f1d1d'}`,
    color: testResult.ok ? '#6ee7b7' : '#fca5a5',
    fontFamily: 'ui-monospace, monospace',
  }}>
    {testResult.ok
      ? `✓ "${testResult.reply}" · ${testResult.latencyMs}ms`
      : `✗ ${testResult.error} · ${testResult.latencyMs}ms`}
  </div>
)}
```

- [x] **Step 5: Remove now-unused `openRouterOptions` state and `listOpenRouterRecommendedModels` action**

`openRouterOptions` is no longer needed as primary state — the `allProviderModels` map covers it. Remove:
- `const listOpenRouterRecommendedModels = useAction(...)` line
- `const [openRouterOptions, setOpenRouterOptions] = useState<...>` line

Then verify `openRouterOptions` is not referenced anywhere else in the component (the back-compat `setOpenRouterOptions` call in Task 3 Step 3 can be removed too since `modelOptions` now reads from `allProviderModels` directly). Clean up accordingly.

- [x] **Step 6: Final compile check**

```bash
npx tsc --noEmit 2>&1 | head -40
```
Expected: No errors (or only pre-existing unrelated errors).

- [x] **Step 7: Commit**

```bash
git add src/components/AgentConfigPanel.tsx
git commit -m "feat: add test button to agents tab for live model verification"
```

---

## Task 5: Update static Anthropic list in `MODEL_OPTIONS_BY_PROVIDER`

**Files:**
- Modify: `src/components/AgentConfigPanel.tsx:38–42`

- [x] **Step 1: Replace the hardcoded anthropic entries**

Find this block (around line 38–42):
```typescript
  anthropic: [
    { value: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet' },
    { value: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet' },
    { value: 'custom', label: 'Custom model id' },
  ],
```

Replace with:
```typescript
  anthropic: [
    { value: 'claude-opus-4-6',   label: 'Claude Opus 4.6'   },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { value: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5'  },
    { value: 'custom', label: 'Custom model id' },
  ],
```

This static list is the fallback shown before `allProviderModels` loads and matches the `ANTHROPIC_MODELS` array in `godNode.ts`.

- [x] **Step 2: Commit**

```bash
git add src/components/AgentConfigPanel.tsx
git commit -m "fix: update Anthropic static model list to current aliases"
```

---

## Manual Verification Checklist

After all tasks are done, open the app and confirm:

- [x] Agents tab → select any agent → provider dropdown shows OpenRouter, OpenAI, Anthropic, Google
- [x] Switching to **OpenRouter**: model dropdown loads live models with pricing labels (e.g. `Qwen 3 235B (57k ctx) · free`, `Claude 3 Opus (200k ctx) · $15.00/M in · $75.00/M out`), free models appear first
- [x] Switching to **OpenAI**: model dropdown loads live GPT/o-series models (requires `OPENAI_API_KEY` in env, else shows fallback static list)
- [x] Switching to **Google**: model dropdown loads live Gemini models (requires `GEMINI_API_KEY`, else fallback)
- [x] Switching to **Anthropic**: model dropdown shows the 3 static aliases immediately
- [x] Selecting a model + clicking **Test**: spinner shows, then result displays inline (green for success, red for error)
- [x] Test result clears when provider or model changes
- [x] Existing RunConsolePanel sim boot still uses free OpenRouter models as before (untouched)
