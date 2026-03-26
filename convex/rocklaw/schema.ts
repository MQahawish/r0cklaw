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
    // Overheard context from eavesdrop -- injected into next tick's location.md then cleared
    pendingNote: v.optional(v.string()),
    blankSelf: v.optional(v.boolean()),
    // God-mode agent controls
    paused: v.optional(v.boolean()),
    modelOverride: v.optional(v.string()),
    providerOverride: v.optional(v.string()),
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

  // In-person commerce offers. Created by buy/sell/trade and settled later on explicit acceptance.
  rl_transactions: defineTable({
    txnId: v.string(),
    fromAgent: v.string(),
    toAgent: v.string(),
    kind: v.union(v.literal('buy'), v.literal('sell'), v.literal('trade')),
    offerJson: v.string(),
    requestJson: v.string(),
    message: v.optional(v.string()),
    status: v.union(
      v.literal('pending'),
      v.literal('accepted'),
      v.literal('rejected'),
      v.literal('expired'),
      v.literal('completed'),
      v.literal('failed'),
    ),
    createdTick: v.number(),
    createdDay: v.number(),
    expiresTick: v.number(),
    resolvedTick: v.optional(v.number()),
    resolvedDay: v.optional(v.number()),
    outcomeNote: v.optional(v.string()),
  })
    .index('txnId', ['txnId'])
    .index('recipient_status', ['toAgent', 'status'])
    .index('sender_status', ['fromAgent', 'status'])
    .index('status_expiry', ['status', 'expiresTick']),

  // Short-lived colocated social interactions that both sides can see locally.
  rl_interactions: defineTable({
    interactionId: v.string(),
    kind: v.union(
      v.literal('talk'),
      v.literal('buy'),
      v.literal('sell'),
      v.literal('trade'),
    ),
    fromAgent: v.string(),
    toAgent: v.string(),
    location: v.string(),
    payloadJson: v.string(),
    transactionId: v.optional(v.string()),
    status: v.union(
      v.literal('active'),
      v.literal('responded'),
      v.literal('expired'),
      v.literal('failed'),
      v.literal('completed'),
    ),
    createdTick: v.number(),
    createdDay: v.number(),
    expiresTick: v.number(),
    resolvedTick: v.optional(v.number()),
    resolvedDay: v.optional(v.number()),
    outcomeNote: v.optional(v.string()),
  })
    .index('interactionId', ['interactionId'])
    .index('recipient_status', ['toAgent', 'status'])
    .index('sender_status', ['fromAgent', 'status'])
    .index('status_expiry', ['status', 'expiresTick'])
    .index('transactionId', ['transactionId']),

  // World-owned minimal first-contact records. Used to establish who has
  // physically seen whom before without relying on agent-authored memory.
  rl_social_knowledge: defineTable({
    observerAgent: v.string(),
    subjectAgent: v.string(),
    knownName: v.string(),
    knownRole: v.string(),
    firstSeenDay: v.number(),
    firstSeenTick: v.number(),
    firstSeenLocation: v.string(),
    lastSeenDay: v.number(),
    lastSeenTick: v.number(),
    lastSeenLocation: v.string(),
  })
    .index('observer_subject', ['observerAgent', 'subjectAgent'])
    .index('observer', ['observerAgent']),

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

  // Price snapshots per tick — for history charts and trend analysis.
  // Inserted by priceEngine only when a price actually changes.
  rl_price_history: defineTable({
    tick: v.number(),
    day: v.number(),
    item: v.string(),
    price: v.number(),
    shortageLevel: v.union(
      v.literal('none'),
      v.literal('moderate'),
      v.literal('critical'),
    ),
  })
    .index('item_tick', ['item', 'tick'])
    .index('tick', ['tick']),

  // Systems layer state (for future experiment configs).
  rl_systems_state: defineTable({
    systemName: v.string(),
    key: v.string(),
    value: v.string(),
    updatedAt: v.number(),
  }).index('system', ['systemName', 'key']),
};
