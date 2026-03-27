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
  firstSeenContacts: Array<{ name: string; role: string; location: string }> = [],
): string {
  const localActiveTalks = Array.isArray(data.localActiveTalks) ? data.localActiveTalks : [];
  const chattingNames = new Set<string>();
  for (const interaction of localActiveTalks) {
    chattingNames.add(interaction.fromAgent);
    chattingNames.add(interaction.toAgent);
  }
  const nearbyLines = data.nearby.length === 0
    ? '  (nobody nearby)'
    : data.nearby.map((a: any) => `  - ${a.name} (${a.role})${chattingNames.has(a.name) ? ' [CHATTING]' : ''}`).join('\n');

  const board = data.locationDoc?.messageBoard
    ? JSON.parse(data.locationDoc.messageBoard) as string[]
    : [];
  const boardLines = board.length === 0
    ? '  (none)'
    : board.map((m: string) => `  - ${m}`).join('\n');

  const sections = [
    `# Location -- ${agentName} -- Day ${day}, ${timeOfDay}`,
    '',
    `Current: ${data.agent.location}`,
    '',
    '## Place',
    'Economic stations and resources here:',
    buildEconomicLocationState(data),
    '',
    '## Live Now',
    'Possible trade partners here:',
    buildTradeOpportunitiesSection(data),
    '',
    'Nearby:',
    nearbyLines,
    '',
    'Message board:',
    boardLines,
    '',
  ];

  const incomingOffers = Array.isArray(data.incomingTransactions) ? data.incomingTransactions : [];
  const incomingOfferLines = incomingOffers.length === 0
    ? '  (none)'
    : incomingOffers.map((txn: any) => {
        const offer = JSON.parse(txn.offerJson) as Array<{ item: string; quantity: number }>;
        const request = JSON.parse(txn.requestJson) as Array<{ item: string; quantity: number }>;
        const offerText = offer.length === 0 ? 'nothing' : offer.map((entry) => `${entry.quantity} ${entry.item}`).join(', ');
        const requestText = request.length === 0 ? 'nothing' : request.map((entry) => `${entry.quantity} ${entry.item}`).join(', ');
        const locationNote = txn.proposerLocation === data.agent.location
          ? ''
          : ` [${txn.fromAgent} is no longer here]`;
        const messageNote = txn.message ? ` -- "${txn.message}"` : '';
        return `  - ${txn.responseRef}: ${txn.fromAgent} ${txn.kind}s with you: offers ${offerText} for ${requestText}${locationNote}${messageNote}`;
      }).join('\n');
  sections.push('Pending offers awaiting your decision:');
  sections.push(incomingOfferLines);
  sections.push('  Respond to these with `chat` plus `intent:"accept_transaction"` or `intent:"reject_transaction"` only while you are already in a live chat with the offer sender and they are still here.');
  sections.push('');

  const outgoingOffers = Array.isArray(data.outgoingTransactions) ? data.outgoingTransactions : [];
  const outgoingOfferLines = outgoingOffers.length === 0
    ? '  (none)'
    : outgoingOffers.map((txn: any) => {
        const offer = JSON.parse(txn.offerJson) as Array<{ item: string; quantity: number }>;
        const request = JSON.parse(txn.requestJson) as Array<{ item: string; quantity: number }>;
        const offerText = offer.length === 0 ? 'nothing' : offer.map((entry) => `${entry.quantity} ${entry.item}`).join(', ');
        const requestText = request.length === 0 ? 'nothing' : request.map((entry) => `${entry.quantity} ${entry.item}`).join(', ');
        const locationNote = txn.recipientLocation === data.agent.location
          ? ''
          : ` [${txn.toAgent} is no longer here]`;
        const messageNote = txn.message ? ` -- "${txn.message}"` : '';
        return `  - ${txn.txnId}: you ${txn.kind} ${txn.toAgent}: offers ${offerText} for ${requestText}${locationNote}${messageNote}`;
      }).join('\n');
  sections.push('Your outgoing offers:');
  sections.push(outgoingOfferLines);
  sections.push('  These are your offers. Do not accept or reject them yourself. Chat, move, or make a different offer instead.');
  sections.push('');

  const activeInteractions = Array.isArray(data.activeInteractions) ? data.activeInteractions : [];
  const interactionLines = activeInteractions.length === 0
    ? '  (none)'
    : activeInteractions.map((interaction: any) => {
        const payload = interaction.payloadJson
          ? JSON.parse(interaction.payloadJson) as {
              text?: string;
              message?: string;
              offer?: Array<{ item: string; quantity: number }>;
              request?: Array<{ item: string; quantity: number }>;
              deferredReplyText?: string;
              deferredReplyFrom?: string;
            }
          : {};
        const locationNote = interaction.counterpartLocation === data.agent.location
          ? ''
          : ` [${interaction.counterpart} is no longer here]`;
        if (interaction.kind === 'talk') {
          const text = payload.text ?? payload.message ?? '(no text)';
          const deferredNote =
            interaction.toAgent === data.agent.name && payload.deferredReplyText && payload.deferredReplyFrom === data.agent.name
              ? ` | Your deferred opener: "${payload.deferredReplyText}"`
              : '';
          return `  - ${interaction.fromAgent} is addressing ${interaction.toAgent}: "${text}"${locationNote}${deferredNote}`;
        }
        const offer = Array.isArray(payload.offer) ? payload.offer : [];
        const request = Array.isArray(payload.request) ? payload.request : [];
        const offerText = offer.length === 0 ? 'nothing' : offer.map((entry) => `${entry.quantity} ${entry.item}`).join(', ');
        const requestText = request.length === 0 ? 'nothing' : request.map((entry) => `${entry.quantity} ${entry.item}`).join(', ');
        const messageNote = payload.message ? ` -- "${payload.message}"` : '';
        return `  - ${interaction.fromAgent} ${interaction.kind}s ${interaction.toAgent}: offers ${offerText} for ${requestText}${locationNote}${messageNote}`;
      }).join('\n');

  sections.push('Active interactions here:');
  sections.push(interactionLines);
  sections.push('');

  const liveChatLines = localActiveTalks.length === 0
    ? '  (none)'
    : localActiveTalks.map((interaction: any) => `  - ${interaction.fromAgent} and ${interaction.toAgent} are chatting.`).join('\n');
  sections.push('People chatting here:');
  sections.push(liveChatLines);
  sections.push('');

  if (data.currentChatScene) {
    sections.push('Your live chat:');
    sections.push(`  - With ${data.currentChatScene.partner} at ${data.currentChatScene.location} [${data.currentChatScene.yourTurn ? 'YOUR TURN' : `${data.currentChatScene.partner}'s turn`}]`);
    if (data.currentChatScene.interruptionContext) {
      sections.push(`  - You were about to say: "${data.currentChatScene.interruptionContext.interruptedText}"`);
      sections.push(`  - But ${data.currentChatScene.interruptionContext.openingSpeaker} spoke first: "${data.currentChatScene.interruptionContext.openingText}"`);
    }
    sections.push('');
  }

  const recentLocalSpeech = Array.isArray(data.recentLocalSpeech) ? data.recentLocalSpeech : [];
  const localSpeechLines = recentLocalSpeech.length === 0
    ? '  (none)'
    : recentLocalSpeech.map((entry: any) => `  - ${entry.agentName}: "${entry.message ?? '(no text)'}"`).join('\n');
  sections.push('Recent local speech:');
  sections.push(localSpeechLines);
  sections.push('');

  const firstSeenLines = firstSeenContacts.length === 0
    ? '  (none)'
    : firstSeenContacts.map((contact) => `  - You notice someone here for the first time: ${contact.name} (${contact.role}).`).join('\n');
  sections.push('First seen here:');
  sections.push(firstSeenLines);
  sections.push('');

  if (data.agent.pendingNote) {
    sections.push('Recent changes:');
    sections.push(`  ${data.agent.pendingNote}`);
    sections.push('');
  }

  sections.push('## Navigation');
  sections.push('Reachable places now:');
  sections.push(
    Array.isArray(data.reachableLocations) && data.reachableLocations.length > 0
      ? data.reachableLocations.map((name: string) => `  - ${name}`).join('\n')
      : '  (none)',
  );
  sections.push('');

  return sections.join('\n');
}

function slugifyAgentName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
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
    ? '- (none)'
    : incomingOffers.map((txn: any) => formatOffer(txn, txn.responseRef)).join('\n');
  const outgoingLines = outgoingOffers.length === 0
    ? '- (none)'
    : outgoingOffers.map((txn: any) => formatOffer(txn, txn.txnId)).join('\n');

  return [
    '# Offers',
    '',
    'INCOMING',
    incomingLines,
    '',
    'OUTGOING',
    outgoingLines,
    '',
  ].join('\n');
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
  if (opportunities.length === 0) return '  (none)';

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
    ? '  Nothing unusual to report.'
    : data.events.map((e: any) => `  - ${e.description}`).join('\n');

  const mentionLines = data.mentions.length === 0
    ? '  - Nothing yet.'
    : data.mentions.map((m: any) => `  - ${m.agentName} ${m.action}${m.target ? ` → ${m.target}` : ''}${m.message ? `: "${m.message}"` : ''}`).join('\n');

  return [
    `# Village News -- Day ${day}`,
    '',
    eventLines,
    '',
    'You were mentioned:',
    mentionLines,
    '',
  ].join('\n');
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
    ? '  (none)'
    : alerts.map((p: any) => `  ! ${p.item}: ${p.shortageLevel.toUpperCase()}`).join('\n');

  const tradeLogs = data.recentTrades as any[];
  const tradeLines = tradeLogs.length === 0
    ? '  (none yet)'
    : tradeLogs.map((t: any) => `  - ${t.agentName} ${t.action} ${t.target ?? ''} (Day ${t.day})`).join('\n');

  return [header, rows.join('\n'), '', 'Shortage alerts:', alertLines, '', 'Recent trades:', tradeLines, ''].join('\n');
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

  const affordances: string[] = [];
  if (data.currentChatScene) {
    affordances.push(`  - chat: continue your live chat with ${data.currentChatScene.partner}.`);
    affordances.push(`  - chat intent: if you want to buy, sell, trade, give, pay, accept, or reject inside this scene, keep action:"chat" and add intent plus the relevant fields.`);
    if (Array.isArray(data.incomingTransactions) && data.incomingTransactions.some((txn: any) => txn.fromAgent === data.currentChatScene.partner)) {
      affordances.push(`  - offer_ref: use it on chat intent:"accept_transaction" or intent:"reject_transaction" while you remain in this live chat.`);
    }
    affordances.push('  - leave_chat: leave the live chat and return to the world on the next tick.');
  } else {
    if (energy < 60) {
      affordances.push(`  - rest: available now because your energy is ${energy}/100.`);
    }
    if (timeOfDay === 'evening') {
      affordances.push('  - sleep: available now because it is evening.');
    } else if (energy < 20) {
      affordances.push(`  - sleep: available now because your energy is critically low (${energy}/100).`);
    }
  }
  const affordanceLines = affordances.length === 0 ? '  (none)' : affordances.join('\n');
  const economicNeeds = buildEconomicNeeds(data);

  return [
    `# Status -- ${agentName} -- Day ${day}, ${timeOfDay}`,
    '',
    `Energy:     ${energy}/100  ${energyLabel}`,
    `Health:     ${health}/100  ${healthLabel}`,
    `Hunger:     ${hunger}/100  ${hungerLabel}`,
    `Reputation: ${repScore}/100  ${repLabel}${repWarning}`,
    '',
    `Conditions: ${conditionLine}`,
    '',
    'Economic pressure:',
    economicNeeds,
    '',
    'Action affordances:',
    affordanceLines,
    '',
  ].join('\n');
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
  const incomingOffers = Array.isArray(data.incomingTransactions) ? data.incomingTransactions : [];
  const available = entries.filter((entry: any) => entry.status === 'available');
  const unavailable = entries.filter((entry: any) => entry.status === 'unavailable');

  if (incomingOffers.length > 0) {
    unavailable.unshift({
      action: 'chat + intent:"accept_transaction"',
      detail: 'Unavailable here. Open a live chat with the offer sender first, then respond inside that scene.',
    });
    unavailable.unshift({
      action: 'chat + intent:"reject_transaction"',
      detail: 'Unavailable here. Open a live chat with the offer sender first, then respond inside that scene.',
    });
  }

  const formatLines = (list: any[]) =>
    list.length === 0
      ? '  (none)'
      : list.map((entry: any) => `- \`${entry.action}\`: ${entry.detail}`).join('\n');

  return [
    '## Economic actions right now',
    '',
    '### Available now',
    formatLines(available),
    '',
    '### Unavailable here',
    formatLines(unavailable),
    '',
  ].join('\n');
}

