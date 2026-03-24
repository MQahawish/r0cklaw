/**
 * Rocklaw Tick Engine
 *
 * Self-scheduling action loop that drives the simulation forward.
 * Each "tick" = one time-of-day period (morning / afternoon / evening).
 *
 * Public surface:
 *   startRocklaw()   -- set isRunning = true, kick off the loop
 *   stopRocklaw()    -- set isRunning = false, loop exits gracefully
 *   manualTick()     -- fire exactly one tick right now (for testing / Phase 1 verify)
 */

import { v } from 'convex/values';
import { action, mutation, internalAction, internalMutation, internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';

// How long the engine sleeps between ticks (ms).
// 30 s per time-of-day period = ~90 s / simulated day. Easy to watch in dev.
const TICK_INTERVAL_MS = 30_000;

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

// ── Core tick loop ───────────────────────────────────────────────────────────

/**
 * Runs a single simulation tick:
 *   1. Advance world time (morning → afternoon → evening → next day morning)
 *   2. For every non-busy agent, fire tickAgent (concurrently)
 *   3. If still running, reschedule itself after TICK_INTERVAL_MS
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
      console.log('[engine] isRunning = false, stopping');
      return;
    }

    // Advance tick counter + time-of-day
    const next = await ctx.runMutation(internal.rocklaw.init.advanceTick, {});
    if (!next) {
      console.error('[engine] advanceTick returned nothing');
      return;
    }

    const { tick, day, timeOfDay } = next;
    console.log(`[engine] tick ${tick} — Day ${day}, ${timeOfDay}`);

    // Collect all non-busy agents and fire their ticks concurrently
    const agents = await ctx.runQuery(internal.rocklaw.engine.getNonBusyAgents, { tick });
    await Promise.all(
      agents.map((agentName: string) =>
        ctx.runAction(internal.rocklaw.bridge.tickAgent, { agentName, tick, day, timeOfDay }),
      ),
    );

    // Reschedule
    await ctx.scheduler.runAfter(TICK_INTERVAL_MS, internal.rocklaw.engine.runRocklawTick, {});
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
    await ctx.scheduler.runAfter(0, internal.rocklaw.engine.runRocklawTick, {});
    console.log('[engine] Rocklaw started');
    return { status: 'started' };
  },
});

export const stopRocklaw = mutation({
  args: {},
  handler: async (ctx) => {
    const state = await ctx.db.query('rl_world_state').unique();
    if (!state) return { status: 'no_world_state' };
    await ctx.db.patch(state._id, { isRunning: false });
    console.log('[engine] Rocklaw stopped (loop will exit after current tick)');
    return { status: 'stopped' };
  },
});

/**
 * Fire exactly one tick immediately, without starting the continuous loop.
 * Useful for Phase 1 verification and manual testing.
 *
 * Usage:  npx convex run rocklaw/engine:manualTick
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
      // Tick just the requested agent
      await ctx.runAction(internal.rocklaw.bridge.tickAgent, { agentName, tick, day, timeOfDay });
      return { tick, day, timeOfDay, agents: [agentName] };
    }

    // Tick all non-busy agents
    const agents = await ctx.runQuery(internal.rocklaw.engine.getNonBusyAgents, { tick });
    await Promise.all(
      agents.map((name: string) =>
        ctx.runAction(internal.rocklaw.bridge.tickAgent, {
          agentName: name,
          tick,
          day,
          timeOfDay,
        }),
      ),
    );
    return { tick, day, timeOfDay, agents };
  },
});
