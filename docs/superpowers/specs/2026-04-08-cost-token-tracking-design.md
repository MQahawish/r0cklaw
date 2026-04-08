# Cost & Token Tracking Implementation Design

> **For agentic workers:** This spec has a companion implementation plan. Use `superpowers:executing-plans` or `superpowers:subagent-driven-development` to implement it task-by-task.

**Goal:** Track real token usage and cost per agent across the Rocklaw simulation, display it in the Agents tab, Run tab, and Overview tab.

**Architecture:** ZeroClaw writes per-call token counts (extracted from real provider API responses) to `agents/{slug}/workspace/state/costs.jsonl` when cost tracking is enabled. After each agent tick, a Convex action reads new lines from that file using a stored byte offset, computes cost, and updates per-agent running totals in Convex. The UI reads these totals reactively.

**Tech Stack:** Convex (mutations, actions, queries), TypeScript, React, ZeroClaw config TOML

---

## Data Source

ZeroClaw's `[cost]` config section controls cost tracking. When `enabled = true`, after every LLM call (including tool loop iterations) ZeroClaw appends a JSONL record to `{workspace}/state/costs.jsonl`:

```json
{
  "id": "uuid",
  "session_id": "uuid",
  "usage": {
    "model": "qwen/qwen3.6-plus:free",
    "input_tokens": 1240,
    "output_tokens": 87,
    "total_tokens": 1327,
    "cost_usd": 0.0,
    "timestamp": "2026-04-08T12:00:00Z"
  }
}
```

Token counts are always real (from the provider API response). `cost_usd` is computed by ZeroClaw using its internal price map — may be 0 if the model is unknown to ZeroClaw.

**Currently:** All five agent `config.toml` files have `[cost] enabled = false`. This must be changed to `enabled = true`.

---

## Pricing Strategy

Two sources — no static maps maintained by Rocklaw:

- **OpenRouter:** The model listing API returns `pricing.prompt` and `pricing.completion` (USD per token, not per million). These are already fetched in `fetchAllOpenRouterModels`. Store them on the `ProviderModel` type as `promptPriceUsd` and `completionPriceUsd`. In `readAgentCostsDelta`, compute cost from token counts × OR prices.
- **OpenAI / Anthropic / Google:** Use ZeroClaw's `cost_usd` directly from `costs.jsonl`. If ZeroClaw's price map doesn't include the model, `cost_usd` is 0 — show 0, no fabrication.

---

## Schema Changes

### `rl_agents` — add fields (all optional, default to 0 on init):

```typescript
lifetimeCostUsd: v.optional(v.number()),       // cumulative USD across all runs
lifetimeInputTokens: v.optional(v.number()),   // cumulative input tokens
lifetimeOutputTokens: v.optional(v.number()),  // cumulative output tokens
costsFileOffset: v.optional(v.number()),       // byte offset into costs.jsonl
```

### `rl_run_console_state` — add field:

```typescript
sessionCostUsd: v.optional(v.number()),  // sum across all agents, cleared by user
```

No new tables. Lifetime fields accumulate across runs until the user explicitly clears them.

---

## Data Pipeline

### Step 1: Enable ZeroClaw cost tracking

In each of the five agent `config.toml` files (`agents/elena/config.toml`, `agents/finn/config.toml`, `agents/lena/config.toml`, `agents/marcus/config.toml`, `agents/sera/config.toml`):

```toml
[cost]
enabled = true
```

### Step 2: `readAgentCostsDelta` (new internal action in `godNode.ts`)

Called after every successful `tickAgent`. Reads new lines from `costs.jsonl` using the stored byte offset:

1. Read `agent.costsFileOffset` from Convex (default 0)
2. Open `agents/{slug}/workspace/state/costs.jsonl`
3. Seek to offset, read new bytes to end of file
4. Parse each new JSONL line as a cost record
5. For each record:
   - If provider is `openrouter`: look up model in the cached OR price list, compute `cost = (inputTokens / 1e6 * promptPrice) + (outputTokens / 1e6 * completionPrice)`
   - Otherwise: use `record.usage.cost_usd` directly
6. Sum up `deltaInputTokens`, `deltaOutputTokens`, `deltaCostUsd`
7. Call `_patchAgentCosts` mutation with deltas + new offset

### Step 3: `_patchAgentCosts` (new internal mutation in `god.ts`)

