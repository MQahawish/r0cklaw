"use node";

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import * as fs from 'fs/promises';
import * as path from 'path';

export const refreshWorldFiles = internalAction({
  args: {
    agentName: v.string(),
    tick: v.number(),
    day: v.number(),
    timeOfDay: v.string(),
  },
  handler: async (ctx, { agentName, tick, day, timeOfDay }) => {
    const firstSeenContacts = await ctx.runMutation(internal.rocklaw.worldRefresh.recordFirstSightingsForAgent, {
      agentName,
      tick,
      day,
    });
    for (const contact of firstSeenContacts) {
      await ctx.runAction(internal.rocklaw.worldRefreshNode.appendHeartbeat, {
        agentName,
        line: `- Day ${day} ${timeOfDay}: first saw ${contact.name} (${contact.role}) at ${contact.location}.`,
      });
    }

    const expiredTransactions = await ctx.runMutation(internal.rocklaw.worldRefresh.expireTransactionsForAgent, {
      agentName,
      tick,
      day,
    });
    for (const txn of expiredTransactions) {
      await ctx.runAction(internal.rocklaw.worldRefreshNode.appendHeartbeat, {
        agentName,
        line: `- Day ${day} ${timeOfDay}: ${txn.kind} offer from ${txn.fromAgent} expired [FAILED] ⚠ No response before tick ${tick}.`,
      });
      await ctx.runAction(internal.rocklaw.worldRefreshNode.appendHeartbeat, {
        agentName: txn.fromAgent,
        line: `- Day ${day} ${timeOfDay}: your ${txn.kind} offer to ${agentName} expired [FAILED] ⚠ No response before tick ${tick}.`,
      });
      await ctx.runMutation(internal.rocklaw.bridge.setAgentPendingNote, {
        agentName: txn.fromAgent,
        note: `Your ${txn.kind} offer to ${agentName} expired before a response.`,
      });
      await ctx.runMutation(internal.rocklaw.bridge.setAgentPendingNote, {
        agentName,
        note: `${txn.fromAgent}'s ${txn.kind} offer is no longer actionable. Do not accept or reject it now.`,
      });
    }
    const expiredInteractions = await ctx.runMutation(internal.rocklaw.worldRefresh.expireInteractionsForAgent, {
      agentName,
      tick,
      day,
    });
    for (const interaction of expiredInteractions) {
      await ctx.runAction(internal.rocklaw.worldRefreshNode.appendHeartbeat, {
        agentName: interaction.fromAgent,
        line: interaction.fromHeartbeatLine,
      });
      await ctx.runAction(internal.rocklaw.worldRefreshNode.appendHeartbeat, {
        agentName: interaction.toAgent,
        line: interaction.toHeartbeatLine,
      });
      if (interaction.pendingNoteAgent && interaction.pendingNote) {
        await ctx.runMutation(internal.rocklaw.bridge.setAgentPendingNote, {
          agentName: interaction.pendingNoteAgent,
          note: interaction.pendingNote,
        });
      }
    }

    const data = await ctx.runQuery(internal.rocklaw.worldRefresh.getWorldSnapshot, {
      agentName,
      tick,
      day,
    });
    if (!data) {
      console.error(`[worldRefresh] No data for ${agentName}`);
      return;
    }

    const workspaceRoot = resolveWorkspacePath(data.workspacePath);
    await ensureWorkspaceScaffold(workspaceRoot);
    await refreshRuntimeAgentsMd(workspaceRoot, data);
    await refreshRuntimeSkillMds(workspaceRoot, data);

    const workspacePath = path.join(workspaceRoot, 'world');
    await refreshRuntimeToolsMd(workspaceRoot, timeOfDay, data);

    await Promise.all([
      writeFile(workspacePath, 'inventory.md', buildInventoryMd(agentName, day, data)),
      writeFile(workspacePath, 'location.md', buildLocationMd(agentName, day, timeOfDay, data, firstSeenContacts)),
      writeFile(workspacePath, 'CHAT.md', buildChatMd(data)),
      writeFile(workspacePath, 'OFFERS.md', buildOffersMd(data)),
      writeFile(workspacePath, 'village_news.md', buildVillageNewsMd(day, data)),
      writeFile(workspacePath, 'market_prices.md', buildMarketPricesMd(day, data)),
      writeFile(workspacePath, 'status.md', buildStatusMd(agentName, day, timeOfDay, data)),
    ]);
    await writeChatThreads(workspacePath, data);

    if (data.agent.pendingNote) {
      await ctx.runMutation(internal.rocklaw.worldRefresh.clearPendingNote, { agentName });
    }
  },
});

