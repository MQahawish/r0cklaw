/**
 * Reputation system -- tracks each agent's standing in the village (0-100).
 *
 * Score effects (applied in commitAction / bridge.ts):
 *   > 70 : 5% discount on buy/sell transactions
 *   < 30 : 10% markup on buy/sell transactions
 *   < 20 : refused service at socially-gated locations (inn, shrine, market)
 *
 * Score changes (scheduled after commitAction):
 *   +2  : give, treat, counsel, bless, run_errand
 *   +1  : trade, sell, buy (successful)
 *   -3  : failed action with target (broken promise)
 *   -10 : steal / crime (future)
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery } from '../_generated/server';

export const getReputation = internalQuery({
  args: { agentName: v.string() },
  handler: async (ctx, { agentName }) => {
    return ctx.db
      .query('rl_reputation')
      .withIndex('agentName', (q) => q.eq('agentName', agentName))
      .unique();
  },
});

export const updateReputation = internalMutation({
  args: {
    agentName: v.string(),
    delta: v.number(),
    note: v.string(),
    tick: v.number(),
  },
  handler: async (ctx, { agentName, delta, note, tick }) => {
    const existing = await ctx.db
      .query('rl_reputation')
      .withIndex('agentName', (q) => q.eq('agentName', agentName))
      .unique();

    const currentScore = existing?.score ?? 50;
    const newScore = Math.max(0, Math.min(100, currentScore + delta));

    const incidents: { tick: number; note: string }[] = existing
      ? (JSON.parse(existing.recentIncidents) as { tick: number; note: string }[])
      : [];

    incidents.push({ tick, note: `${delta > 0 ? '+' : ''}${delta}: ${note}` });
    // Keep last 20 incidents
    if (incidents.length > 20) incidents.splice(0, incidents.length - 20);

    if (existing) {
      await ctx.db.patch(existing._id, {
        score: newScore,
        recentIncidents: JSON.stringify(incidents),
      });
    } else {
      await ctx.db.insert('rl_reputation', {
        agentName,
        score: newScore,
        recentIncidents: JSON.stringify(incidents),
      });
    }
  },
});
