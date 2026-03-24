/**
 * Rocklaw World Clock -- Phase 6 (action-driven ticks)
 *
 * The engine is now purely a world clock:
 *   1. Advances the global tick counter + time-of-day every TICK_INTERVAL_MS
 *   2. Clears stale busy flags
 *   3. Runs compaction every 10 ticks
 *
 * Agents are NO LONGER fired by the global loop.
 * Each agent self-schedules its own next tick from bridge.tickAgent,
 * waiting duration_ticks * TICK_INTERVAL_MS before waking again.
 *
 * startRocklaw() starts the world clock AND fires the first tick for every agent.
 * stopRocklaw() sets isRunning = false; the clock exits after the next tick.
 */

import { v } from 'convex/values';
import { action, mutation, internalAction, internalMutation, internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';

// Base tick duration in ms.  1 tick = one time-of-day period (morning / afternoon / evening).
// 30 s per period = ~90 s per simulated day.  Easy to watch in dev.
export const TICK_INTERVAL_MS = 30_000;

// How often compaction runs (in ticks).
const COMPACT_EVERY_N_TICKS = 10;

// ── Internal helpers ─────────────────────────────────────────────────────────

export const getWorldState = internalQuery({
  args: {},
  handler: async (ctx) => ctx.db.query('rl_world_state').unique(),
});

export const setRunning = internalMutation({
  args: { isRunning: v.boolean() },
  handler: async (ctx, { isRunning }) => {
    const state = await ctx.db.query('rl_world_state').unique();
    if (!state) throw new Error('[engine] rl_world_state not found — run initRocklaw first');
    await ctx.db.patch(state._id, { isRunning });
  },
});

// ── World clock loop ─────────────────────────────────────────────────────────

/**
 * The world clock.  Runs every TICK_INTERVAL_MS.
 * Only advances time and handles housekeeping.
 * Does NOT fire agents — they self-schedule from bridge.tickAgent.
 */
export const runRocklawTick = internalAction({
  args: {},
  handler: async (ctx) => {
    const state = await ctx.runQuery(internal.rocklaw.engine.getWorldState);
    if (!state) {
      console.error('[engine] No world state — bailing out');
      return;
    }
    if (!state.isRunning) {
      console.log('[engine] isRunning = false, world clock stopping');
      return;
    }

    // Advance tick counter + time-of-day
    const next = await ctx.runMutation(internal.rocklaw.init.advanceTick, {});
    if (!next) {
      console.error('[engine] advanceTick returned nothing');
      return;
    }

    const { tick, day, timeOfDay } = next;
    console.log(`[engine] clock tick ${tick} — Day ${day}, ${timeOfDay}`);

    // Clear any stale busy flags
    await ctx.runMutation(internal.rocklaw.engine.clearStaleBusy, { tick });

    // Refresh lastInput for Rocklaw sprites — prevents AI Town idle-kick after 5 min
    await ctx.runMutation(internal.rocklaw.visualBridge.keepAliveVisualAgents, {});

    // Run compaction every COMPACT_EVERY_N_TICKS
    if (tick % COMPACT_EVERY_N_TICKS === 0) {
      console.log(`[engine] tick ${tick}: triggering compaction`);
      await ctx.runAction(internal.rocklaw.compact.runCompaction, {});
    }

    // Reschedule the clock
    await ctx.scheduler.runAfter(TICK_INTERVAL_MS, internal.rocklaw.engine.runRocklawTick, {});
  },
});

// ── Busy-flag cleanup ─────────────────────────────────────────────────────────

export const clearStaleBusy = internalMutation({
  args: { tick: v.number() },
  handler: async (ctx, { tick }) => {
    const allAgents = await ctx.db.query('rl_agents').collect();
    for (const agent of allAgents) {
      if (agent.busy && agent.busyUntilTick !== undefined && agent.busyUntilTick <= tick) {
        await ctx.db.patch(agent._id, { busy: false, busyUntilTick: undefined });
      }
    }
  },
});

export const getNonBusyAgents = internalQuery({
  args: { tick: v.number() },
  handler: async (ctx, { tick }) => {
    const agents = await ctx.db.query('rl_agents').collect();
    return agents
      .filter((a) => !a.busy || (a.busyUntilTick !== undefined && a.busyUntilTick <= tick))
      .map((a) => a.name);
  },
});

// ── Public controls ──────────────────────────────────────────────────────────

export const startRocklaw = mutation({
  args: {},
  handler: async (ctx) => {
    const state = await ctx.db.query('rl_world_state').unique();
    if (!state) throw new Error('[engine] Run initRocklaw first');
    if (state.isRunning) {
      console.log('[engine] Already running');
      return { status: 'already_running' };
    }
    await ctx.db.patch(state._id, { isRunning: true });

    // Start the world clock
    await ctx.scheduler.runAfter(0, internal.rocklaw.engine.runRocklawTick, {});

    // Kick off each agent's individual tick loop
    const agents = await ctx.db.query('rl_agents').collect();
    for (const agent of agents) {
      await ctx.scheduler.runAfter(0, internal.rocklaw.bridge.tickAgent, { agentName: agent.name });
    }

    console.log(`[engine] Rocklaw started — world clock + ${agents.length} agent loops`);
    return { status: 'started', agentCount: agents.length };
  },
});

export const stopRocklaw = mutation({
  args: {},
  handler: async (ctx) => {
    const state = await ctx.db.query('rl_world_state').unique();
    if (!state) return { status: 'no_world_state' };
    await ctx.db.patch(state._id, { isRunning: false });
    console.log('[engine] Rocklaw stopping (clock exits after next tick; agent loops will drain)');
    return { status: 'stopped' };
  },
});

/**
 * Fire exactly one tick for one or all agents, without starting the continuous loop.
 * Useful for testing / Phase 1 verification.
 *
 * Usage:  npx convex run rocklaw/engine:manualTick
 *         npx convex run rocklaw/engine:manualTick '{"agentName":"Elena Voss"}'
 */
export const manualTick = action({
  args: {
    agentName: v.optional(v.string()),
  },
  handler: async (ctx, { agentName }) => {
    const state = await ctx.runQuery(internal.rocklaw.engine.getWorldState);
    if (!state) throw new Error('[engine] Run initRocklaw first');

    // Advance time
    const next = await ctx.runMutation(internal.rocklaw.init.advanceTick, {});
    if (!next) throw new Error('[engine] advanceTick failed');

    const { tick, day, timeOfDay } = next;
    console.log(`[engine] manualTick — tick ${tick}, Day ${day}, ${timeOfDay}`);

    if (agentName) {
      await ctx.runAction(internal.rocklaw.bridge.tickAgent, { agentName, _manual: true });
      return { tick, day, timeOfDay, agents: [agentName] };
    }

    // Tick all non-busy agents (no self-scheduling in manual mode)
    const agents = await ctx.runQuery(internal.rocklaw.engine.getNonBusyAgents, { tick });
    await Promise.all(
      agents.map((name: string) =>
        ctx.runAction(internal.rocklaw.bridge.tickAgent, { agentName: name, _manual: true }),
      ),
    );
    return { tick, day, timeOfDay, agents };
  },
});
