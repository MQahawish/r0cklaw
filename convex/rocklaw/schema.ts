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
    pendingActionJson: v.optional(v.string()),
    pendingActionStartedTick: v.optional(v.number()),
    pendingActionStartedDay: v.optional(v.number()),
    // Overheard context from eavesdrop -- injected into next tick's TURN.md then cleared
    pendingNote: v.optional(v.string()),
    blankSelf: v.optional(v.boolean()),
    // God-mode agent controls
    paused: v.optional(v.boolean()),
    modelOverride: v.optional(v.string()),
    providerOverride: v.optional(v.string()),
    openrouterFreeEnabled: v.optional(v.boolean()),
    openrouterFreeCandidatesJson: v.optional(v.string()),
    openrouterFreeCurrentIndex: v.optional(v.number()),
    openrouterFreeFailureCount: v.optional(v.number()),
    openrouterFreeFallbackActivated: v.optional(v.boolean()),
    openrouterFreeFallbackModel: v.optional(v.string()),
    openrouterFreeFallbackProvider: v.optional(v.string()),
    // Cost & token tracking (cumulative, cleared by user via clearCostStats)
    lifetimeCostUsd: v.optional(v.number()),
    lifetimeInputTokens: v.optional(v.number()),
    lifetimeOutputTokens: v.optional(v.number()),
    costsFileOffset: v.optional(v.number()),
    // Pricing for the currently-configured OpenRouter model (USD per token, not per million)
    currentModelPromptPrice: v.optional(v.number()),
    currentModelCompletionPrice: v.optional(v.number()),
  })
    .index('name', ['name'])
    .index('location', ['location']),

  rl_agent_profiles: defineTable({
    agentName: v.string(),
    coreNature: v.array(v.string()),
    whatMattersMost: v.array(v.string()),
    whenTimesAreGood: v.array(v.string()),
    whenTimesAreTight: v.array(v.string()),
  }).index('agentName', ['agentName']),

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

  // Legacy location-based messaging system. Kept for migration/backfill only.
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

  // Unified chat messages. Same-location contacts are treated as live; others
  // receive deferred unread messages in their thread.
  rl_chat_messages: defineTable({
    threadKey: v.string(),
    sceneId: v.optional(v.string()),
    sceneOrder: v.optional(v.number()),
    fromAgent: v.string(),
    toAgent: v.string(),
    text: v.string(),
    deliveryMode: v.union(
      v.literal('live'),
      v.literal('deferred'),
    ),
    status: v.union(
      v.literal('unread'),
      v.literal('read'),
    ),
    sentTick: v.number(),
    sentDay: v.number(),
    readTick: v.optional(v.number()),
    readDay: v.optional(v.number()),
  })
    .index('thread_sent', ['threadKey', 'sentDay', 'sentTick'])
    .index('recipient_status', ['toAgent', 'status', 'sentDay', 'sentTick'])
    .index('recipient_sent', ['toAgent', 'sentDay', 'sentTick'])
    .index('sender_sent', ['fromAgent', 'sentDay', 'sentTick']),

  // First-class live chat scenes. These replace rl_interactions.kind === 'talk'
  // as the source of truth for ongoing synchronous conversation.
  rl_chat_scenes: defineTable({
    sceneId: v.string(),
    agentA: v.string(),
    agentB: v.string(),
    location: v.string(),
    status: v.union(
      v.literal('pending'),
      v.literal('live'),
      v.literal('closed'),
    ),
    nextSpeaker: v.string(),
    lastSpeaker: v.optional(v.string()),
    openingSpeaker: v.optional(v.string()),
    openingText: v.optional(v.string()),
    openingOfferRef: v.optional(v.string()),
    openingOfferPayloadJson: v.optional(v.string()),
    interruptedSpeaker: v.optional(v.string()),
    interruptedText: v.optional(v.string()),
    interruptedActionJson: v.optional(v.string()),
    interruptedContextPending: v.optional(v.boolean()),
    openedTick: v.number(),
    openedDay: v.number(),
    lastMessageOrder: v.optional(v.number()),
    lastActiveTick: v.number(),
    lastActiveDay: v.number(),
    stallTurns: v.optional(v.number()),
    closeReason: v.optional(v.string()),
    closedTick: v.optional(v.number()),
    closedDay: v.optional(v.number()),
  })
    .index('sceneId', ['sceneId'])
    .index('agentA_status', ['agentA', 'status'])
    .index('agentB_status', ['agentB', 'status'])
    .index('status_location', ['status', 'location']),

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
      v.literal('superseded'),
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

  rl_journal_entries: defineTable({
    agentName: v.string(),
    day: v.number(),
    tick: v.number(),
    timeOfDay: v.string(),
    summary: v.string(),
    memoryKey: v.optional(v.string()),
    memoryIngestedAt: v.optional(v.number()),
  })
    .index('agent_day_tick', ['agentName', 'day', 'tick'])
    .index('agentName', ['agentName']),

  rl_activity_notes: defineTable({
    agentName: v.string(),
    line: v.string(),
    tick: v.optional(v.number()),
    day: v.optional(v.number()),
    timeOfDay: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index('agent_createdAt', ['agentName', 'createdAt'])
    .index('agent_tick', ['agentName', 'tick'])
    .index('agentName', ['agentName']),

  // Field lifecycle state for grounded farm production.
  rl_fields: defineTable({
    fieldKey: v.string(),
    location: v.string(),
    cropItem: v.optional(v.union(v.string(), v.null())),
    stage: v.union(v.literal('fallow'), v.literal('growing'), v.literal('ready')),
    readyTick: v.optional(v.union(v.number(), v.null())),
  })
    .index('fieldKey', ['fieldKey'])
    .index('location', ['location']),

  // Renewable herb supply that powers gathering and brewing.
  rl_herb_patches: defineTable({
    patchKey: v.string(),
    location: v.string(),
    herbItem: v.string(),
    available: v.number(),
    maxAvailable: v.number(),
    regenPerDay: v.number(),
    lastRegenDay: v.number(),
  })
    .index('patchKey', ['patchKey'])
    .index('location', ['location']),

  // Village locations with message boards.
  rl_locations: defineTable({
    name: v.string(),
    type: v.string(),
    capacity: v.number(),
    tags: v.optional(v.array(v.string())),
    // JSON array of agent names currently here
    presentAgents: v.string(),
    // Pending messages left at this location's board: JSON array
    messageBoard: v.string(),
  }).index('name', ['name']),

  rl_place_stocks: defineTable({
    placeName: v.string(),
    item: v.string(),
    quantity: v.number(),
    capacity: v.optional(v.number()),
    buys: v.boolean(),
    sells: v.boolean(),
    bidPrice: v.optional(v.number()),
    askPrice: v.optional(v.number()),
  })
    .index('place_item', ['placeName', 'item'])
    .index('place', ['placeName'])
    .index('item', ['item']),

  rl_place_markets: defineTable({
    placeName: v.string(),
    treasury: v.number(),
    buySpreadPct: v.number(),
    sellSpreadPct: v.number(),
    targetStockRatio: v.number(),
  }).index('placeName', ['placeName']),

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
    location: v.optional(v.string()),
    fromLocation: v.optional(v.string()),
    toLocation: v.optional(v.string()),
    message: v.optional(v.string()),
    tick: v.number(),
    day: v.number(),
    timeOfDay: v.optional(v.string()),
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
    timeOfDay: v.union(
      v.literal('dawn'),
      v.literal('morning'),
      v.literal('midday'),
      v.literal('afternoon'),
      v.literal('evening'),
      v.literal('night'),
    ),
    isRunning: v.boolean(),
    // Day on which Elder's Day fires. Fixed at world gen.
    eldersDay: v.optional(v.number()),
  }),

  // Secret role assignments handed out at world gen.
  // Only the assigned agent sees this in their TURN.md.
  rl_hidden_roles: defineTable({
    agentName: v.string(),
    roleType: v.union(
      v.literal('Saboteur'),
      v.literal('Usurper'),
      v.literal('Heir'),
    ),
    // Heir: the specific rival they must out-earn.
    // Usurper: unused (they pick their own targets via gossip).
    rival: v.optional(v.string()),
    assignedDay: v.number(),
  })
    .index('agentName', ['agentName'])
    .index('roleType', ['roleType']),

  // Gossip events created when an agent uses say + intent:"gossip" + topic.
  // When witnessCount >= 2 the engine applies a rep penalty to the topic agent.
  rl_gossip_events: defineTable({
    gossipId: v.string(),
    sourceAgent: v.string(),
    // The agent name being gossiped about.
    topic: v.string(),
    content: v.string(),
    tick: v.number(),
    day: v.number(),
    // Number of agents at the location when the gossip was spoken (excl. speaker).
    witnessCount: v.number(),
    // Whether the -2 rep penalty has been applied to topic yet.
    repPenaltyApplied: v.boolean(),
  })
    .index('gossipId', ['gossipId'])
    .index('topic_day', ['topic', 'day'])
    .index('source_day', ['sourceAgent', 'day']),

  rl_run_console_state: defineTable({
    singletonKey: v.string(),
    controlStatus: v.union(
      v.literal('idle'),
      v.literal('preparing'),
      v.literal('ready'),
      v.literal('running'),
      v.literal('error'),
    ),
    autoRunning: v.boolean(),
    stepInProgress: v.boolean(),
    loopToken: v.number(),
    selectedAgentSlugsJson: v.string(),
    mode: v.union(v.literal('fresh'), v.literal('continue')),
    profile: v.union(v.literal('blank-self'), v.literal('seeded')),
    providerPreset: v.string(),
    modelProvider: v.optional(v.string()),
    modelId: v.optional(v.string()),
    fallbackProvider: v.optional(v.string()),
    fallbackModel: v.optional(v.string()),
    stepBatchSize: v.optional(v.number()),
    lastPreparedTick: v.optional(v.number()),
    lastSummaryTick: v.optional(v.number()),
    lastError: v.optional(v.string()),
    updatedAt: v.number(),
    sessionCostUsd: v.optional(v.number()),
  }).index('singletonKey', ['singletonKey']),

  rl_run_tick_summaries: defineTable({
    tick: v.number(),
    day: v.number(),
    timeOfDay: v.string(),
    summaryJson: v.string(),
    createdAt: v.number(),
  })
    .index('tick', ['tick'])
    .index('createdAt', ['createdAt']),

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
