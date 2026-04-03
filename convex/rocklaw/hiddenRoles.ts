/**
 * Hidden Roles -- secret objectives assigned at world gen.
 *
 * Three roles are active per run:
 *   Saboteur  Keep bakery grain below 10 by Elder's Day.
 *   Usurper   Spread damaging gossip; each rumour heard by 2+ agents costs
 *             the target -2 reputation. Win by having the most influence
 *             incidents recorded by Elder's Day.
 *   Heir      Hold more coin than a named rival by Elder's Day.
 *
 * Roles are assigned once from initRocklaw and are never shown to other
 * agents -- only the holder sees their objective in TURN.md.
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';

// ── Queries ───────────────────────────────────────────────────────────────────

export const getHiddenRoleForAgent = internalQuery({
  args: { agentName: v.string() },
  handler: async (ctx, { agentName }) => {
    return ctx.db
      .query('rl_hidden_roles')
      .withIndex('agentName', (q) => q.eq('agentName', agentName))
      .unique();
  },
});

export const getAllHiddenRoles = internalQuery({
  args: {},
  handler: async (ctx) => {
    return ctx.db.query('rl_hidden_roles').collect();
  },
});

// How many gossip events the agent has sourced that triggered the rep penalty.
export const getUsurperGossipCount = internalQuery({
  args: { agentName: v.string() },
  handler: async (ctx, { agentName }) => {
    const events = await ctx.db
      .query('rl_gossip_events')
      .withIndex('source_day', (q) => q.eq('sourceAgent', agentName))
      .collect();
    return events.filter((e) => e.repPenaltyApplied).length;
  },
});

export const getBakeryGrainStock = internalQuery({
  args: {},
  handler: async (ctx) => {
    const stock = await ctx.db
      .query('rl_place_stocks')
      .withIndex('place_item', (q) => q.eq('placeName', 'bakery').eq('item', 'grain'))
      .unique();
    return stock?.quantity ?? 0;
  },
});

// ── Mutations ─────────────────────────────────────────────────────────────────

/**
 * Called once from initRocklaw after agents are seeded.
 * Picks 3 agents at random and assigns Saboteur, Usurper, Heir.
 * For the Heir a second agent (different from heir) is chosen as the rival.
 */
export const assignHiddenRoles = internalMutation({
  args: {
    agentNames: v.array(v.string()),
    day: v.number(),
  },
  handler: async (ctx, { agentNames, day }) => {
    // Clear any prior assignments.
    const existing = await ctx.db.query('rl_hidden_roles').collect();
    for (const row of existing) {
      await ctx.db.delete(row._id);
    }

    if (agentNames.length < 3) {
      console.warn('[hiddenRoles] Not enough agents to assign three hidden roles.');
      return;
    }

    // Fisher-Yates shuffle of a copy.
    const shuffled = [...agentNames];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const [saboteurName, usurperName, heirName, ...rest] = shuffled;

    // Heir's rival: first agent from the remaining pool, or wrap around.
    const rivalName = rest.length > 0 ? rest[0] : saboteurName;

    await ctx.db.insert('rl_hidden_roles', {
      agentName: saboteurName,
      roleType: 'Saboteur',
      assignedDay: day,
    });
    await ctx.db.insert('rl_hidden_roles', {
      agentName: usurperName,
      roleType: 'Usurper',
      assignedDay: day,
    });
    await ctx.db.insert('rl_hidden_roles', {
      agentName: heirName,
      roleType: 'Heir',
      rival: rivalName,
      assignedDay: day,
    });

    console.log(`[hiddenRoles] Assigned: Saboteur=${saboteurName}, Usurper=${usurperName}, Heir=${heirName} (rival: ${rivalName})`);
  },
});

/**
 * Record a gossip event. Called from bridge when an agent uses
 * say + intent:"gossip" with a topic that matches an agent name.
 * Applies -2 rep to the topic agent if witnessCount >= 2 and the
 * penalty has not yet been applied.
 */
export const recordGossipEvent = internalMutation({
  args: {
    gossipId: v.string(),
    sourceAgent: v.string(),
    topic: v.string(),
    content: v.string(),
    tick: v.number(),
    day: v.number(),
    witnessCount: v.number(),
  },
  handler: async (ctx, args) => {
    const { gossipId, sourceAgent, topic, content, tick, day, witnessCount } = args;

    const repPenaltyApplied = witnessCount >= 2;

    await ctx.db.insert('rl_gossip_events', {
      gossipId,
      sourceAgent,
      topic,
      content,
      tick,
      day,
      witnessCount,
      repPenaltyApplied,
    });

    if (repPenaltyApplied) {
      await ctx.scheduler.runAfter(0, internal.rocklaw.reputation.updateReputation, {
        agentName: topic,
        delta: -2,
        note: `Damaging gossip spread publicly by ${sourceAgent} (heard by ${witnessCount} villager${witnessCount !== 1 ? 's' : ''})`,
        tick,
      });
    }
  },
});