Atomically patches the agent row:
```
lifetimeCostUsd += deltaCostUsd
lifetimeInputTokens += deltaInputTokens
lifetimeOutputTokens += deltaOutputTokens
costsFileOffset = newOffset
```

Also patches `rl_run_console_state.sessionCostUsd += deltaCostUsd`.

### Step 4: Call site in `bridgeNode.tickAgent`

After the tick completes successfully (action applied), call:
```typescript
await ctx.runAction(internal.rocklaw.godNode.readAgentCostsDelta, { agentName });
```

This runs at the end of every `tickAgent` invocation — after the ZeroClaw turn completes (whether or not the resulting action was valid). On pure transport failure where ZeroClaw never connected, no cost record is written, so the read is a no-op.

### Step 5: `clearCostStats` (new exported mutation in `god.ts`)

Zeros out all cost fields:
- For each agent: `lifetimeCostUsd = 0`, `lifetimeInputTokens = 0`, `lifetimeOutputTokens = 0`, `costsFileOffset = currentFileSize` (reads the current file size via `fs.stat` and stores it, so the next read starts after all existing records — old costs are not re-counted)
- `rl_run_console_state.sessionCostUsd = 0`

---

## OpenRouter Pricing on `ProviderModel`

The existing `ProviderModel` type in `godNode.ts` and `AgentConfigPanel.tsx`:

```typescript
type ProviderModel = {
  id: string;
  name: string;
  contextLength: number;
  promptPriceUsd?: number;      // ADD: USD per token (not per million)
  completionPriceUsd?: number;  // ADD: USD per token (not per million)
};
```

In `fetchAllOpenRouterModels`, map the OR API's `pricing.prompt` and `pricing.completion` strings (they're string-encoded floats) onto these fields. Free models will have 0.

In `readAgentCostsDelta`, to compute OR cost:
```typescript
cost = inputTokens * promptPriceUsd + outputTokens * completionPriceUsd
```

The OR prices are stored in-process. Since `readAgentCostsDelta` is a Node action, it refetches OR model pricing if needed or uses the Convex-cached model data.

**Simpler approach:** Store the current model's pricing in the `rl_agents` row when `setAgentModel` is called. Fields: `currentModelPromptPrice: v.optional(v.number())`, `currentModelCompletionPrice: v.optional(v.number())`. Then `readAgentCostsDelta` can read them directly without a separate fetch.

This is the chosen approach — pricing is written to the agent row at model-switch time and used at cost-read time.

---

## UI

### Agents tab (`AgentConfigPanel.tsx`)

Below each agent's model selector, a stats line:

```
↑ 14.2k in · 0.8k out · $0.003
```

- Reads `lifetimeInputTokens`, `lifetimeOutputTokens`, `lifetimeCostUsd` from the agent query
- Token counts formatted: `1240` → `1.2k`, `1200000` → `1.2M`
- Cost formatted: `$0.000` minimum 3 decimal places; hide if both tokens and cost are 0
- "Clear stats" button at top of panel, visible only when any agent has `lifetimeCostUsd > 0` or `lifetimeInputTokens > 0`. Calls `clearCostStats`.

### Run tab (`RunConsolePanel.tsx`)

A single info line in the header area, visible whenever `sessionCostUsd > 0` or total tokens > 0:

```
Session: $0.021 · 1.2M tokens
```

- `sessionCostUsd` from `rl_run_console_state`
- total tokens = sum of `lifetimeInputTokens + lifetimeOutputTokens` across all agents (queried reactively)

### Overview tab (`GodDashboard.tsx`)

Per-agent cost row in the existing agent summary cards, visible when data exists:

```
Elena Voss    14.2k in / 0.8k out    $0.003
```

---

## Error Handling

- If `costs.jsonl` doesn't exist yet (sim hasn't run): skip silently, don't update offset
- If a JSONL line fails to parse: skip it, log a warning, continue
- If `readAgentCostsDelta` fails: log error, don't crash the tick — cost tracking failure is non-fatal
- If offset exceeds file size (file was deleted/truncated): reset offset to 0 and re-read

---

## Lifecycle Summary

| Event | Behaviour |
|---|---|
| Fresh start | Offsets stay, lifetime totals stay — new run's costs accumulate into existing totals |
| Continue | Same — accumulates |
| Stop | Totals freeze, visible in UI |
| "Clear stats" button | Zeros all lifetime fields + sessionCostUsd, resets offsets |
| Agent model switch | Writes new pricing fields to `rl_agents` row |