export const appendHeartbeat = internalAction({
  args: { agentName: v.string(), line: v.string() },
  handler: async (ctx, { agentName, line }) => {
    const agent = await ctx.runQuery(internal.rocklaw.bridge.getAgent, { agentName });
    if (!agent) return;

    const heartbeatPath = path.join(resolveWorkspacePath(agent.workspacePath), 'HEARTBEAT.md');

    let existing = '';
    try {
      existing = await fs.readFile(heartbeatPath, 'utf8');
    } catch {
      existing = `# HEARTBEAT -- ${agentName}\n\n## Recent Activity\n`;
    }

    const lines = existing.split('\n');
    const entries = lines.filter((entry) => entry.startsWith('- Day'));
    const trimmed = entries.slice(-6);

    const newContent = [
      `# HEARTBEAT -- ${agentName}`,
      '',
      '## Recent Activity',
      ...trimmed,
      line,
      '',
    ].join('\n');

    await fs.writeFile(heartbeatPath, newContent, 'utf8');
  },
});

export const getLatestHeartbeatLine = internalAction({
  args: { agentName: v.string() },
  handler: async (ctx, { agentName }) => {
    const agent = await ctx.runQuery(internal.rocklaw.bridge.getAgent, { agentName });
    if (!agent) return null;

    const heartbeatPath = path.join(resolveWorkspacePath(agent.workspacePath), 'HEARTBEAT.md');

    try {
      const existing = await fs.readFile(heartbeatPath, 'utf8');
      const entries = existing
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('- Day'));
      return entries.length > 0 ? entries[entries.length - 1] : null;
    } catch {
      return null;
    }
  },
});

function buildInventoryMd(agentName: string, day: number, data: any): string {
  const inv = JSON.parse(data.agent.inventory) as Record<string, number>;
  const lines = Object.entries(inv)
    .map(([item, qty]) => `${item.padEnd(12)} ${qty} units`)
    .join('\n');
  return `# Inventory -- ${agentName} -- Day ${day}\n\n${lines}\ncoin:         ${data.agent.coin}c\n`;
}

function buildLocationMd(
  agentName: string,
  day: number,
  timeOfDay: string,
  data: any,
  _firstSeenContacts: Array<{ name: string; role: string; location: string }> = [],
): string {
  const chattingNames = new Set<string>();
  const localActiveTalks = Array.isArray(data.localActiveTalks) ? data.localActiveTalks : [];
  for (const interaction of localActiveTalks) {
    chattingNames.add(interaction.fromAgent);
    chattingNames.add(interaction.toAgent);
  }
  const nearbyLines = Array.isArray(data.nearby) && data.nearby.length > 0
    ? data.nearby.map((a: any) => `- ${a.name} (${a.role})${chattingNames.has(a.name) ? ' [CHATTING]' : ''}`).join('\n')
    : '';
  const sections = [
    `# Location -- ${agentName} -- Day ${day}, ${timeOfDay}`,
    '',
    `- current: ${data.agent.location}`,
  ];

  if (nearbyLines) {
    sections.push('');
    sections.push('## nearby');
    sections.push(nearbyLines);
  }

  const reachableLines = Array.isArray(data.reachableLocations) && data.reachableLocations.length > 0
    ? data.reachableLocations.map((name: string) => `- ${name}`).join('\n')
    : '';
  if (reachableLines) {
    sections.push('');
    sections.push('## reachable');
    sections.push(reachableLines);
  }

  if (data.currentChatScene) {
    const partnerSlug = slugifyAgentName(data.currentChatScene.partner);
    sections.push('');
    sections.push('## live_chat');
    sections.push(`- with: ${data.currentChatScene.partner}`);
    sections.push(`- chat_file: world/chat/${partnerSlug}/CHAT.md`);
  }

  return sections.join('\n');
}

function slugifyAgentName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function normalizeLegacyChatTerminology(content: string): string {
  return content
    .replace(/`talk`/g, '`chat`')
    .replace(/`message`/g, '`chat`')
    .replace(/ talk /g, ' chat ')
    .replace(/ message /g, ' chat ')
    .replace(/Use talk for direct communication\./g, 'Use chat for one-to-one communication.')
    .replace(/Use message for direct communication\./g, 'Use chat for one-to-one communication.')
    .replace(/Use talk/g, 'Use chat')
    .replace(/Use message/g, 'Use chat')
    .replace(/active local interaction/g, 'live chat');
}

