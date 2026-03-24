/**
 * Observation Layer -- Phase 7
 *
 * Backend for the three observation panels:
 *   getAgentFiles   -- reads live workspace files for the agent inspector
 *   getRelationships -- computes interaction matrix from rl_actions_log
 *   getPriceHistory  -- returns price snapshots for economy charts
 */

import { v } from 'convex/values';
import { query, action } from '../_generated/server';
import { internal, api } from '../_generated/api';
import * as fs from 'fs/promises';
import * as path from 'path';

// ── Agent file inspector ──────────────────────────────────────────────────────

// Which files to expose in the inspector, in display order.
const INSPECTOR_FILES = [
  { label: 'Soul',       file: '01_SOUL.md' },
  { label: 'Memory',     file: '05_MEMORY.md' },
  { label: 'Heartbeat',  file: '06_HEARTBEAT.md' },
  { label: 'Beliefs',    file: 'self/beliefs.md' },
  { label: 'Goals',      file: 'self/goals.md' },
  { label: 'Plans',      file: 'self/plans.md' },
  { label: 'Secrets',    file: 'self/secrets.md' },
  { label: 'Desires',    file: 'self/desires.md' },
  { label: 'Sent log',   file: 'self/messages/sent_log.md' },
  // World files (refreshed each tick — shows current state)
  { label: 'Status',     file: 'world/status.md' },
  { label: 'Inventory',  file: 'world/inventory.md' },
  { label: 'Location',   file: 'world/location.md' },
  { label: 'News',       file: 'world/village_news.md' },
];

export type AgentFileEntry = {
  label: string;
  file: string;
  content: string | null; // null = file doesn't exist yet
};

export type SocialFileEntry = {
  otherAgent: string;
  content: string;
};

export const getAgentFiles = action({
  args: { agentName: v.string() },
  handler: async (ctx, { agentName }): Promise<{ files: AgentFileEntry[]; social: SocialFileEntry[] }> => {
    // Look up the agent's workspacePath from DB
    const agents = await ctx.runQuery(api.rocklaw.observe.getAgentWorkspacePaths);
    const agent = agents.find((a: any) => a.name === agentName);
    if (!agent) return { files: [], social: [] };

    const absPath = path.resolve(agent.workspacePath);

    // Read curated files
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

    // Read social/*/private.md
    const social: SocialFileEntry[] = [];
    const socialDir = path.join(absPath, 'self', 'social');
    try {
      const entries = await fs.readdir(socialDir);
      for (const entry of entries) {
        try {
          const content = await fs.readFile(path.join(socialDir, entry, 'private.md'), 'utf8');
          social.push({ otherAgent: entry, content });
        } catch { /* no private.md yet */ }
      }
    } catch { /* no social dir yet */ }

    return { files, social };
  },
});

export const getAgentWorkspacePaths = query({
  args: {},
  handler: async (ctx) => {
    const agents = await ctx.db.query('rl_agents').collect();
    return agents.map((a) => ({ name: a.name, workspacePath: a.workspacePath }));
  },
});

// ── Relationship graph ────────────────────────────────────────────────────────

// Action types considered cooperative (green edges)
const COOPERATIVE_ACTIONS = new Set([
  'give', 'trade', 'treat', 'counsel', 'bless', 'officiate',
  'run_errand', 'repair', // helping out
]);

export type RelationshipEdge = {
  from: string;
  to: string;
  count: number;         // total interactions
  cooperative: number;   // cooperative action count
  transactional: number; // buy/sell/negotiate count
};

export type RelationshipData = {
  agents: string[];
  edges: RelationshipEdge[];
};

export const getRelationships = query({
  args: {},
  handler: async (ctx): Promise<RelationshipData> => {
    const agentDocs = await ctx.db.query('rl_agents').collect();
    const agentNames = new Set(agentDocs.map((a) => a.name));

    // Pull all actions that have a target which is another agent
    const allActions = await ctx.db.query('rl_actions_log').collect();
    const relevant = allActions.filter(
      (a) => a.target && agentNames.has(a.target) && a.outcome !== 'failed',
    );

    // Build interaction map: key = "from→to"
    const edgeMap = new Map<string, RelationshipEdge>();
    for (const entry of relevant) {
      const key = `${entry.agentName}→${entry.target}`;
      if (!edgeMap.has(key)) {
        edgeMap.set(key, {
          from: entry.agentName,
          to: entry.target!,
          count: 0,
          cooperative: 0,
          transactional: 0,
        });
      }
      const edge = edgeMap.get(key)!;
      edge.count++;
      if (COOPERATIVE_ACTIONS.has(entry.action)) edge.cooperative++;
      if (['buy', 'sell', 'negotiate', 'trade'].includes(entry.action)) edge.transactional++;
    }

    // Merge bidirectional edges (A→B + B→A = one undirected edge)
    const merged = new Map<string, RelationshipEdge>();
    for (const [, edge] of edgeMap) {
      const canonical = [edge.from, edge.to].sort().join('↔');
      if (!merged.has(canonical)) {
        merged.set(canonical, { ...edge });
      } else {
        const m = merged.get(canonical)!;
        m.count += edge.count;
        m.cooperative += edge.cooperative;
        m.transactional += edge.transactional;
      }
    }

    return {
      agents: agentDocs.map((a) => a.name),
      edges: Array.from(merged.values()),
    };
  },
});

// ── Price history ─────────────────────────────────────────────────────────────

export type PricePoint = {
  tick: number;
  day: number;
  price: number;
  shortageLevel: 'none' | 'moderate' | 'critical';
};

export type ItemPriceHistory = {
  item: string;
  basePrice: number;
  history: PricePoint[]; // newest last
};

export const getPriceHistory = query({
  args: { ticks: v.optional(v.number()) },
  handler: async (ctx, { ticks = 50 }): Promise<ItemPriceHistory[]> => {
    const worldState = await ctx.db.query('rl_world_state').unique();
    const currentTick = worldState?.tick ?? 0;
    const since = Math.max(0, currentTick - ticks);

    // Current prices (for basePrice reference)
    const currentPrices = await ctx.db.query('rl_market_prices').collect();
    const basePriceMap = new Map(currentPrices.map((p) => [p.item, p.basePrice]));

    // History snapshots
    const snapshots = await ctx.db
      .query('rl_price_history')
      .withIndex('tick', (q) => q.gte('tick', since))
      .order('asc')
      .collect();

    // Group by item
    const byItem = new Map<string, PricePoint[]>();
    for (const snap of snapshots) {
      if (!byItem.has(snap.item)) byItem.set(snap.item, []);
      byItem.get(snap.item)!.push({
        tick: snap.tick,
        day: snap.day,
        price: snap.price,
        shortageLevel: snap.shortageLevel,
      });
    }

    return Array.from(byItem.entries()).map(([item, history]) => ({
      item,
      basePrice: basePriceMap.get(item) ?? 0,
      history,
    }));
  },
});
