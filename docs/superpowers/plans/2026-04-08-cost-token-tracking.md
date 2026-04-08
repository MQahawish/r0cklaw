# Cost & Token Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track real token usage and cost per agent, display live stats in the Agents tab, Run tab, and Overview tab.

**Architecture:** ZeroClaw writes per-call token counts to `agents/{slug}/workspace/state/costs.jsonl` when `[cost] enabled = true`. After each agent tick, a Convex action reads new lines using a stored byte offset, computes cost (OR pricing from model list, ZeroClaw's `cost_usd` for other providers), and patches per-agent running totals in Convex. The UI reads these totals reactively.

**Tech Stack:** Convex (mutations, actions, queries, schema), TypeScript, React, ZeroClaw TOML config

---

## File Map

| File | Change |
|---|---|
| `agents/elena/config.toml` | Add `[cost] enabled = true` |
| `agents/finn/config.toml` | Add `[cost] enabled = true` |
| `agents/lena/config.toml` | Add `[cost] enabled = true` |
| `agents/marcus/config.toml` | Add `[cost] enabled = true` |
| `agents/sera/config.toml` | Add `[cost] enabled = true` |
| `convex/rocklaw/schema.ts` | Add 6 optional fields to `rl_agents`, 1 to `rl_run_console_state` |
| `convex/rocklaw/god.ts` | Add `_patchAgentCosts` mutation, `_clearAgentCosts` mutation, update `getRunConsole` to return `sessionCostUsd`, update `_patchAgentModel` to accept pricing fields |
| `convex/rocklaw/godNode.ts` | Add `readAgentCostsDelta` internal action, `clearCostStats` exported action, update `setAgentModel` to accept/store pricing |
| `convex/rocklaw/bridgeNode.ts` | Call `readAgentCostsDelta` at end of `tickAgent` |
| `src/components/AgentConfigPanel.tsx` | Pass pricing on save/apply-all, add cost stats line + "Clear stats" button |
| `src/components/RunConsolePanel.tsx` | Add session cost ticker in header |
| `src/components/GodDashboard.tsx` | Add cost row in `AgentCard` |

---

### Task 1: Enable ZeroClaw cost tracking in all agent configs

**Files:**
- Modify: `agents/elena/config.toml`
- Modify: `agents/finn/config.toml`
- Modify: `agents/lena/config.toml`
- Modify: `agents/marcus/config.toml`
- Modify: `agents/sera/config.toml`

- [ ] **Step 1: Update all five agent config.toml files**

Each file currently has `[cost]\nenabled = false`. Change to `enabled = true` in all five.

`agents/elena/config.toml` — change:
```toml
[cost]
enabled = true
```

`agents/finn/config.toml` — change:
```toml
[cost]
enabled = true
```

`agents/lena/config.toml` — change:
```toml
[cost]
enabled = true
```

`agents/marcus/config.toml` — change:
```toml
[cost]
enabled = true
```

`agents/sera/config.toml` — change:
```toml
[cost]
enabled = true
```

- [ ] **Step 2: Verify**

Run: `grep -A1 '\[cost\]' agents/*/config.toml`

Expected output:
```
agents/elena/config.toml-enabled = true
agents/finn/config.toml-enabled = true
agents/lena/config.toml-enabled = true
agents/marcus/config.toml-enabled = true
agents/sera/config.toml-enabled = true
```

- [ ] **Step 3: Commit**

```bash
git add agents/elena/config.toml agents/finn/config.toml agents/lena/config.toml agents/marcus/config.toml agents/sera/config.toml
git commit -m "feat: enable zeroclaw cost tracking in all agent configs"
```

---

### Task 2: Schema — add cost fields

**Files:**
- Modify: `convex/rocklaw/schema.ts`

ZeroClaw writes `costs.jsonl` records with `input_tokens`, `output_tokens`, `cost_usd`. We store running totals on each agent plus a session total on `rl_run_console_state`.

- [ ] **Step 1: Add fields to `rl_agents` in schema.ts**

In `convex/rocklaw/schema.ts`, inside the `rl_agents` `defineTable({...})` call, add these optional fields after the existing `openrouterFreeFallbackProvider` field:

```typescript
    // Cost & token tracking (cumulative, cleared by user via clearCostStats)
    lifetimeCostUsd: v.optional(v.number()),
    lifetimeInputTokens: v.optional(v.number()),
    lifetimeOutputTokens: v.optional(v.number()),
    costsFileOffset: v.optional(v.number()),
    // Pricing for the currently-configured OpenRouter model (USD per token, not per million)
    currentModelPromptPrice: v.optional(v.number()),
    currentModelCompletionPrice: v.optional(v.number()),
```

- [ ] **Step 2: Add `sessionCostUsd` to `rl_run_console_state`**

In the same file, inside `rl_run_console_state` `defineTable({...})`, add after `updatedAt`:

```typescript
    sessionCostUsd: v.optional(v.number()),
```

- [ ] **Step 3: Verify schema compiles**

Run: `npx convex dev --once 2>&1 | head -20`

Expected: no schema validation errors (may show function push output).

- [ ] **Step 4: Commit**

```bash
git add convex/rocklaw/schema.ts
git commit -m "feat: add cost and token tracking fields to schema"
```

---

### Task 3: `_patchAgentCosts` and `_clearAgentCosts` mutations in god.ts

**Files:**
- Modify: `convex/rocklaw/god.ts`

- [ ] **Step 1: Add `_patchAgentCosts` internal mutation to god.ts**

Add after `_clearRunTickSummaries` (around line 340):

```typescript
export const _patchAgentCosts = internalMutation({
  args: {
    agentName: v.string(),
    deltaCostUsd: v.number(),
    deltaInputTokens: v.number(),
    deltaOutputTokens: v.number(),
    newOffset: v.number(),
  },
  handler: async (ctx, { agentName, deltaCostUsd, deltaInputTokens, deltaOutputTokens, newOffset }) => {
    const agent = await ctx.db
      .query('rl_agents')
      .withIndex('name', (q) => q.eq('name', agentName))
      .unique();
    if (!agent) return;
    await ctx.db.patch(agent._id, {
      lifetimeCostUsd: (agent.lifetimeCostUsd ?? 0) + deltaCostUsd,
      lifetimeInputTokens: (agent.lifetimeInputTokens ?? 0) + deltaInputTokens,
      lifetimeOutputTokens: (agent.lifetimeOutputTokens ?? 0) + deltaOutputTokens,
      costsFileOffset: newOffset,
    });
    if (deltaCostUsd > 0) {
      const runState = await ctx.db
        .query('rl_run_console_state')
        .withIndex('singletonKey', (q) => q.eq('singletonKey', RUN_CONSOLE_SINGLETON))
        .unique();
      if (runState) {
        await ctx.db.patch(runState._id, {
          sessionCostUsd: (runState.sessionCostUsd ?? 0) + deltaCostUsd,
        });
      }
    }
  },
});
```

- [ ] **Step 2: Add `_clearAgentCosts` internal mutation to god.ts**

Add directly after `_patchAgentCosts`:

```typescript
export const _clearAgentCosts = internalMutation({
  args: {
    agentUpdates: v.array(v.object({
      agentName: v.string(),
      costsFileOffset: v.number(),
    })),
  },
  handler: async (ctx, { agentUpdates }) => {
    for (const { agentName, costsFileOffset } of agentUpdates) {
      const agent = await ctx.db
        .query('rl_agents')
        .withIndex('name', (q) => q.eq('name', agentName))
        .unique();
      if (!agent) continue;
      await ctx.db.patch(agent._id, {
        lifetimeCostUsd: 0,
        lifetimeInputTokens: 0,
        lifetimeOutputTokens: 0,
        costsFileOffset,
      });
    }
    const runState = await ctx.db
      .query('rl_run_console_state')
      .withIndex('singletonKey', (q) => q.eq('singletonKey', RUN_CONSOLE_SINGLETON))
      .unique();
    if (runState) {
      await ctx.db.patch(runState._id, { sessionCostUsd: 0 });
    }
  },
});
```

- [ ] **Step 3: Update `_patchAgentModel` to accept and store pricing fields**

Find `_patchAgentModel` (around line 619). Replace it with:

```typescript
export const _patchAgentModel = internalMutation({
  args: {
    agentName: v.string(),
    modelOverride: v.string(),
    providerOverride: v.optional(v.string()),
    currentModelPromptPrice: v.optional(v.number()),
    currentModelCompletionPrice: v.optional(v.number()),
  },
  handler: async (ctx, { agentName, modelOverride, providerOverride, currentModelPromptPrice, currentModelCompletionPrice }) => {
    const agent = await ctx.db
      .query('rl_agents')
      .withIndex('name', (q) => q.eq('name', agentName))
      .unique();
    if (agent) {
      await ctx.db.patch(agent._id, {
        modelOverride,
        providerOverride,
        currentModelPromptPrice,
        currentModelCompletionPrice,
      });
    }
  },
});
```

- [ ] **Step 4: Update `getRunConsole` query to return `sessionCostUsd`**

Find the `getRunConsole` query (around line 133). In the returned `state` object (inside the `stateDoc ? { ... } : defaults` block), add `sessionCostUsd` at the end:

```typescript
        sessionCostUsd: stateDoc.sessionCostUsd ?? 0,
```

Also add `sessionCostUsd: 0` to `defaultRunConsoleState()` (the defaults fallback).

In `defaultRunConsoleState()` function, after `lastError: undefined as string | undefined,` add:
```typescript
    sessionCostUsd: 0,
```

- [ ] **Step 5: Verify**

Run: `npx convex dev --once 2>&1 | head -30`

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add convex/rocklaw/god.ts
git commit -m "feat: add _patchAgentCosts, _clearAgentCosts mutations and pricing to _patchAgentModel"
```

---

### Task 4: `readAgentCostsDelta` and `clearCostStats` actions in godNode.ts

**Files:**
- Modify: `convex/rocklaw/godNode.ts`

`readAgentCostsDelta` reads new lines from `agents/{slug}/workspace/state/costs.jsonl` using the stored byte offset. For OpenRouter models it computes cost from the agent's stored pricing. For other providers it uses ZeroClaw's `cost_usd` directly.

`clearCostStats` reads current file sizes and zeroes all lifetime counters, setting offsets to current file size so old records aren't re-read.

- [ ] **Step 1: Add `readAgentCostsDelta` internal action at the end of godNode.ts (before `testModel`)**

Add this action (it must go in godNode.ts since it needs `"use node"` for filesystem access):

```typescript
export const readAgentCostsDelta = internalAction({
  args: { agentName: v.string() },
  handler: async (ctx, { agentName }): Promise<void> => {
    const agent = await ctx.runQuery(internal.rocklaw.bridge.getAgent, { agentName });
    if (!agent) return;

    const fs = await import('fs/promises');
    const path = await import('path');

    const costsPath = path.resolve(process.cwd(), agent.workspacePath, 'state', 'costs.jsonl');
    const currentOffset = agent.costsFileOffset ?? 0;

    let fileSize: number;
    try {
      const stat = await fs.stat(costsPath);
      fileSize = stat.size;
    } catch {
      // File doesn't exist yet — nothing to read
      return;
    }

    if (fileSize <= currentOffset) return;

    let newBytes: Buffer;
    try {
      const fd = await fs.open(costsPath, 'r');
      try {
        const readSize = fileSize - currentOffset;
        const buf = Buffer.alloc(readSize);
        await fd.read(buf, 0, readSize, currentOffset);
        newBytes = buf;
      } finally {
        await fd.close();
      }
    } catch {
      return;
    }

    const lines = newBytes.toString('utf8').split('\n').filter((l) => l.trim().length > 0);
    let deltaInputTokens = 0;
    let deltaOutputTokens = 0;
    let deltaCostUsd = 0;

    const promptPrice = agent.currentModelPromptPrice ?? null;
    const completionPrice = agent.currentModelCompletionPrice ?? null;

    for (const line of lines) {
      let record: any;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const usage = record?.usage;
      if (!usage) continue;

      const inputTokens = Number(usage.input_tokens ?? 0);
      const outputTokens = Number(usage.output_tokens ?? 0);
      deltaInputTokens += inputTokens;
      deltaOutputTokens += outputTokens;

      // Use OR-derived pricing if available, otherwise trust ZeroClaw's cost_usd
      if (promptPrice !== null && completionPrice !== null) {
        deltaCostUsd += inputTokens * promptPrice + outputTokens * completionPrice;
      } else {
        deltaCostUsd += Number(usage.cost_usd ?? 0);
      }
    }

    if (deltaInputTokens === 0 && deltaOutputTokens === 0) return;

    await ctx.runMutation(internal.rocklaw.god._patchAgentCosts, {
      agentName,
      deltaCostUsd,
      deltaInputTokens,
      deltaOutputTokens,
      newOffset: fileSize,
    });
  },
});
```

- [ ] **Step 2: Add `clearCostStats` exported action at end of godNode.ts**

```typescript
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
      const costsPath = path.resolve(process.cwd(), agent.workspacePath, 'state', 'costs.jsonl');
      let fileSize = 0;
      try {
        const stat = await fs.stat(costsPath);
        fileSize = stat.size;
      } catch {
        // File doesn't exist — offset 0 is fine
      }
      agentUpdates.push({ agentName, costsFileOffset: fileSize });
    }

    await ctx.runMutation(internal.rocklaw.god._clearAgentCosts, { agentUpdates });
  },
});
```

- [ ] **Step 3: Update `setAgentModel` to accept and store pricing**

Find `setAgentModel` (currently around line 268). Replace it with:

```typescript
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
```

- [ ] **Step 4: Update `applyAgentModelSwitch` to forward pricing to `_patchAgentModel`**

Find `applyAgentModelSwitch` (around line 41). Add pricing params to its signature and pass them through:

```typescript
async function applyAgentModelSwitch(
  ctx: any,
  agentName: string,
  modelOverride: string,
  providerOverride?: string,
  promptPriceUsd?: number,
  completionPriceUsd?: number,
) {
  await ctx.runMutation(internal.rocklaw.god._patchAgentModel, {
    agentName,
    modelOverride,
    providerOverride,
    currentModelPromptPrice: promptPriceUsd,
    currentModelCompletionPrice: completionPriceUsd,
  });
  // ... rest of existing function unchanged ...
```

- [ ] **Step 5: Verify**

Run: `npx convex dev --once 2>&1 | head -30`

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add convex/rocklaw/godNode.ts
git commit -m "feat: add readAgentCostsDelta and clearCostStats actions"
```

---

### Task 5: Wire `readAgentCostsDelta` into `tickAgent`

**Files:**
- Modify: `convex/rocklaw/bridgeNode.ts`

Call `readAgentCostsDelta` at the very end of `tickAgent`, after all processing. Wrapped in try/catch so cost tracking failure never kills a tick.

- [ ] **Step 1: Add the call at end of `tickAgent`**

`tickAgent` ends (around line 530–541) with scheduling the next tick:

```typescript
    if (!_manual) {
      await ctx.scheduler.runAfter(nextMs, internal.rocklaw.bridgeNode.tickAgent, { agentName });
    }
  },
});
```

Insert before `if (!_manual)`:

```typescript
    // Non-fatal cost tracking — runs after every tick that got a ZeroClaw response
    try {
      await ctx.runAction(internal.rocklaw.godNode.readAgentCostsDelta, { agentName });
    } catch (costErr) {
      console.warn(`[bridge] Cost tracking failed for ${agentName}:`, costErr);
    }
```

- [ ] **Step 2: Verify the tickAgent function still compiles**

Run: `npx convex dev --once 2>&1 | head -30`

Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add convex/rocklaw/bridgeNode.ts
git commit -m "feat: call readAgentCostsDelta after each agent tick"
```

---

### Task 6: AgentConfigPanel — cost stats line + Clear stats button

**Files:**
- Modify: `src/components/AgentConfigPanel.tsx`

Three changes:
1. Pass pricing from the selected model to `setAgentModel` on save and apply-all
2. Add a cost stats line below the model selector
3. Add "Clear stats" button in the `AgentDetail` header

- [ ] **Step 1: Add `clearCostStats` import and two formatting helpers**

At the top of the file, in the imports, `useAction` is already imported. The `api` import already covers `clearCostStats` once it's added. Add two helper functions near the top of the file (after the existing `formatPricing` and `formatModelLabel` functions):

```typescript
function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCostUsd(usd: number): string {
  if (usd === 0) return '$0.000';
  if (usd < 0.001) return `$${usd.toFixed(5)}`;
  return `$${usd.toFixed(3)}`;
}
```

- [ ] **Step 2: Add `clearCostStats` action hook and pricing lookup in `AgentDetail`**

In `AgentDetail`, after the existing `testModel` useAction line, add:

```typescript
  const clearCostStats = useAction(api.rocklaw.godNode.clearCostStats);
  const [clearingStats, setClearingStats] = useState(false);
```

- [ ] **Step 3: Update `handleSaveModel` to pass pricing**

Replace the existing `handleSaveModel` function with:

```typescript
  const handleSaveModel = async () => {
    if (!resolvedModel) return;
    setSaving(true);
    try {
      const orModels = allProviderModels.openrouter ?? [];
      const orModel = orModels.find((m: ProviderModel) => m.id === resolvedModel);
      const promptPriceUsd = resolvedProvider === 'openrouter' && orModel?.pricing
        ? parseFloat(orModel.pricing.prompt)
        : undefined;
      const completionPriceUsd = resolvedProvider === 'openrouter' && orModel?.pricing
        ? parseFloat(orModel.pricing.completion)
        : undefined;
      await setAgentModel({
        agentName,
        modelOverride: resolvedModel,
        providerOverride: resolvedProvider || undefined,
        promptPriceUsd,
        completionPriceUsd,
      });
      const openRouterOptions = (allProviderModels.openrouter?.length ?? 0) > 0
        ? allProviderModels.openrouter.map((m: ProviderModel) => ({ value: m.id, label: formatModelLabel(m) }))
        : MODEL_OPTIONS_BY_PROVIDER.openrouter;
      setModelChoice(openRouterOptions[0]?.value ?? '');
      setCustomModelInput('');
      setProviderInput('openrouter');
    } finally {
      setSaving(false);
    }
  };
```

- [ ] **Step 4: Update `handleApplyAll` to pass pricing**

Replace the existing `handleApplyAll` with:

```typescript
  const handleApplyAll = async () => {
    if (!resolvedModel) return;
    setApplyingAll(true);
    try {
      const orModels = allProviderModels.openrouter ?? [];
      const orModel = orModels.find((m: ProviderModel) => m.id === resolvedModel);
      const promptPriceUsd = resolvedProvider === 'openrouter' && orModel?.pricing
        ? parseFloat(orModel.pricing.prompt)
        : undefined;
      const completionPriceUsd = resolvedProvider === 'openrouter' && orModel?.pricing
        ? parseFloat(orModel.pricing.completion)
        : undefined;
      for (const name of allAgentNames) {
        await setAgentModel({
          agentName: name,
          modelOverride: resolvedModel,
          providerOverride: resolvedProvider || undefined,
          promptPriceUsd,
          completionPriceUsd,
        });
      }
    } finally {
      setApplyingAll(false);
    }
  };
```

- [ ] **Step 5: Add "Clear stats" button to the AgentDetail header**

Find the header block in `AgentDetail` (around line 386–392):

```tsx
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <span style={{ fontSize: 15, fontWeight: 700, color: '#f9fafb' }}>{agent.name}</span>
          <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 8 }}>{agent.role}</span>
        </div>
      </div>