function buildChatMd(data: any): string {
  const threads = Array.isArray(data.chatThreads) ? data.chatThreads : [];
  const onlineContacts = threads.filter((thread: any) => thread.online);
  const onlineLines = onlineContacts.length === 0
    ? '- (none)'
    : onlineContacts.map((thread: any) => `- ${thread.name}`).join('\n');

  const threadLines = threads.length === 0
    ? '- (none yet)'
    : threads.map((thread: any) =>
        `- ${thread.name} : ${thread.live ? 'LIVE' : thread.online ? 'ONLINE' : 'OFFLINE'} : ${thread.unreadCount} UNREAD : "${thread.preview.slice(0, 80)}" : world/chat/${slugifyAgentName(thread.name)}/CHAT.md`).join('\n');

  return [
    '# Chat',
    '',
    'ONLINE',
    onlineLines,
    '',
    'THREADS',
    threadLines,
    '',
  ].join('\n');
}

function buildChatThreadMd(agentName: string, thread: any): string {
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  const messageLines = messages.length === 0
    ? '- (no messages yet)'
    : messages.map((entry: any) => {
        const speaker = entry.fromAgent === agentName ? 'You' : entry.fromAgent;
        return `- ${speaker}: ${entry.text}`;
      }).join('\n');

  return [
    `# Chat -- ${thread.name}`,
    '',
    `STATUS: ${thread.live ? 'LIVE' : thread.online ? 'ONLINE' : 'OFFLINE'}`,
    `UNREAD: ${thread.unreadCount}`,
    ...(thread.live ? [`TURN: ${thread.yourTurn ? 'YOUR TURN' : `${thread.name}'s TURN`}`] : []),
    ...(thread.interruptionContext?.pending
      ? [
          '',
          'SCENE CONTEXT',
          `- You were about to say: ${thread.interruptionContext.interruptedText}`,
          `- But ${thread.interruptionContext.openingSpeaker} spoke first: ${thread.interruptionContext.openingText}`,
        ]
      : []),
    '',
    'MESSAGES',
    messageLines,
    '',
  ].join('\n');
}

function buildOffersMd(data: any): string {
  const incomingOffers = Array.isArray(data.incomingTransactions) ? data.incomingTransactions : [];
  const outgoingOffers = Array.isArray(data.outgoingTransactions) ? data.outgoingTransactions : [];

  const formatOffer = (txn: any, ref: string) => {
    const offer = JSON.parse(txn.offerJson) as Array<{ item: string; quantity: number }>;
    const request = JSON.parse(txn.requestJson) as Array<{ item: string; quantity: number }>;
    const offerText = offer.length === 0 ? 'nothing' : offer.map((entry) => `${entry.quantity} ${entry.item}`).join(', ');
    const requestText = request.length === 0 ? 'nothing' : request.map((entry) => `${entry.quantity} ${entry.item}`).join(', ');
    return `- ${ref} : ${txn.fromAgent} -> ${txn.toAgent} : ${offerText} for ${requestText}`;
  };

  const incomingLines = incomingOffers.length === 0
    ? ''
    : incomingOffers.map((txn: any) => formatOffer(txn, txn.responseRef)).join('\n');
  const outgoingLines = outgoingOffers.length === 0
    ? ''
    : outgoingOffers.map((txn: any) => formatOffer(txn, txn.txnId)).join('\n');

  const sections = ['# Offers', ''];
  if (incomingLines) {
    sections.push('INCOMING');
    sections.push(incomingLines);
    sections.push('');
  }
  if (outgoingLines) {
    sections.push('OUTGOING');
    sections.push(outgoingLines);
    sections.push('');
  }
  if (!incomingLines && !outgoingLines) {
    sections.push('No pending offers.');
    sections.push('');
  }
  return sections.join('\n');
}

function buildEconomicLocationState(data: any): string {
  const lines: string[] = [];
  const locationType = data.locationDoc?.type;
  if (locationType) {
    lines.push(`  - Location type: ${locationType}`);
  }

  const fieldsHere = Array.isArray(data.fieldsHere) ? data.fieldsHere : [];
  for (const field of fieldsHere) {
    const crop = field.cropItem ?? 'nothing';
    lines.push(`  - Field ${field.fieldKey}: ${field.stage}${field.stage !== 'fallow' ? ` (${crop})` : ''}`);
  }

  const herbPatchesHere = Array.isArray(data.herbPatchesHere) ? data.herbPatchesHere : [];
  for (const patch of herbPatchesHere) {
    lines.push(`  - Herb patch ${patch.patchKey}: ${patch.available}/${patch.maxAvailable} ${patch.herbItem} available`);
  }

  const nearby = Array.isArray(data.nearby) ? data.nearby : [];
  const innkeeperHere = nearby.find((other: any) => other.role === 'Innkeeper') || (data.agent.role === 'Innkeeper' ? data.agent : null);
  if (data.agent.location === 'inn' && innkeeperHere) {
    lines.push('  - Meal service is offered directly through sell when a guest is here and bread and ale stock are available. There is no separate craft action for meals.');
  }

  return lines.length > 0 ? lines.join('\n') : '  (nothing special here)';
}

function buildTradeOpportunitiesSection(data: any): string {
  const opportunities = Array.isArray(data.tradeOpportunities) ? data.tradeOpportunities : [];
  if (opportunities.length === 0) return '';

  return opportunities
    .map((entry: any) => {
      const sells = Array.isArray(entry.likelySells) && entry.likelySells.length > 0
        ? entry.likelySells.join(', ')
        : 'nothing obvious right now';
      const buys = Array.isArray(entry.likelyBuys) && entry.likelyBuys.length > 0
        ? entry.likelyBuys.join(', ')
        : 'nothing obvious right now';
      return `  - ${entry.name} (${entry.role}): likely sells ${sells}; likely buys ${buys}`;
    })
    .join('\n');
}

function buildVillageNewsMd(day: number, data: any): string {
  const eventLines = data.events.length === 0
    ? ''
    : data.events.map((e: any) => `  - ${e.description}`).join('\n');

  const mentionLines = data.mentions.length === 0
    ? ''
    : data.mentions.map((m: any) => `  - ${m.agentName} ${m.action}${m.target ? ` → ${m.target}` : ''}${m.message ? `: "${m.message}"` : ''}`).join('\n');
  const sections = [`# Village News -- Day ${day}`, ''];
  if (eventLines) {
    sections.push('Events:');
    sections.push(eventLines);
    sections.push('');
  }
  if (mentionLines) {
    sections.push('You were mentioned:');
    sections.push(mentionLines);
    sections.push('');
  }
  if (!eventLines && !mentionLines) {
    sections.push('No notable village updates right now.');
    sections.push('');
  }
  return sections.join('\n');
}

function buildMarketPricesMd(day: number, data: any): string {
  const prices = data.prices as any[];
  const header = `# Rocklaw Market -- Day ${day}\n\n${'Item'.padEnd(14)}${'Price'.padEnd(9)}${'Change'.padEnd(10)}Note`;
  const rows = prices.map((p: any) => {
    const changeStr = p.changePct === 0 ? 'stable' : `${p.changePct > 0 ? '+' : ''}${Math.round(p.changePct)}%`;
    const noteStr = p.shortageLevel !== 'none' ? `${p.shortageLevel.toUpperCase()} shortage` : '';
    return `${p.item.padEnd(14)}${String(p.price + 'c').padEnd(9)}${changeStr.padEnd(10)}${noteStr}`;
  });

  const alerts = prices.filter((p: any) => p.shortageLevel !== 'none');
  const alertLines = alerts.length === 0
    ? ''
    : alerts.map((p: any) => `  ! ${p.item}: ${p.shortageLevel.toUpperCase()}`).join('\n');

  const tradeLogs = data.recentTrades as any[];
  const tradeLines = tradeLogs.length === 0
    ? ''
    : tradeLogs.map((t: any) => `  - ${t.agentName} ${t.action} ${t.target ?? ''} (Day ${t.day})`).join('\n');

  const sections = [header, rows.join('\n'), ''];
  if (alertLines) {
    sections.push('Shortage alerts:');
    sections.push(alertLines);
    sections.push('');
  }
  if (tradeLines) {
    sections.push('Recent trades:');
    sections.push(tradeLines);
    sections.push('');
  }
  return sections.join('\n');
}

function buildStatusMd(agentName: string, day: number, timeOfDay: string, data: any): string {
  const { energy, health, hunger } = data.agent;
  const energyLabel = energy < 15 ? '[EXHAUSTED -- demanding actions will FAIL until you rest]'
    : energy < 30 ? '[CRITICAL -- rest before demanding work]'
    : energy < 50 ? '[low -- demanding actions may fail]'
    : '[fine]';
  const healthLabel = health < 30 ? '[POOR -- you need treatment urgently]'
    : health < 70 ? '[injured -- take care of yourself]'
    : '[fine]';
  const hungerLabel = hunger > 80 ? '[STARVING -- health will degrade if you don\'t eat]'
    : hunger > 60 ? '[hungry -- eat soon]'
    : hunger > 40 ? '[getting hungry]'
    : '[fine]';

  const conditions: string[] = [];
  if (energy === 0) conditions.push('Sustained exhaustion: health is degrading each tick. SLEEP NOW.');
  if (health < 30) conditions.push('Poor health: your body is failing. Seek treatment and rest.');
  if (hunger > 80) conditions.push('Starving: health will degrade until you eat.');
  const conditionLine = conditions.length === 0 ? 'none' : conditions.map((c) => `  ! ${c}`).join('\n');

  const repScore = data.reputation?.score ?? 50;
  const repLabel = repScore >= 70 ? '[RESPECTED -- you receive discounts and open doors]'
    : repScore >= 50 ? '[neutral]'
    : repScore >= 30 ? '[mixed -- some distrust you]'
    : repScore >= 20 ? '[poor -- merchants charge you more]'
    : '[NOTORIOUS -- you will be refused service at inn, shrine, and market]';
  const repWarning = repScore < 20
    ? '\n  ! Your reputation is too low for service at social locations. Improve it through helpful actions.'
    : repScore < 30
    ? '\n  ! Low reputation: you pay 10% more at market. Help others to improve your standing.'
    : '';

  const economicNeeds = buildEconomicNeeds(data);
  const hasEconomicNeeds = economicNeeds !== '  (no urgent economic pressure right now)';

  const sections = [
    `# Status -- ${agentName} -- Day ${day}, ${timeOfDay}`,
    '',
    `Energy:     ${energy}/100  ${energyLabel}`,
    `Health:     ${health}/100  ${healthLabel}`,
    `Hunger:     ${hunger}/100  ${hungerLabel}`,
    `Reputation: ${repScore}/100  ${repLabel}${repWarning}`,
    '',
    `Conditions: ${conditionLine}`,
    '',
  ];
  if (hasEconomicNeeds) {
    sections.push('Economic pressure:');
    sections.push(economicNeeds);
    sections.push('');
  }
  return sections.join('\n');
}

function buildEconomicNeeds(data: any): string {
  const notes: string[] = [];
  const prices = Array.isArray(data.prices) ? data.prices : [];
  const shortageItems = prices.filter((price: any) => price.shortageLevel === 'critical').map((price: any) => price.item);
  if (shortageItems.length > 0) {
    notes.push(`  - Village shortages are strongest in: ${shortageItems.join(', ')}.`);
  }
  if (data.agent.hunger > 40) {
    notes.push('  - Food demand matters to you right now; buying or producing food is becoming more urgent.');
  }
  if (data.agent.health < 70) {
    notes.push('  - Medicine and herbs matter more while your health is low.');
  }
  if (data.agent.role === 'Blacksmith') {
    notes.push('  - Ore and coal shortages directly constrain your production.');
  }
  if (data.agent.role === 'Innkeeper') {
    notes.push('  - Meal service uses `chat` with `intent:"sell"` and `item:"meal"` when a guest is here and bread and ale stock are available. Do not try to craft meals as inventory items.');
  }
  return notes.length > 0 ? notes.join('\n') : '  (no urgent economic pressure right now)';
}

function buildTemporaryActionsSection(timeOfDay: string, data: any): string {
  if (data.currentChatScene) {
    const partner = data.currentChatScene.partner;
    const incomingOffers = Array.isArray(data.incomingTransactions)
      ? data.incomingTransactions.filter((txn: any) => txn.fromAgent === partner)
      : [];
    return [
      '## Temporary actions available now',
      '',
      `- \`chat\`: continue your live chat with ${partner}.`,
      `  Example JSON: \`{"action":"chat","target":"${partner}","text":"I hear you.","duration_ticks":1}\``,
      `- \`chat\` + \`intent\`: use structured commerce through chat while speaking naturally to ${partner}.`,
      `  Example JSON: \`{"action":"chat","target":"${partner}","text":"I can sell you one horseshoe for 35 coin.","intent":"sell","item":"horseshoe","quantity":1,"amount":35,"duration_ticks":1}\``,
      `  Example JSON: \`{"action":"chat","target":"${partner}","text":"I can swap two coal for four grain.","intent":"trade","offer":[{"item":"coal","quantity":2}],"request":[{"item":"grain","quantity":4}],"duration_ticks":1}\``,
      ...(incomingOffers.length > 0
        ? [
            '- `chat` + `intent:"accept_transaction"` or `intent:"reject_transaction"`: respond to a pending offer from the person you are currently chatting with.',
            '  Example JSON: `{"action":"chat","target":"' + partner + '","text":"Agreed.","intent":"accept_transaction","offer_ref":"offer-1","duration_ticks":1,"thought":"The offer is fair."}`',
          ]
        : []),
      '- `leave_chat`: leave the live chat. You may include `text` for a final goodbye line, then you will return to normal world actions on the next tick.',
      '  Example JSON: `{"action":"leave_chat","text":"All right, goodbye for now.","duration_ticks":1,"thought":"I should end this conversation and get back to work."}`',
      '',
    ].join('\n');
  }

  const sections: string[] = [];

  if (data.agent.energy < 60) {
    sections.push(
      '- `rest`: take a short break to recover.',
      '  Example JSON: `{"action":"rest","duration_ticks":1,"thought":"A short break will help me recover before harder work."}`',
    );
  }

  if (timeOfDay === 'evening' || data.agent.energy < 20) {
    sections.push(
      '- `sleep`: stop for proper sleep and recover more deeply.',
      '  Example JSON: `{"action":"sleep","duration_ticks":1,"thought":"It is time to sleep and recover fully."}`',
    );
  }

  if (sections.length === 0) return '';

  return [
    '## Temporary actions available now',
    '',
    ...sections,
    '',
  ].join('\n');
}

function buildEconomicActionsSection(data: any): string {
  if (data.currentChatScene) {
    const partner = data.currentChatScene.partner;
    const incomingOffers = Array.isArray(data.incomingTransactions)
      ? data.incomingTransactions.filter((txn: any) => txn.fromAgent === partner)
      : [];
    const available = [
      { action: 'chat + intent:"buy"', detail: `Make a direct buy offer to ${partner} inside this live chat.` },
      { action: 'chat + intent:"sell"', detail: `Make a direct sell offer to ${partner} inside this live chat.` },
      { action: 'chat + intent:"trade"', detail: `Propose a barter trade with ${partner} inside this live chat.` },
      { action: 'chat + intent:"give"', detail: `Hand goods directly to ${partner} while this live chat is active.` },
      { action: 'chat + intent:"pay"', detail: `Pay coin directly to ${partner} while this live chat is active.` },
      ...(incomingOffers.length > 0
        ? [
            { action: 'chat + intent:"accept_transaction"', detail: `Respond to ${partner}'s pending offer using offer_ref from OFFERS.md.` },
            { action: 'chat + intent:"reject_transaction"', detail: `Decline ${partner}'s pending offer using offer_ref from OFFERS.md.` },
          ]
        : []),
    ];
    return [
      '## Economic actions right now',
      '',
      '### Available in this live chat',
      available.map((entry: any) => `- \`${entry.action}\`: ${entry.detail}`).join('\n'),
      '',
    ].join('\n');
  }

  const entries = Array.isArray(data.economicSurface) ? data.economicSurface : [];
  const available = entries.filter((entry: any) => entry.status === 'available');
  const formatLines = (list: any[]) => list.map((entry: any) => `- \`${entry.action}\`: ${entry.detail}`).join('\n');
  if (available.length === 0) return '';

  return [
    '## Economic actions right now',
    '',
    '### Available actions',
    formatLines(available),
    '',
  ].join('\n');
}

async function refreshRuntimeToolsMd(workspaceDir: string, timeOfDay: string, data: any): Promise<void> {
  const runtimePath = path.join(workspaceDir, 'TOOLS.md');
  const actions: Array<{ name: string; meaning: string; example: string }> = [];
  const inLiveChat = Boolean(data.currentChatScene);
  const canChatNow = Array.isArray(data.nearby) && data.nearby.length > 0;
  const role = data.agent?.role as string;
  const inv = JSON.parse(data.agent.inventory ?? '{}') as Record<string, number>;

  if (inLiveChat) {
    const partner = data.currentChatScene.partner;
    actions.push({
      name: 'chat',
      meaning: `Continue speaking with ${partner}.`,
      example: `{"action":"chat","target":"${partner}","text":"I hear you.","duration_ticks":1}`,
    });
    actions.push({
      name: 'chat + intent',
      meaning: 'Run in-chat commerce (buy/sell/trade/give/pay) with the same partner.',
      example: `{"action":"chat","target":"${partner}","text":"I can sell one horseshoe for 35 coin.","intent":"sell","item":"horseshoe","quantity":1,"amount":35,"duration_ticks":1}`,
    });
    if (Array.isArray(data.incomingTransactions) && data.incomingTransactions.some((txn: any) => txn.fromAgent === partner)) {
      actions.push({
        name: 'chat + intent accept/reject',
        meaning: 'Accept or reject a pending offer from the current chat partner.',
        example: `{"action":"chat","target":"${partner}","text":"Agreed.","intent":"accept_transaction","offer_ref":"offer-1","duration_ticks":1}`,
      });
    }
    actions.push({
      name: 'leave_chat',
      meaning: 'Leave the current live chat scene.',
      example: `{"action":"leave_chat","text":"Goodbye for now.","duration_ticks":1}`,
    });
  } else {
    actions.push({
      name: 'move',
      meaning: 'Move to a reachable location listed in world/location.md.',
      example: `{"action":"move","location":"market","duration_ticks":1}`,
    });
    actions.push({
      name: 'say',
      meaning: 'Speak locally at your current location.',
      example: `{"action":"say","text":"Fresh bread is ready.","duration_ticks":1}`,
    });
    if (canChatNow) {
      actions.push({
        name: 'chat',
        meaning: 'Start one-to-one chat with someone nearby.',
        example: `{"action":"chat","target":"Marcus Hale","text":"Need coal by Day 9.","duration_ticks":1}`,
      });
    }
    if (Object.keys(inv).some((item) => ['bread', 'meal', 'ale', 'grain', 'vegetables'].includes(item) && (inv[item] ?? 0) > 0)) {
      actions.push({
        name: 'eat',
        meaning: 'Consume edible inventory to reduce hunger.',
        example: `{"action":"eat","item":"bread","quantity":1,"duration_ticks":1}`,
      });
    }
    if (data.agent.energy < 60) {
      actions.push({
        name: 'rest',
        meaning: 'Recover energy with a short break.',
        example: `{"action":"rest","duration_ticks":1}`,
      });
    }
    if (timeOfDay === 'evening' || data.agent.energy < 20) {
      actions.push({
        name: 'sleep',
        meaning: 'Recover deeply through sleep.',
        example: `{"action":"sleep","duration_ticks":1}`,
      });
    }
    const availableEconomic = Array.isArray(data.economicSurface)
      ? data.economicSurface.filter((entry: any) => entry.status === 'available')
      : [];
    for (const entry of availableEconomic) {
      const actionName = String(entry.action ?? '').trim();
      if (!actionName || actionName.startsWith('chat +')) continue;
      actions.push({
        name: actionName,
        meaning: String(entry.detail ?? 'Economic action available now.'),
        example: `{"action":"${actionName}","duration_ticks":1}`,
      });
    }
    if (role === 'Priest') {
      actions.push({
        name: 'pray',
        meaning: 'Offer a spoken prayer into the world.',
        example: `{"action":"pray","text":"May this village be kept in peace.","duration_ticks":1}`,
      });
    }
    if (role === 'Child') {
      actions.push({
        name: 'play',
        meaning: 'Play to spend the tick as a child role action.',
        example: `{"action":"play","duration_ticks":1}`,
      });
    }
  }

  const deduped = new Set<string>();
  const actionLines = actions
    .filter((entry) => {
      const key = entry.name.toLowerCase();
      if (deduped.has(key)) return false;
      deduped.add(key);
      return true;
    })
    .map((entry) => [
      `- \`${entry.name}\``,
      `  meaning: ${entry.meaning}`,
      `  example: \`${entry.example}\``,
    ].join('\n'))
    .join('\n\n');

  const content = ['# Actions', '', actionLines, ''].join('\n');
  await fs.writeFile(runtimePath, content, 'utf8');
}

async function refreshRuntimeAgentsMd(workspaceDir: string, data: any): Promise<void> {
  const backupPath = path.join(workspaceDir, 'state', 'seeded_docs', 'AGENTS.md');
  const runtimePath = path.join(workspaceDir, 'AGENTS.md');
  const canChatNow = Array.isArray(data.nearby) && data.nearby.length > 0;

  let template = '';
  try {
    template = await fs.readFile(backupPath, 'utf8');
  } catch {
    template = await fs.readFile(runtimePath, 'utf8');
  }

  let content = template;
  const actionProfile = buildRuntimeAgentActionProfile(data, canChatNow);
  content = content.replace(
    /For local scenes:[^\n]*/,
    actionProfile.localScenesLine,
  );
  content = content.replace(
    /Examples:\n[\s\S]*?\n\nValid actions:/,
    `Examples:\n${actionProfile.examples.join('\n')}\n\nValid actions:`,
  );
  content = content.replace(
    /Valid actions:[\s\S]*?Check TOOLS\.md for the actions available to you right now\./,
    `${actionProfile.validActions}\n\nCheck TOOLS.md for the actions available to you right now.`,
  );
  content = normalizeLegacyChatTerminology(content)
    .replace(/Check world\/location\.md -- it also lists any letters waiting for you here\.\n/g, '')
    .replace(/self\/messages\/\s+-- your correspondence\n/g, 'world/CHAT.md                 -- your chat threads and unread messages\nworld/OFFERS.md               -- your incoming and outgoing offers\n');

  await fs.writeFile(runtimePath, content, 'utf8');
}

function buildRuntimeAgentActionProfile(data: any, canChatNow: boolean) {
  if (data.currentChatScene) {
    const partner = data.currentChatScene.partner;
    return {
      localScenesLine: `You are currently in a live chat scene with ${partner}. Refer to TOOLS.md for what you can do right now and the exact JSON fields.`,
      examples: [
        '- Use TOOLS.md as the source of truth for currently valid actions and JSON examples.',
      ],
      validActions: 'Valid actions are listed in TOOLS.md for this tick.',
    };
  }

  const localScenesLine = canChatNow
    ? 'Use chat for one-to-one communication when someone is nearby. Refer to TOOLS.md for currently valid actions and exact JSON.'
    : 'No one is nearby for live chat right now. Refer to TOOLS.md for currently valid actions and exact JSON.';

  return {
    localScenesLine,
    examples: ['- Use TOOLS.md as the source of truth for currently valid actions and JSON examples.'],
    validActions: 'Valid actions are listed in TOOLS.md for this tick.',
  };
}

async function refreshRuntimeSkillMds(workspaceDir: string, data: any): Promise<void> {
  const skillsRoot = path.join(workspaceDir, 'skills');
  const backupRoot = path.join(workspaceDir, 'state', 'seeded_skills');
  const canChatNow = Array.isArray(data.nearby) && data.nearby.length > 0;

  let skillPaths: string[] = [];
  try {
    skillPaths = await collectFiles(backupRoot, 'SKILL.md');
  } catch {
    return;
  }

  await Promise.all(skillPaths.map(async (backupPath) => {
    const rel = path.relative(backupRoot, backupPath);
    const runtimePath = path.join(skillsRoot, rel);
    let content = await fs.readFile(backupPath, 'utf8');

    content = normalizeLegacyChatTerminology(content)
      .replace(/message-passing/g, 'direct one-person messaging')
      .replace(/pass along lodging or meeting information\./g, 'send a direct one-person update to someone you already know. Do not broadcast to the whole village.')
      .replace(/leave terms when someone is away\./g, 'send direct one-person trade terms to a known contact when they are away.')
      .replace(/pass on instructions when someone is not here\./g, 'send a direct one-person instruction or update to someone you already know when they are away.');
    if (!canChatNow) {
      content = content
        .replace(/^-\sWhen someone is present and `message` is available in TOOLS\.md,.*\n/gm, '')
        .replace(/^-\sWhen someone is present and `chat` is available in TOOLS\.md,.*\n/gm, '');
    }

    await fs.mkdir(path.dirname(runtimePath), { recursive: true });
    await fs.writeFile(runtimePath, content, 'utf8');
  }));
}

async function collectFiles(rootDir: string, filename: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const results = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) return collectFiles(fullPath, filename);
    return entry.isFile() && entry.name === filename ? [fullPath] : [];
  }));
  return results.flat();
}