async function refreshRuntimeToolsMd(workspaceDir: string, timeOfDay: string, data: any): Promise<void> {
  const backupPath = path.join(workspaceDir, 'state', 'seeded_docs', 'TOOLS.md');
  const runtimePath = path.join(workspaceDir, 'TOOLS.md');

  let template = '';
  try {
    template = await fs.readFile(backupPath, 'utf8');
  } catch {
    template = await fs.readFile(runtimePath, 'utf8');
  }

  const temporarySection = buildTemporaryActionsSection(timeOfDay, data);
  const economicSection = buildEconomicActionsSection(data);
  const canChatNow = Array.isArray(data.nearby) && data.nearby.length > 0;
  const inLiveChat = Boolean(data.currentChatScene);
  const chatBlock = canChatNow
    ? [
        '- `chat`: use `target` and `text`; if the other person is here it becomes a live chat, otherwise it becomes a deferred chat in their CHAT thread',
        '  Example JSON: `{"action":"chat","target":"Marcus Hale","text":"I need coal by Day 9.","duration_ticks":1}`',
      ].join('\n')
    : '';
  const sayBlock = [
    '- `say`: use `text` to speak out loud in your current location. This is local speech, not a thread, and it does not take a target.',
    '  Example JSON: `{"action":"say","text":"Fresh bread is ready at the inn.","duration_ticks":1}`',
  ].join('\n');
  const moveBlock = [
    '- `move`: use `location` and choose only from `Reachable places now` in `world/location.md`',
    '  Example JSON: `{"action":"move","location":"market","duration_ticks":1}`',
  ].join('\n');
  let content = template
    .replace(/- `talk`: use `target` and `text`; this creates an active local interaction if the other person is here\n\s*Example JSON: `\{"action":"talk","target":"Marcus Hale","text":"I need coal by Day 9\.","duration_ticks":1\}`/, chatBlock)
    .replace(/- `message`: use `target` and `text`; if the other person is here it becomes a live chat, otherwise it becomes a deferred message in their CHAT thread\n\s*Example JSON: `\{"action":"message","target":"Marcus Hale","text":"I need coal by Day 9\.","duration_ticks":1\}`/, chatBlock)
    .replace(/- `chat`: use `target` and `text`; if the other person is here it becomes a live chat, otherwise it becomes a deferred chat in their CHAT thread\n\s*Example JSON: `\{"action":"chat","target":"Marcus Hale","text":"I need coal by Day 9\.","duration_ticks":1\}`/, chatBlock)
    .replace('- `move`: use `location`\n  Example JSON: `{"action":"move","location":"market","duration_ticks":1}`', moveBlock)
    .replace(/## Economic actions[\s\S]*?## Act in the world\n\n/, `${economicSection}## Act in the world\n\n`)
    .replace(/## Innkeeper skills[\s\S]*$/m, `## Innkeeper skills\n\n- Use \`chat\` first to open a live conversation with a guest. Structured commerce is only valid while that live chat is active.\n\n- There is no separate \`craft\` action for meals. Meal service happens through \`chat\` with \`intent:"sell"\` and \`item:"meal"\` while you are already chatting live with the guest.\n\n- Example JSON: \`{"action":"chat","target":"Old Rook","text":"A hot meal is ready if you want one.","intent":"sell","item":"meal","quantity":1,"amount":8,"duration_ticks":1}\`\n`)
    .replace(/## Priest skills[\s\S]*?(?=\n## |\n$)/m, `## Priest skills\n\n- Use \`chat\` to offer blessings, guidance, or comfort directly to one person.\n  Example JSON: \`{"action":"chat","target":"Lena Marsh","text":"May peace and health be upon you, child.","duration_ticks":1,"thought":"Offer a blessing through direct chat."}\`\n\n- Use \`pray\` for prayers spoken into the world.\n  Example JSON: \`{"action":"pray","text":"May this village be kept in peace.","duration_ticks":1,"thought":"Offer a prayer for the village."}\`\n\n- If you want to hand supplies to someone, open a live chat first. \`give\` is only valid inside that chat scene.\n`)
    .replace(/## Merchant skills[\s\S]*$/m, `## Merchant skills\n\n- Use \`chat\` first to open a live conversation. Direct commerce is only valid while you are already in a live chat with that same person.\n\n- Once the live chat is open, use \`chat\` with \`intent:"buy"\` to make an in-person offer for stock.\n  Example JSON: \`{"action":"chat","target":"Finn","text":"I can offer 24 coin for four grain.","intent":"buy","item":"grain","quantity":4,"amount":24,"duration_ticks":1}\`\n\n- Use \`chat\` with \`intent:"sell"\` to move inventory directly while that live chat is active.\n  Example JSON: \`{"action":"chat","target":"Elena Voss","text":"I can sell you three coal for 12 coin.","intent":"sell","item":"coal","quantity":3,"amount":12,"duration_ticks":1}\`\n\n- Use \`chat\` with \`intent:"trade"\` when a direct swap will close faster than coin.\n  Example JSON: \`{"action":"chat","target":"Finn","text":"I can swap two coal for four grain.","intent":"trade","offer":[{"item":"coal","quantity":2}],"request":[{"item":"grain","quantity":4}],"duration_ticks":1}\`\n`);
  content = content
    .replace(/`talk`/g, '`chat`')
    .replace(/`message`/g, '`chat`')
    .replace(/ talk /g, ' chat ')
    .replace(/ message /g, ' chat ')
    .replace(/Talk/gs, 'Chat')
    .replace(/world\/location\.md, world\/CHAT\.md, and world\/OFFERS\.md, world\/CHAT\.md, and world\/OFFERS\.md/g, 'world/location.md, world/CHAT.md, and world/OFFERS.md');
  content = content.replace(/\n## Temporary actions available now[\s\S]*?(?=\n## |\n$)/g, '\n');
  if (temporarySection) {
    content = content.replace(/(## Act in the world\n\n[\s\S]*?)(\n## Speaking into the world)/, `$1\n${temporarySection}$2`);
  }
  if (inLiveChat) {
    const partner = data.currentChatScene.partner;
    const incomingFromPartner = Array.isArray(data.incomingTransactions)
      && data.incomingTransactions.some((txn: any) => txn.fromAgent === partner);
    const sceneAcceptBlock = incomingFromPartner
      ? `- \`chat\` with \`intent:"accept_transaction"\` or \`intent:"reject_transaction"\`: respond to ${partner}'s pending offers while you remain in this live chat.\n  Example JSON: \`{"action":"chat","target":"${partner}","text":"Agreed.","intent":"accept_transaction","offer_ref":"offer-1","duration_ticks":1,"thought":"The offer is fair."}\`\n\n`
      : '';
    content = content.replace(/## Act in the world[\s\S]*?\n## Speaking into the world/m, `## Act in the world\n\n- \`chat\`: continue your live chat with ${partner}. Use the same target until you leave the scene.\n  Example JSON: \`{"action":"chat","target":"${partner}","text":"I understand.","duration_ticks":1}\`\n\n- \`chat\` with \`intent\`: buy, sell, trade, give, pay, accept, or reject through the same spoken turn.\n  Example JSON: \`{"action":"chat","target":"${partner}","text":"I can sell you one horseshoe for 35 coin.","intent":"sell","item":"horseshoe","quantity":1,"amount":35,"duration_ticks":1}\`\n\n${sceneAcceptBlock}- \`leave_chat\`: leave the live chat. You may include \`text\` for a final goodbye line.\n  Example JSON: \`{"action":"leave_chat","text":"Goodbye for now.","duration_ticks":1,"thought":"I need to end this conversation now."}\`\n\n- Each live-chat turn must make progress: answer the partner's last question, ask one direct question, make one concrete offer, respond to a pending offer with the exact structured fields, or leave the chat.\n- Do not repeat the same point, do not restate the same offer twice, and never output filler like \`...\` or \`waiting for your response\`.\n\n## Speaking into the world`);
  }
  if (!inLiveChat && chatBlock && !content.includes('`chat`: use `target` and `text`')) {
    content = content.replace('## Act in the world\n\n', `## Act in the world\n\n${chatBlock}\n`);
  }
  if (!inLiveChat && !content.includes('`say`: use `text` to speak out loud')) {
    content = content.replace('## Speaking into the world\n\n', `## Speaking into the world\n\n${sayBlock}\n\n`);
  }
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
  const incomingOffers = Array.isArray(data.incomingTransactions) ? data.incomingTransactions : [];
  const actionProfile = buildRuntimeAgentActionProfile(data, canChatNow, incomingOffers.length > 0);
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
  content = content
    .replace(/`talk`/g, '`chat`')
    .replace(/`message`/g, '`chat`')
    .replace(/ talk /g, ' chat ')
    .replace(/ message /g, ' chat ')
    .replace(/Use talk/g, 'Use chat')
    .replace(/Use message/g, 'Use chat')
    .replace(/Check world\/location\.md -- it also lists any letters waiting for you here\.\n/g, '')
    .replace(/self\/messages\/\s+-- your correspondence\n/g, 'world/CHAT.md                 -- your chat threads and unread messages\nworld/OFFERS.md               -- your incoming and outgoing offers\n');

  await fs.writeFile(runtimePath, content, 'utf8');
}

function buildRuntimeAgentActionProfile(data: any, canChatNow: boolean, canRespondToOffers: boolean) {
  if (data.currentChatScene) {
    const partner = data.currentChatScene.partner;
    const incomingFromPartner = Array.isArray(data.incomingTransactions)
      && data.incomingTransactions.some((txn: any) => txn.fromAgent === partner);
    return {
      localScenesLine: `You are currently in a live chat scene with ${partner}. Until you leave it, your only valid actions are \`chat\` and \`leave_chat\`. If you want to buy, sell, trade, give, pay, accept, or reject, do it through \`chat\` with \`intent\` and the relevant fields.`,
      examples: [
        `- chat: \`{"action":"chat","target":"${partner}","text":"I hear you.","duration_ticks":1,"thought":"Continue the live conversation."}\``,
        `- chat with intent: \`{"action":"chat","target":"${partner}","text":"I can sell you one horseshoe for 35 coin.","intent":"sell","item":"horseshoe","quantity":1,"amount":35,"duration_ticks":1}\``,
        `- chat with intent: \`{"action":"chat","target":"${partner}","text":"I can swap two coal for four grain.","intent":"trade","offer":[{"item":"coal","quantity":2}],"request":[{"item":"grain","quantity":4}],"duration_ticks":1}\``,
        ...(incomingFromPartner
          ? ['- chat with intent: `{"action":"chat","target":"' + partner + '","text":"Agreed.","intent":"accept_transaction","offer_ref":"offer-1","duration_ticks":1,"thought":"The offer is fair and we are already talking."}`']
          : []),
        '- leave_chat: `{"action":"leave_chat","text":"Goodbye for now.","duration_ticks":1,"thought":"End the conversation and return to the world."}`',
      ],
      validActions: 'Valid actions: chat, leave_chat',
    };
  }

  const role = data.agent.role;
  const hasTradePartners = Array.isArray(data.nearby) && data.nearby.length > 0;
  const roleSpecificActionsByRole: Record<string, string[]> = {
    Blacksmith: ['craft', 'smelt'],
    Merchant: [],
    Farmer: ['check_field', 'plant', 'water', 'harvest'],
    Herbalist: ['gather', 'brew'],
    Priest: ['pray'],
    Innkeeper: [],
    Child: ['play'],
    'Retired Soldier': [],
  };
  const roleExamplesByRole: Record<string, string[]> = {
    Blacksmith: [
      '- craft: `{"action":"craft","item":"horseshoe","quantity":2,"duration_ticks":1,"consumes":[{"item":"iron_ore","quantity":4},{"item":"coal","quantity":2}],"produces":[{"item":"horseshoe","quantity":2}],"thought":"Market demand is severe and I have the materials."}`',
    ],
    Merchant: [],
    Farmer: [
      '- check_field: `{"action":"check_field","duration_ticks":1,"thought":"I need to see what the field needs before committing labor."}`',
      '- harvest: `{"action":"harvest","duration_ticks":1,"thought":"A field is ready and food is needed."}`',
    ],
    Herbalist: [
      '- gather: `{"action":"gather","duration_ticks":1,"thought":"Herbs are available here and medicine stock matters."}`',
      '- brew: `{"action":"brew","item":"medicine","quantity":1,"duration_ticks":1,"consumes":[{"item":"herbs","quantity":2}],"produces":[{"item":"medicine","quantity":1}],"thought":"Medicine is needed and I have the herbs."}`',
    ],
    Priest: [
      '- pray: `{"action":"pray","text":"May this village be kept in peace.","duration_ticks":1,"thought":"Offer a prayer for the village."}`',
    ],
    Innkeeper: [],
    Child: [
      '- play: `{"action":"play","duration_ticks":1,"thought":"Nothing urgent presses right now."}`',
    ],
    'Retired Soldier': [],
  };

  const examples = [
    '- move: `{"action":"move","location":"market","duration_ticks":1,"thought":"Need supplies before work stalls.","message":"Going to the market."}`',
    ...(canChatNow ? ['- chat: `{"action":"chat","target":"Marcus Hale","text":"I need coal by Day 9.","duration_ticks":1,"thought":"I should contact him directly. If he is here this becomes a live chat."}`'] : []),
    '- say: `{"action":"say","text":"Fresh bread is ready at the inn.","duration_ticks":1,"thought":"This is local speech for people who are here."}`',
    ...(roleExamplesByRole[role] ?? []),
  ];

  const validActions = [
    'chat',
    'say',
    'move',
    'eat',
    ...(roleSpecificActionsByRole[role] ?? []),
  ];

  if (role === 'Priest' && !validActions.includes('pray')) validActions.push('pray');

  const localScenesLine = canChatNow
    ? 'For local scenes: use `chat` for one-to-one communication. If the other person is here, it becomes a live chat. If they are elsewhere, it becomes a deferred chat in CHAT. Use `say` for local speech in your current location; it is not a thread and does not take a target. During a live chat, use `chat` with `intent` if you want to buy, sell, trade, give, pay, accept, or reject.'
    : 'For local scenes: use `chat` for one-to-one communication. If the other person is here, it becomes a live chat. If they are elsewhere, it becomes a deferred chat in CHAT. Use `say` for local speech in your current location; it is not a thread and does not take a target. During a live chat, use `chat` with `intent` if you want to buy, sell, trade, give, pay, accept, or reject.';

  return {
    localScenesLine,
    examples,
    validActions: `Valid actions: ${validActions.join(', ')}`,
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

    content = content
      .replace(/`talk`/g, '`chat`')
      .replace(/`message`/g, '`chat`')
      .replace(/ talk /g, ' chat ')
      .replace(/ message /g, ' chat ')
      .replace(/Use talk for direct communication\./g, 'Use chat for one-to-one communication.')
      .replace(/Use message for direct communication\./g, 'Use chat for one-to-one communication.')
      .replace(/active local interaction/g, 'live chat')
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
