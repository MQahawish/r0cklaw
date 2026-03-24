import { defineTable } from 'convex/server';
import { v } from 'convex/values';

// Rocklaw-specific tables, prefixed rl_ to avoid conflicts with AI Town tables.

export const rocklawTables = {
  // One row per villager. Tracks all physical + economic state.
  rl_agents: defineTable({
    name: v.string(),
    role: v.string(),
    location: v.string(),
    // Inventory as a JSON-serialised object: { iron_ore: 5, coal: 8, ... }
    inventory: v.string(),
    energy: v.number(),   // 0-100
    health: v.number(),   // 0-100
    hunger: v.number(),   // 0-100
    coin: v.number(),
    // ZeroClaw gateway port for this agent
    gatewayPort: v.number(),
    // Path to this agent's workspace directory (relative to project root)
    workspacePath: v.string(),
    // Current day in simulation
    currentDay: v.number(),
    // Whether the agent is mid-action (bridge locks this while ticking)
    busy: v.boolean(),
    busyUntilTick: v.optional(v.number()),
  })
    .index('name', ['name'])
    .index('location', ['location']),

  // Market prices, recalculated after any inventory-changing action.
  rl_market_prices: defineTable({
    item: v.string(),
    price: v.number(),
    basePrice: v.number(),
    changePct: v.number(),
    shortageLevel: v.union(
      v.literal('none'),
      v.literal('moderate'),
      v.literal('critical'),
    ),
    lastUpdated: v.number(),
  }).index('item', ['item']),

  // Asynchronous letter system. Delivered by location or via Cora.
  rl_messages: defineTable({
    fromAgent: v.string(),
    toAgent: v.string(),
    content: v.string(),
    status: v.union(
      v.literal('unread'),
      v.literal('read'),
      v.literal('replied'),
    ),
    // null = direct delivery (via Cora); non-null = must be at this location
    deliveryLocationId: v.optional(v.id('rl_locations')),
    daySent: v.number(),
    dayRead: v.optional(v.number()),
    tickSent: v.number(),
  })
    .index('toAgent', ['toAgent', 'status'])
    .index('fromAgent', ['fromAgent', 'daySent']),

  // Village locations with message boards.
  rl_locations: defineTable({
    name: v.string(),
    type: v.string(),
    capacity: v.number(),
    // JSON array of agent names currently here
    presentAgents: v.string(),
    // Pending messages left at this location's board: JSON array
    messageBoard: v.string(),
  }).index('name', ['name']),

  // World events (injected by god-mode or triggered by the simulation).
  rl_world_events: defineTable({
    type: v.string(),
    description: v.string(),
    severity: v.union(v.literal('low'), v.literal('medium'), v.literal('high')),
    active: v.boolean(),
    source: v.union(v.literal('god'), v.literal('simulation')),
    createdAtTick: v.number(),
    resolvedAtTick: v.optional(v.number()),
  }).index('active', ['active', 'createdAtTick']),

  // Full action history for every agent.
  rl_actions_log: defineTable({
    agentName: v.string(),
    action: v.string(),
    target: v.optional(v.string()),
    message: v.optional(v.string()),
    tick: v.number(),
    day: v.number(),
    outcome: v.union(v.literal('success'), v.literal('failed'), v.literal('partial')),
    outcomeNote: v.optional(v.string()),
  })
    .index('agentName', ['agentName', 'tick'])
    .index('tick', ['tick']),

  // Prayers -- never shown to other agents. God-mode only.
  rl_prayers: defineTable({
    agentName: v.string(),
    message: v.string(),
    tick: v.number(),
    day: v.number(),
  }).index('agentName', ['agentName', 'tick']),

  // Reputation scores, updated by engine after key interactions.
  rl_reputation: defineTable({
    agentName: v.string(),
    score: v.number(),  // 0-100
    // JSON array of { tick, note } incident records
    recentIncidents: v.string(),
  }).index('agentName', ['agentName']),

  // Simulation-wide tick counter and current day.
  rl_world_state: defineTable({
    tick: v.number(),
    day: v.number(),
    timeOfDay: v.union(v.literal('morning'), v.literal('afternoon'), v.literal('evening')),
    isRunning: v.boolean(),
  }),

  // Systems layer state (for future experiment configs).
  rl_systems_state: defineTable({
    systemName: v.string(),
    key: v.string(),
    value: v.string(),
    updatedAt: v.number(),
  }).index('system', ['systemName', 'key']),
};
