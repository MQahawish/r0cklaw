/**
 * Visual Bridge -- syncs Rocklaw agents into the AI Town visual layer.
 *
 * Each Rocklaw agent is registered as an AI Town player using their name as a
 * unique tokenIdentifier ("rocklaw:AgentName"). This lets us look them up later
 * without storing a separate player ID.
 *
 * initVisualAgents  -- called once after initRocklaw; creates one AI Town player
 *                      per Rocklaw agent at their starting location.
 * syncAgentPosition -- called after every move action; sends a moveTo input to
 *                      walk the sprite to the new location's tile coordinates.
 * setAgentActivity  -- called after every action; sets the emoji above the sprite.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { insertInput } from '../aiTown/insertInput';
import { SerializedPlayer } from '../aiTown/player';
import { getPlaceLayout } from './mapLayout';

// ── Agent → sprite map ───────────────────────────────────────────────────────

const AGENT_SPRITES: Record<string, string> = {
  'Elena Voss':     'f1',
  'Marcus Hale':    'f2',
  'Finn':           'f3',
  'Lena Marsh':     'f4',
  'Sera':           'f5',
};

// ── Action → emoji map ───────────────────────────────────────────────────────

const ACTION_EMOJI: Record<string, string> = {
  work: '⚒️',
  craft: '⚒️', smelt: '🔥', repair: '🔧', mine: '⛏️',
  harvest: '🌾', plant: '🌱', water: '💧', check_field: '👀',
  gather: '🌿', brew: '⚗️', treat: '💊', identify: '🔍',
  patrol: '⚔️', train: '🏋️', recall_war: '📖',
  negotiate: '📜', bulk_buy: '🛒', post_price: '📋', appraise: '🔎',
  serve: '🍺', rent_room: '🛏️', eavesdrop: '👂', post_notice: '📌',
  bless: '✨', counsel: '🙏', preach: '📣', officiate: '🎗️',
  play: '🎮', run_errand: '📦',
  talk: '💬', chat: '💬', say: '📣', buy: '💰', sell: '💰', trade: '🤝',
  buy_place: '🛒', sell_place: '📦', deliver_place: '🏬',
  give: '🎁', pay: '💸',
  move: '🚶', observe: '👁️', write: '✍️', pray: '🙏',
  leave_message: '✉️', recall: '💭',
  eat: '🍞', rest: '😌', sleep: '😴',
};

// ── helpers ──────────────────────────────────────────────────────────────────

function tokenFor(agentName: string): string {
  return `rocklaw:${agentName}`;
}

async function placementTileForAgent(ctx: any, agentName: string, location: string): Promise<{ x: number; y: number }> {
  const placeLayout = getPlaceLayout(location);
  const colocated = await ctx.db
    .query('rl_agents')
    .withIndex('location', (q: any) => q.eq('location', location))
    .collect();
  const liveScenes = await ctx.db
    .query('rl_chat_scenes')
    .withIndex('status_location', (q: any) => q.eq('status', 'live').eq('location', location))
    .collect();
  for (const scene of liveScenes) {
    const scenePair = [scene.agentA, scene.agentB].sort((a: string, b: string) => a.localeCompare(b));
    const sceneIndex = scenePair.indexOf(agentName);
    if (sceneIndex !== -1) {
      return placeLayout.sceneSlots[sceneIndex] ?? placeLayout.center;
    }
  }
  const chatPriorityNames = liveScenes.flatMap((scene: any) => [scene.agentA, scene.agentB]);
  const remainingNames = colocated
    .map((entry: any) => entry.name)
    .filter((name: string) => !chatPriorityNames.includes(name))
    .sort((a: string, b: string) => a.localeCompare(b));
  const sortedNames = remainingNames;
  const slotIndex = Math.max(0, sortedNames.indexOf(agentName));
  return placeLayout.standingSlots[slotIndex % placeLayout.standingSlots.length] ?? placeLayout.center;
}

// ── Init: create AI Town players for all Rocklaw agents ──────────────────────

export const initVisualAgents = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Find the default AI Town world
    const worldStatus = await ctx.db
      .query('worldStatus')
      .filter((q) => q.eq(q.field('isDefault'), true))
      .unique();

    if (!worldStatus) {
      console.warn('[visualBridge] No default world found — skipping visual init');
      return;
    }

    const worldId = worldStatus.worldId;

    // Load current world to check which players already exist
    const worldDoc = await ctx.db.get(worldId);
    if (!worldDoc) {
      console.warn('[visualBridge] World doc not found');
      return;
    }

    const existingTokens = new Set(
      (worldDoc.players as Array<{ human?: string }>)
        .map((p) => p.human)
        .filter(Boolean),
    );

    const agents = await ctx.db.query('rl_agents').collect();

    let created = 0;
    for (const agent of agents) {
      const token = tokenFor(agent.name);
      if (existingTokens.has(token)) continue;

      const character = AGENT_SPRITES[agent.name] ?? 'f1';

      await insertInput(ctx, worldId, 'join', {
        name: agent.name,
        character,
        description: `${agent.name} is a ${agent.role} in the village of Rocklaw.`,
        tokenIdentifier: token,
      });

      console.log(`[visualBridge] Joined ${agent.name} as ${character}`);
      created++;
    }

    await ctx.scheduler.runAfter(1500, internal.rocklaw.visualBridge.reconcileVisualAgentPlacements, {});
    console.log(`[visualBridge] initVisualAgents complete — created ${created} players`);
  },
});

export const reconcileVisualAgentPlacements = internalMutation({
  args: {},
  handler: async (ctx) => {
    const worldStatus = await ctx.db
      .query('worldStatus')
      .filter((q) => q.eq(q.field('isDefault'), true))
      .unique();
    if (!worldStatus) return;

    const worldDoc = await ctx.db.get(worldStatus.worldId);
    if (!worldDoc) return;

    const agents = await ctx.db.query('rl_agents').collect();
    const players = worldDoc.players as SerializedPlayer[];
    let changed = false;

    const updatedPlayers = await Promise.all(players.map(async (player) => {
      if (!player.human?.startsWith('rocklaw:')) return player;
      const agentName = player.human.slice('rocklaw:'.length);
      const agent = agents.find((entry) => entry.name === agentName);
      if (!agent) return player;

      const tile = await placementTileForAgent(ctx, agent.name, agent.location);
      if (player.position.x === tile.x && player.position.y === tile.y) return player;

      changed = true;
      return {
        ...player,
        position: tile,
        pathfinding: undefined,
        speed: 0,
        facing: { dx: 0, dy: 1 },
      };
    }));

    if (changed) {
      await ctx.db.patch(worldStatus.worldId, { players: updatedPlayers });
    }
  },
});

// ── Sync: move a Rocklaw agent's sprite to a new location ────────────────────

export const syncAgentPosition = internalMutation({
  args: {
    agentName: v.string(),
    newLocation: v.string(),
  },
  handler: async (ctx, { agentName, newLocation }) => {
    const worldStatus = await ctx.db
      .query('worldStatus')
      .filter((q) => q.eq(q.field('isDefault'), true))
      .unique();
    if (!worldStatus) return;

    const worldDoc = await ctx.db.get(worldStatus.worldId);
    if (!worldDoc) return;

    const token = tokenFor(agentName);
    const players = worldDoc.players as SerializedPlayer[];
    const player = players.find((p) => p.human === token);
    if (!player) return;

    const destination = await placementTileForAgent(ctx, agentName, newLocation);

    // Refresh lastInput to prevent AI Town idle-kick (HUMAN_IDLE_TOO_LONG = 5 min)
    const now = Date.now();
    const updatedPlayers = players.map((p) =>
      p.human === token ? { ...p, lastInput: now } : p,
    );
    await ctx.db.patch(worldStatus.worldId, { players: updatedPlayers });

    await insertInput(ctx, worldStatus.worldId, 'moveTo', {
      playerId: player.id,
      destination,
    });
  },
});

// ── Activity: set emoji above a Rocklaw agent's sprite ───────────────────────

export const setAgentActivity = internalMutation({
  args: {
    agentName: v.string(),
    action: v.string(),
    durationMs: v.number(),
  },
  handler: async (ctx, { agentName, action, durationMs }) => {
    const worldStatus = await ctx.db
      .query('worldStatus')
      .filter((q) => q.eq(q.field('isDefault'), true))
      .unique();
    if (!worldStatus) return;

    const worldDoc = await ctx.db.get(worldStatus.worldId);
    if (!worldDoc) return;

    const token = tokenFor(agentName);
    const players = worldDoc.players as SerializedPlayer[];
    const playerIdx = players.findIndex((p) => p.human === token);
    if (playerIdx === -1) return;

    const emoji = ACTION_EMOJI[action];
    if (!emoji) return;

    // Patch the player's activity + refresh lastInput to prevent idle-kick
    const now = Date.now();
    const updatedPlayers: SerializedPlayer[] = [...players];
    updatedPlayers[playerIdx] = {
      ...updatedPlayers[playerIdx],
      lastInput: now,
      activity: {
        description: action,
        emoji,
        until: now + durationMs,
      },
    };

    await ctx.db.patch(worldStatus.worldId, { players: updatedPlayers });
  },
});

// ── Keep-alive: refresh lastInput for all Rocklaw players every world clock tick ──
// Prevents idle-kick for paused agents (AI Town kicks human players after 5 minutes idle).

export const keepAliveVisualAgents = internalMutation({
  args: {},
  handler: async (ctx) => {
    const worldStatus = await ctx.db
      .query('worldStatus')
      .filter((q) => q.eq(q.field('isDefault'), true))
      .unique();
    if (!worldStatus) return;

    const worldDoc = await ctx.db.get(worldStatus.worldId);
    if (!worldDoc) return;

    const players = worldDoc.players as SerializedPlayer[];
    const rocklawPlayers = players.filter((p) => p.human?.startsWith('rocklaw:'));
    if (rocklawPlayers.length === 0) return;

    const now = Date.now();
    const updatedPlayers = players.map((p) =>
      p.human?.startsWith('rocklaw:') ? { ...p, lastInput: now } : p,
    );
    await ctx.db.patch(worldStatus.worldId, { players: updatedPlayers });
    await ctx.scheduler.runAfter(0, internal.rocklaw.visualBridge.reconcileVisualAgentPlacements, {});
  },
});