```

Replace with:

```tsx
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <span style={{ fontSize: 15, fontWeight: 700, color: '#f9fafb' }}>{agent.name}</span>
          <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 8 }}>{agent.role}</span>
        </div>
        {((agent.lifetimeCostUsd ?? 0) > 0 || (agent.lifetimeInputTokens ?? 0) > 0) && (
          <button
            onClick={async () => {
              setClearingStats(true);
              try { await clearCostStats({}); } finally { setClearingStats(false); }
            }}
            disabled={clearingStats}
            style={{
              fontSize: 11, padding: '3px 8px', borderRadius: 4, cursor: clearingStats ? 'default' : 'pointer',
              background: '#1f2937', color: '#6b7280', border: '1px solid #374151',
            }}
          >
            {clearingStats ? '...' : 'Clear stats'}
          </button>
        )}
      </div>
```

- [ ] **Step 6: Add cost stats line below the model selector**

Find the closing `</div>` of the "ZeroClaw Config" section (after the hint text `Pick a provider first...`). The section ends around:

```tsx
          <div style={{ fontSize: 11, color: '#6b7280' }}>
            Pick a provider first, then pick one of its models. Use custom only when the model is not listed.
          </div>
        </div>
      </div>
```

Add the cost stats line AFTER this closing `</div></div>` block (as a sibling section, before `{/* Reputation */}`):

```tsx
      {/* Cost & Token Stats */}
      {((agent.lifetimeInputTokens ?? 0) > 0 || (agent.lifetimeOutputTokens ?? 0) > 0) && (
        <div style={{ background: '#1f2937', borderRadius: 5, padding: '8px 10px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 6 }}>
            Usage (lifetime)
          </div>
          <div style={{ fontSize: 12, color: '#9ca3af', fontFamily: 'ui-monospace, monospace' }}>
            {'↑ '}
            <span style={{ color: '#e5e7eb' }}>{formatTokenCount(agent.lifetimeInputTokens ?? 0)}</span>
            {' in · '}
            <span style={{ color: '#e5e7eb' }}>{formatTokenCount(agent.lifetimeOutputTokens ?? 0)}</span>
            {' out'}
            {(agent.lifetimeCostUsd ?? 0) > 0 && (
              <span style={{ color: '#fde68a', marginLeft: 8 }}>{formatCostUsd(agent.lifetimeCostUsd ?? 0)}</span>
            )}
          </div>
        </div>
      )}
```

- [ ] **Step 7: Verify the component renders without errors**

Run: `npm run dev` and open the Agents tab. Confirm no console errors. The cost stats section should be hidden until the sim runs and produces data.

- [ ] **Step 8: Commit**

```bash
git add src/components/AgentConfigPanel.tsx
git commit -m "feat: add cost stats line and clear stats button to Agents tab"
```

---

### Task 7: RunConsolePanel — session cost ticker

**Files:**
- Modify: `src/components/RunConsolePanel.tsx`

Add a one-line session cost summary in the run console. It appears whenever `sessionCostUsd > 0` or total tokens > 0.

- [ ] **Step 1: Add formatting helpers to RunConsolePanel.tsx**

Add near the top of `RunConsolePanel.tsx`, after the existing `trimInline` function:

```typescript
function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCostUsd(usd: number): string {
  if (usd === 0) return '$0.000';
  if (usd < 0.001) return `$${usd.toFixed(5)}`;
  return `$${usd.toFixed(3)}`;
}
```

- [ ] **Step 2: Add agents query and compute session token total**

`RunConsolePanel` currently queries `api.rocklaw.god.getRunConsole`. The `sessionCostUsd` field is now included in its return. We also need total tokens — fetch agents from `getDashboard` or add a lighter query.

The simplest path: add `useQuery(api.rocklaw.god.getDashboard)` to `RunConsolePanel` (it's already used in `GodDashboard`; adding it here too is fine since Convex deduplicates subscriptions).

In `RunConsolePanel` component, after the existing `const runConsole = useQuery(...)` line, add:

```typescript
  const dashboard = useQuery(api.rocklaw.god.getDashboard);
```

Then compute session totals in the component body (after the `useMemo` blocks):

```typescript
  const sessionCostUsd = runConsole?.state.sessionCostUsd ?? 0;
  const sessionTotalTokens = useMemo(() => {
    return (dashboard?.agents ?? []).reduce((sum: number, a: any) => {
      return sum + (a.lifetimeInputTokens ?? 0) + (a.lifetimeOutputTokens ?? 0);
    }, 0);
  }, [dashboard?.agents]);
```

- [ ] **Step 3: Add the cost ticker to the run console render**

In the `RunConsolePanel` return JSX, find the `<div style={{ display: 'grid', gap: 14 }}>` opening tag. Inside it, before the first `<div style={PANEL_STYLE}>` (the "New Run Setup" panel), add:

```tsx
      {(sessionCostUsd > 0 || sessionTotalTokens > 0) && (
        <div style={{
          background: '#0f1923',
          border: '1px solid #1e3a2e',
          borderRadius: 6,
          padding: '6px 12px',
          fontSize: 12,
          color: '#6b7280',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <span style={{ color: '#4b5563' }}>Session</span>
          {sessionTotalTokens > 0 && (
            <span style={{ color: '#9ca3af' }}>{formatTokenCount(sessionTotalTokens)} tokens</span>
          )}
          {sessionCostUsd > 0 && (
            <span style={{ color: '#fde68a', fontWeight: 600 }}>{formatCostUsd(sessionCostUsd)}</span>
          )}
        </div>
      )}
```

- [ ] **Step 4: Verify**

Run: `npm run dev` and open the Run tab. Confirm no console errors. The ticker is hidden until there's data.

- [ ] **Step 5: Commit**

```bash
git add src/components/RunConsolePanel.tsx
git commit -m "feat: add session cost ticker to Run tab"
```

---

### Task 8: GodDashboard — per-agent cost row in AgentCard

**Files:**
- Modify: `src/components/GodDashboard.tsx`

`getDashboard` already returns all `rl_agents` rows. The new `lifetimeCostUsd`, `lifetimeInputTokens`, `lifetimeOutputTokens` fields are automatically available on the `agent` object in `AgentCard`.

- [ ] **Step 1: Add formatting helpers to GodDashboard.tsx**

Add near the top of `GodDashboard.tsx`, after the existing `repColour` function:

```typescript
function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCostUsd(usd: number): string {
  if (usd === 0) return '$0.000';
  if (usd < 0.001) return `$${usd.toFixed(5)}`;
  return `$${usd.toFixed(3)}`;
}
```

- [ ] **Step 2: Add cost row to AgentCard**

In `AgentCard`, find the closing section that shows coin and busy status (around line 125–130):

```tsx
      <div style={{ marginTop: 4, fontSize: 11, color: '#9ca3af' }}>
        {agent.coin}c
        {agent.busy && agent.busyUntilTick && (
          <span style={{ marginLeft: 8, color: '#a78bfa' }}>busy until tick {agent.busyUntilTick}</span>
        )}
      </div>
```

Add a cost row AFTER this `</div>`:

```tsx
      {((agent.lifetimeInputTokens ?? 0) > 0 || (agent.lifetimeOutputTokens ?? 0) > 0) && (
        <div style={{ marginTop: 4, fontSize: 11, color: '#6b7280', fontFamily: 'ui-monospace, monospace' }}>
          {formatTokenCount(agent.lifetimeInputTokens ?? 0)} in
          {' / '}
          {formatTokenCount(agent.lifetimeOutputTokens ?? 0)} out
          {(agent.lifetimeCostUsd ?? 0) > 0 && (
            <span style={{ color: '#fde68a', marginLeft: 8 }}>{formatCostUsd(agent.lifetimeCostUsd ?? 0)}</span>
          )}
        </div>
      )}
```

- [ ] **Step 3: Verify**

Run: `npm run dev` and open the Overview tab. Confirm `AgentCard` renders correctly with no console errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/GodDashboard.tsx
git commit -m "feat: add per-agent cost row to Overview tab agent cards"
```

---

## Self-Review

### Spec coverage check

| Spec requirement | Task |
|---|---|
| Enable `[cost]` in agent configs | Task 1 |
| `lifetimeCostUsd`, `lifetimeInputTokens`, `lifetimeOutputTokens`, `costsFileOffset` on `rl_agents` | Task 2 |
| `sessionCostUsd` on `rl_run_console_state` | Task 2 |
| Store `currentModelPromptPrice` / `currentModelCompletionPrice` at model-switch time | Tasks 3 + 4 |
| `_patchAgentCosts` mutation | Task 3 |
| `_clearAgentCosts` mutation | Task 3 |
| `clearCostStats` exported action | Task 4 |
| `readAgentCostsDelta` internal action | Task 4 |
| Wire into `tickAgent` | Task 5 |
| OR pricing from model list used for cost computation | Task 4 (`readAgentCostsDelta`) |
| ZeroClaw `cost_usd` used for non-OR providers | Task 4 (`readAgentCostsDelta`) |
| Agents tab: cost stats line + Clear stats button | Task 6 |
| Run tab: session cost ticker | Task 7 |
| Overview tab: per-agent cost row | Task 8 |
| Cumulative across runs, clears on user request | Tasks 3 + 4 + 6 |

All requirements covered. ✓

### Placeholder scan

No TBDs or "implement later" text found. ✓

### Type consistency check

- `lifetimeCostUsd`, `lifetimeInputTokens`, `lifetimeOutputTokens`, `costsFileOffset`, `currentModelPromptPrice`, `currentModelCompletionPrice` — defined in Task 2 (schema), used in Tasks 3, 4, 6, 7, 8 consistently.
- `sessionCostUsd` — defined in Task 2, patched in Task 3, read in Tasks 3 and 7.
- `promptPriceUsd` / `completionPriceUsd` — added to `setAgentModel` args in Task 4, passed from UI in Task 6. ✓
- `_patchAgentCosts` / `_clearAgentCosts` — defined in Task 3, called from Tasks 4 and 4. ✓
- `formatTokenCount` / `formatCostUsd` — duplicated in 3 component files (intentional — no shared util for YAGNI). ✓
