/**
 * server/index.ts
 * Main entrypoint for the local backend server.
 *
 * Startup sequence:
 *  1. Open SQLite DB (creates tables if needed)
 *  2. Create scheduler + ctx
 *  3. Create subscription manager
 *  4. Register all query / mutation / action handlers
 *  5. Start Express + WebSocket server on port 3210
 *  6. Resume any pending scheduled jobs
 *
 * This replaces Docker + Convex entirely.
 * Later (Phase 5), ZeroClaw gateway processes are also spawned from here.
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { getDb } from './db.js';
import { Scheduler } from './scheduler.js';
import { makeCtx } from './ctx.js';
import { createSubscriptionManager } from './subscriptions.js';
import { createServer, registerQuery, registerMutation, registerAction, queryHandlers } from './router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure data directory exists
const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, 'storage'), { recursive: true });

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const db = getDb(path.join(dataDir, 'rocklaw.db'));
const scheduler = new Scheduler(db, () => ctx);
const ctx = makeCtx(db, scheduler);
const subManager = createSubscriptionManager(() => ctx);

// ─── Register handlers ────────────────────────────────────────────────────────
// Handlers are imported and registered in Phase 2 as each /convex/ file is ported.
// For now, register stubs so the server starts cleanly.

registerQuery('world.defaultWorldStatus', async (ctx) => {
  const state = ctx.db.query('rl_world_state').first();
  if (!state) return null;
  const ws = ctx.db.query('worldStatus').first();
  return { worldId: ws?._id ?? null, engineId: ws?.engineId ?? null, isDefault: true, status: state.isRunning ? 'running' : 'stoppedByDeveloper' };
});

registerQuery('world.worldState', async (ctx, args: any) => {
  const world = ctx.db.query('worlds').first();
  return world ?? null;
});

registerQuery('world.gameDescriptions', async (ctx, args: any) => {
  const worldId = (args as any)?.worldId;
  if (!worldId) return null;
  const playerDescs = ctx.db.query('playerDescriptions').filter(q => q.eq(q.field('worldId'), worldId)).collect();
  const agentDescs = ctx.db.query('agentDescriptions').filter(q => q.eq(q.field('worldId'), worldId)).collect();
  return { playerDescriptions: playerDescs, agentDescriptions: agentDescs };
});

registerQuery('world.userStatus', async (_ctx, _args) => {
  // Human player status — returns null until a player joins
  return null;
});

registerQuery('world.previousConversation', async (_ctx, _args) => {
  return null;
});

registerQuery('messages.listMessages', async (ctx, args: any) => {
  const { conversationId, worldId } = (args ?? {}) as any;
  if (!conversationId) return [];
  return ctx.db.query('messages')
    .filter(q => q.and(
      q.eq(q.field('conversationId'), conversationId),
      q.eq(q.field('worldId'), worldId ?? null),
    ))
    .collect();
});

registerQuery('rocklaw.god.getDashboard', async (ctx) => {
  const agents = ctx.db.query('rl_agents').collect();
  const worldState = ctx.db.query('rl_world_state').first();
  const events = ctx.db.query('rl_world_events').filter(q => q.eq(q.field('active'), true)).collect();
  const prices = ctx.db.query('rl_market_prices').collect();
  const reputation = ctx.db.query('rl_reputation').collect();
  return { agents, worldState, events, prices, reputation };
});

registerQuery('rocklaw.systems.getSystems', async (ctx) => {
  return ctx.db.query('rl_systems_state').collect();
});

registerQuery('rocklaw.observe.getAgentWorkspacePaths', async (ctx) => {
  return ctx.db.query('rl_agents').collect().map(a => ({
    name: a.name,
    workspacePath: a.workspacePath,
  }));
});

registerQuery('rocklaw.observe.getPriceHistory', async (ctx, args: any) => {
  const limit = (args as any)?.limit ?? 60;
  return ctx.db.query('rl_price_history').order('desc').take(limit);
});

registerQuery('rocklaw.observe.getRelationships', async (ctx) => {
  return ctx.db.query('rl_social_knowledge').collect();
});

registerQuery('music.getBackgroundMusic', async (ctx) => {
  const music = ctx.db.query('music').filter(q => q.eq(q.field('type'), 'background')).first();
  return music ? { url: `/storage/${music.storageId}` } : null;
});

registerQuery('testing.stopAllowed', async () => true);

// Stub mutations — replaced in Phase 2
for (const name of [
  'world.joinWorld', 'world.leaveWorld', 'world.heartbeatWorld', 'world.sendWorldInput',
  'messages.writeMessage',
  'testing.stop', 'testing.resume',
  'rocklaw.god.startSim', 'rocklaw.god.stopSim',
  'rocklaw.god.injectEvent', 'rocklaw.god.resolveEvent',
  'rocklaw.god.pauseAgent', 'rocklaw.god.resumeAgent',
  'rocklaw.systems.setSystemValue', 'rocklaw.systems.applyPreset', 'rocklaw.systems.resetToDefaults',
]) {
  registerMutation(name, async (_ctx, args) => {
    console.log(`[stub mutation] ${name}`, args);
    return null;
  });
}

// Stub actions — replaced in Phase 2
for (const name of [
  'rocklaw.god.suggestEvents',
  'rocklaw.observeNode.getAgentFiles',
  'rocklaw.godNode.setAgentModel',
]) {
  registerAction(name, async (_ctx, args) => {
    console.log(`[stub action] ${name}`, args);
    return null;
  });
}

// Register all query handlers in the subscription manager so it can push updates
for (const [name, handler] of queryHandlers) {
  subManager.registerQuery(name, handler);
}

// ─── Start server ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.LOCAL_SERVER_PORT ?? '3210', 10);
const STATIC_DIR = process.env.STATIC_DIR ?? path.join(__dirname, '..', 'dist');

const { httpServer } = createServer(() => ctx, subManager, PORT, STATIC_DIR);

// Resume pending scheduled jobs after server is ready
scheduler.resumePendingJobs();

console.log('[server] Rocklaw local backend ready.');

export { db, ctx, scheduler, subManager };