async function writeFile(dir: string, filename: string, content: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), content, 'utf8');
}

async function writeChatThreads(worldDir: string, data: any): Promise<void> {
  const threads = Array.isArray(data.chatThreads) ? data.chatThreads : [];
  const chatRoot = path.join(worldDir, 'chat');
  await fs.mkdir(chatRoot, { recursive: true });

  await Promise.all(threads.map(async (thread: any) => {
    const threadDir = path.join(chatRoot, slugifyAgentName(thread.name));
    await fs.mkdir(threadDir, { recursive: true });
    await fs.writeFile(
      path.join(threadDir, 'CHAT.md'),
      buildChatThreadMd(data.agent.name, thread),
      'utf8',
    );
  }));
}

async function ensureWorkspaceScaffold(workspaceDir: string): Promise<void> {
  const worldChatDir = path.join(workspaceDir, 'world', 'chat');
  await fs.mkdir(worldChatDir, { recursive: true });
}

async function ensureFile(filePath: string, content: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, content, 'utf8');
  }
}

function resolveWorkspacePath(workspacePath: string): string {
  if (path.isAbsolute(workspacePath)) return workspacePath;
  const root = process.env.ROCKLAW_PROJECT_ROOT || process.cwd();
  return path.resolve(root, workspacePath);
}
