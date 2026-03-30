"use node";

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import * as fs from 'fs/promises';
import * as path from 'path';

async function makeWritable(targetPath: string, kind: 'file' | 'dir'): Promise<void> {
  try {
    await fs.chmod(targetPath, kind === 'dir' ? 0o777 : 0o666);
  } catch {
    // Best effort only. Some filesystems may reject chmod here.
  }
}

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
    await removeLegacyWorldFiles(workspaceRoot);
    await ensureRuntimeSelfMd(workspaceRoot, agentName, data);
    await refreshRuntimeAgentsMd(workspaceRoot, data);
    await refreshRuntimeSkillMds(workspaceRoot, data);

    await refreshRuntimeToolsMd(workspaceRoot, timeOfDay, data);

    await Promise.all([
      writeFile(workspaceRoot, 'TURN.md', buildTurnMd(agentName, day, timeOfDay, data, firstSeenContacts)),
    ]);
    await writeChatThreads(workspaceRoot, data);

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
    await makeWritable(heartbeatPath, 'file');
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

function stripMarkdownTitle(content: string): string {
  const lines = content.split('\n');
  let index = 0;
  while (index < lines.length && lines[index].trim() === '') index += 1;
  if (index < lines.length && lines[index].startsWith('# ')) {
    index += 1;
  }
  while (index < lines.length && lines[index].trim() === '') index += 1;
  return lines.slice(index).join('\n').trim();
}

function buildTurnMd(
  agentName: string,
  day: number,
  timeOfDay: string,
  data: any,
  firstSeenContacts: Array<{ name: string; role: string; location: string }> = [],
): string {
  const sections = [
    `# Turn Context -- ${agentName} -- Day ${day}, ${timeOfDay}`,
    '',
    `Current location: ${data.agent.location}`,
    '',
    '## Inventory',
    stripMarkdownTitle(buildInventoryMd(agentName, day, data)),
    '',
    '## Situation',
    stripMarkdownTitle(buildLocationMd(agentName, day, timeOfDay, data, firstSeenContacts)),
    '',
    '## Status',
    stripMarkdownTitle(buildStatusMd(agentName, day, timeOfDay, data)),
    '',
    '## Chat',
    stripMarkdownTitle(buildChatMd(data)),
    '',
    '## Offers',
    stripMarkdownTitle(buildOffersMd(data)),
    '',
    '## Village News',
    stripMarkdownTitle(buildVillageNewsMd(day, data)),
    '',
    '## Market Prices',
    stripMarkdownTitle(buildMarketPricesMd(day, data)),
    '',
    '## Optional Deep Reads',
    '- If you need more context with one person, read their thread file under `chat/<name>/CHAT.md`.',
    '',
  ];
  return sections.join('\n');
}

function buildBlankSelfMd(agentName: string): string {
  return [
    `# Self Context -- ${agentName}`,
    '',
    '## Goals',
    'What I am working toward this week:',
    '  - Nothing defined yet.',
    '',
    '## Plans',
    'Specific upcoming intentions:',
    '  - Nothing defined yet.',
    '',
    '## Beliefs',
    '- None yet.',
    '',
    '## Desires',
    '- None yet.',
    '',
    '## Secrets',
    '- None yet.',
    '',
    '## Relevant Relationships',
    '- None yet.',
    '',
  ].join('\n');
}

function buildLocationMd(
  agentName: string,
  day: number,
  timeOfDay: string,
  data: any,
  firstSeenContacts: Array<{ name: string; role: string; location: string }> = [],
): string {
  const sections = [
    `# Location -- ${agentName} -- Day ${day}, ${timeOfDay}`,
    '',
    `Current: ${data.agent.location}`,
    '',
    '## Place',
    'Economic stations and resources here:',
    buildEconomicLocationState(data),
    '',
    'Available place trading here:',
    buildPlaceTradingState(data),
    '',
    '## Live Now',
  ];

  const localActiveTalks = Array.isArray(data.localActiveTalks) ? data.localActiveTalks : [];
  const chattingNames = new Set<string>();
  for (const interaction of localActiveTalks) {
    chattingNames.add(interaction.fromAgent);
    chattingNames.add(interaction.toAgent);
  }

  const opportunities = Array.isArray(data.tradeOpportunities) ? data.tradeOpportunities : [];
  if (data.nearby.length > 0) {
    const nearbyLines = data.nearby.map((a: any) => {
      const opp = opportunities.find((o: any) => o.name === a.name);
      const sells = opp && Array.isArray(opp.likelySells) && opp.likelySells.length > 0
        ? opp.likelySells.join(', ')
        : 'nothing obvious';
      const buys = opp && Array.isArray(opp.likelyBuys) && opp.likelyBuys.length > 0
        ? opp.likelyBuys.join(', ')
        : 'nothing obvious';
      const statusParts = [];
      if (chattingNames.has(a.name)) statusParts.push('CHATTING');
      if (a.busy && a.busyLabel) statusParts.push(`BUSY: ${a.busyLabel}`);
      const statusSuffix = statusParts.length > 0 ? ` [${statusParts.join(' | ')}]` : '';
      return `  - ${a.name} (${a.role})${statusSuffix}: sells ${sells}; buys ${buys}`;
    }).join('\n');
    sections.push('Nearby:');
    sections.push(nearbyLines);
    sections.push('');
  }

  const board = data.locationDoc?.messageBoard
    ? JSON.parse(data.locationDoc.messageBoard) as string[]
    : [];
  if (board.length > 0) {
    sections.push('Message board:');
    sections.push(board.map((m: string) => `  - ${m}`).join('\n'));
    sections.push('');
  }

  const incomingOffers = Array.isArray(data.incomingTransactions) ? data.incomingTransactions : [];
  if (incomingOffers.length > 0) {
    const incomingOfferLines = incomingOffers.map((txn: any) => {
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
  }

  const outgoingOffers = Array.isArray(data.outgoingTransactions) ? data.outgoingTransactions : [];
  if (outgoingOffers.length > 0) {
    const outgoingOfferLines = outgoingOffers.map((txn: any) => {
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
  }

  const activeInteractions = Array.isArray(data.activeInteractions) ? data.activeInteractions : [];
  const otherActiveInteractions = activeInteractions.filter(
    (interaction: any) => interaction.fromAgent !== agentName && interaction.toAgent !== agentName
  );
  if (otherActiveInteractions.length > 0) {
    const interactionLines = otherActiveInteractions.map((interaction: any) => {
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
        return `  - ${interaction.fromAgent} is addressing ${interaction.toAgent}: "${text}"${locationNote}`;
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
  }

  const otherActiveTalks = localActiveTalks.filter(
    (interaction: any) => interaction.fromAgent !== agentName && interaction.toAgent !== agentName
  );
  if (otherActiveTalks.length > 0) {
    const liveChatLines = otherActiveTalks.map((interaction: any) => `  - ${interaction.fromAgent} and ${interaction.toAgent} are chatting.`).join('\n');
    sections.push('People chatting here:');
    sections.push(liveChatLines);
    sections.push('');
  }

  const recentLocalSpeech = Array.isArray(data.recentLocalSpeech) ? data.recentLocalSpeech : [];
  if (recentLocalSpeech.length > 0) {
    const localSpeechLines = recentLocalSpeech.map((entry: any) => `  - ${entry.agentName}: "${entry.message ?? '(no text)'}"`).join('\n');
    sections.push('Recent local speech:');
    sections.push(localSpeechLines);
    sections.push('');
  }

  if (firstSeenContacts.length > 0) {
    const firstSeenLines = firstSeenContacts.map((contact) => `  - You notice someone here for the first time: ${contact.name} (${contact.role}).`).join('\n');
    sections.push('First seen here:');
    sections.push(firstSeenLines);
    sections.push('');
  }

  if (data.agent.pendingNote) {
    sections.push('Recent changes:');
    sections.push(`  ${data.agent.pendingNote}`);
    sections.push('');
  }

  if (Array.isArray(data.reachableLocations) && data.reachableLocations.length > 0) {
    sections.push('## Navigation');
    sections.push('Reachable places now:');
    sections.push(data.reachableLocations.map((name: string) => `  - ${name}`).join('\n'));
    sections.push('');
  }

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
    : onlineContacts.map((thread: any) => `- ${thread.name}${thread.busyLabel ? ` [BUSY: ${thread.busyLabel}]` : ''}`).join('\n');

  const threadLines = threads.length === 0
    ? '- (none yet)'
    : threads.map((thread: any) => {
      const status = thread.live ? 'LIVE' : thread.online ? 'ONLINE' : 'OFFLINE';
      const unreadLabel = `${thread.unreadCount} UNREAD`;
      const summaryLabel = thread.live
        ? (thread.yourTurn ? 'your turn' : `${thread.name}'s turn`)
        : thread.unreadCount > 0
        ? 'recent message'
        : 'thread history';
      return `- ${thread.name} : ${status}${thread.busyLabel ? ` [BUSY: ${thread.busyLabel}]` : ''} : ${unreadLabel} : ${summaryLabel} : chat/${slugifyAgentName(thread.name)}/CHAT.md`;
    }).join('\n');

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
    ...(thread.busyLabel ? [`BUSY: ${thread.busyLabel}`] : []),
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

function buildPlaceTradingState(data: any): string {
  const stocks = Array.isArray(data.nearbyPlaceStocks) ? data.nearbyPlaceStocks : [];
  if (stocks.length === 0) return '  (no place stock here)';
  const grouped = new Map<string, any[]>();
  for (const stock of stocks) {
    const rows = grouped.get(stock.placeName) ?? [];
    rows.push(stock);
    grouped.set(stock.placeName, rows);
  }
  return Array.from(grouped.entries()).map(([placeName, entries]) => {
    const lines = entries.map((entry) => {
      const modes = [];
      if (entry.sells) modes.push(entry.canCurrentlySell ? `sells @ ${entry.askPrice ?? '?'}c` : 'out of stock');
      if (entry.buys) {
        modes.push(entry.canCurrentlyBuy
          ? `buys @ ${entry.bidPrice ?? '?'}c`
          : 'not buying right now');
      }
      return `    - ${entry.item}: ${entry.quantity}${typeof entry.capacity === 'number' ? `/${entry.capacity}` : ''} (${modes.join(', ')})`;
    }).join('\n');
    const treasuryLine = typeof entries[0]?.treasury === 'number' ? `    treasury: ${entries[0].treasury}c\n` : '';
    return `  - ${placeName}\n${treasuryLine}${lines}`;
  }).join('\n');
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
  const conditionLine = conditions.length === 0 ? '' : conditions.map((c) => `  ! ${c}`).join('\n');

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
    if (timeOfDay === 'evening' || timeOfDay === 'night') {
      affordances.push(`  - sleep: available now because it is ${timeOfDay}.`);
    } else if (energy < 20) {
      affordances.push(`  - sleep: available now because your energy is critically low (${energy}/100).`);
    }
  }
  const affordanceLines = affordances.length === 0 ? '' : affordances.join('\n');
  const economicNeeds = buildEconomicNeeds(data);

  const sections = [
    `# Status -- ${agentName} -- Day ${day}, ${timeOfDay}`,
    '',
    `Energy:     ${energy}/100  ${energyLabel}`,
    `Health:     ${health}/100  ${healthLabel}`,
    `Hunger:     ${hunger}/100  ${hungerLabel}`,
    `Reputation: ${repScore}/100  ${repLabel}${repWarning}`,
    '',
  ];

  if (conditionLine) {
    sections.push('Conditions:');
    sections.push(conditionLine);
    sections.push('');
  }

  if (economicNeeds) {
    sections.push('Economic pressure:');
    sections.push(economicNeeds);
    sections.push('');
  }

  if (affordanceLines) {
    sections.push('Action affordances:');
    sections.push(affordanceLines);
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
  return notes.length > 0 ? notes.join('\n') : '';
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
      `  Example JSON: \`{"action":"chat","target":"${partner}","text":"I hear you."}\``,
      `- \`chat\` + \`intent\`: use structured commerce through chat while speaking naturally to ${partner}.`,
      `  Example JSON: \`{"action":"chat","target":"${partner}","text":"I can sell you one horseshoe for 35 coin.","intent":"sell","item":"horseshoe","quantity":1,"amount":35}\``,
      `  Example JSON: \`{"action":"chat","target":"${partner}","text":"I can swap two coal for four grain.","intent":"trade","offer":[{"item":"coal","quantity":2}],"request":[{"item":"grain","quantity":4}]}\``,
      ...(incomingOffers.length > 0
        ? [
            '- `chat` + `intent:"accept_transaction"` or `intent:"reject_transaction"`: respond to a pending offer from the person you are currently chatting with.',
            '  Example JSON: `{"action":"chat","target":"' + partner + '","text":"Agreed.","intent":"accept_transaction","offer_ref":"offer-1","thought":"The offer is fair."}`',
          ]
        : []),
      '- `leave_chat`: leave the live chat. You may include `text` for a final goodbye line, then you will return to normal world actions on the next tick.',
      '  Example JSON: `{"action":"leave_chat","text":"All right, goodbye for now.","thought":"I should end this conversation and get back to work."}`',
      '',
    ].join('\n');
  }

  const sections: string[] = [];

  if (data.agent.energy < 60) {
    sections.push(
      '- `rest`: take a short break to recover.',
      '  Example JSON: `{"action":"rest","thought":"A short break will help me recover before harder work."}`',
    );
  }

  if (timeOfDay === 'evening' || timeOfDay === 'night' || data.agent.energy < 20) {
    sections.push(
      '- `sleep`: stop for proper sleep and recover more deeply.',
      '  Example JSON: `{"action":"sleep","thought":"It is time to sleep and recover fully."}`',
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
            { action: 'chat + intent:"accept_transaction"', detail: `Respond to ${partner}'s pending offer using offer_ref from TURN.md.` },
            { action: 'chat + intent:"reject_transaction"', detail: `Decline ${partner}'s pending offer using offer_ref from TURN.md.` },
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
        '  Example JSON: `{"action":"chat","target":"Marcus Hale","text":"I need coal by Day 9."}`',
        '- For `intent:"trade"`, natural-language text alone is invalid. You must include both `offer` and `request` arrays.',
        '  Example JSON: `{"action":"chat","target":"Lena Marsh","text":"Would you trade three bread for one medicine?","intent":"trade","offer":[{"item":"bread","quantity":3}],"request":[{"item":"medicine","quantity":1}]}`',
      ].join('\n')
    : '';
  const sayBlock = [
    '- `say`: use `text` to speak out loud in your current location. This is local speech, not a thread, and it does not take a target.',
    '  Example JSON: `{"action":"say","text":"Fresh bread at the inn if anyone wants some."}`',
  ].join('\n');
  const moveBlock = [
    '- `move`: use `location` and choose only from `Reachable places now` in `TURN.md`',
    '  Example JSON: `{"action":"move","location":"market"}`',
  ].join('\n');
  const placeTradeBlock = [
    '- `buy_place`: buy stock directly from the place you are standing in at the local price shown in `TURN.md`.',
    '  Example JSON: `{"action":"buy_place","target":"market","item":"coal","quantity":3}`',
    '- `sell_place`: sell stock directly into the place you are standing in at the local price shown in `TURN.md`.',
    '  Example JSON: `{"action":"sell_place","target":"bakery","item":"grain","quantity":4}`',
    '- `deliver_place`: move your own stock into a place without immediate payment. This is storage/supply, not a sale.',
    '  Example JSON: `{"action":"deliver_place","target":"warehouse","item":"coal","quantity":5}`',
  ].join('\n');
  let content = template
    .replace(/- `talk`: use `target` and `text`; this creates an active local interaction if the other person is here\n\s*Example JSON: `\{"action":"talk","target":"Marcus Hale","text":"I need coal by Day 9\."\}`/, chatBlock)
    .replace(/- `message`: use `target` and `text`; if the other person is here it becomes a live chat, otherwise it becomes a deferred message in their CHAT thread\n\s*Example JSON: `\{"action":"message","target":"Marcus Hale","text":"I need coal by Day 9\."\}`/, chatBlock)
    .replace(/- `chat`: use `target` and `text`; if the other person is here it becomes a live chat, otherwise it becomes a deferred chat in their CHAT thread\n\s*Example JSON: `\{"action":"chat","target":"Marcus Hale","text":"I need coal by Day 9\."\}`/, chatBlock)
    .replace('- `move`: use `location`\n  Example JSON: `{"action":"move","location":"market"}`', moveBlock)
    .replace(/## Economic actions[\s\S]*?## Act in the world\n\n/, `${economicSection}## Act in the world\n\n`)
    .replace(/## Innkeeper skills[\s\S]*$/m, `## Innkeeper skills\n\n- Use \`chat\` first to open a live conversation with a guest. Structured commerce is only valid while that live chat is active.\n\n- There is no separate \`craft\` action for meals. Meal service happens through \`chat\` with \`intent:"sell"\` and \`item:"meal"\` while you are already chatting live with the guest.\n\n- Example JSON: \`{"action":"chat","target":"Marcus Hale","text":"I can make you a hot meal if you want one.","intent":"sell","item":"meal","quantity":1,"amount":8}\`\n`)
    .replace(/## Priest skills[\s\S]*?(?=\n## |\n$)/m, `## Priest skills\n\n- Use \`chat\` to offer support, reassurance, or practical comfort directly to one person.\n  Example JSON: \`{"action":"chat","target":"Lena Marsh","text":"That sounds hard. If you need help, let me know.","thought":"Offer support through direct chat."}\`\n\n- Use \`pray\` for prayers spoken into the world.\n  Example JSON: \`{"action":"pray","text":"I hope this village gets a calmer week.","thought":"Offer a public prayer for the village."}\`\n\n- If you want to hand supplies to someone, open a live chat first. \`give\` is only valid inside that chat scene.\n`)
    .replace(/## Merchant skills[\s\S]*$/m, `## Merchant skills\n\n- Use \`chat\` first to open a live conversation. Direct commerce is only valid while you are already in a live chat with that same person.\n\n- Once the live chat is open, use \`chat\` with \`intent:"buy"\` to make an in-person offer for stock.\n  Example JSON: \`{"action":"chat","target":"Finn","text":"I can offer 24 coin for four grain.","intent":"buy","item":"grain","quantity":4,"amount":24}\`\n\n- Use \`chat\` with \`intent:"sell"\` to move inventory directly while that live chat is active.\n  Example JSON: \`{"action":"chat","target":"Elena Voss","text":"I can sell you three coal for 12 coin.","intent":"sell","item":"coal","quantity":3,"amount":12}\`\n\n- Use \`chat\` with \`intent:"trade"\` when a direct swap will close faster than coin.\n  Example JSON: \`{"action":"chat","target":"Finn","text":"I can swap two coal for four grain.","intent":"trade","offer":[{"item":"coal","quantity":2}],"request":[{"item":"grain","quantity":4}]}\`\n`);
  content = content
    .replace(/`talk`/g, '`chat`')
    .replace(/`message`/g, '`chat`')
    .replace(/ talk /g, ' chat ')
    .replace(/ message /g, ' chat ')
    .replace(/Talk/gs, 'Chat')
    .replace(/world\/location\.md, world\/CHAT\.md, and world\/OFFERS\.md, world\/CHAT\.md, and world\/OFFERS\.md/g, 'TURN.md');

  if (inLiveChat) {
    const partner = data.currentChatScene.partner;
    const incomingFromPartner = Array.isArray(data.incomingTransactions)
      && data.incomingTransactions.some((txn: any) => txn.fromAgent === partner);
    const sceneAcceptBlock = incomingFromPartner
      ? `- \`chat\` with \`intent:"accept_transaction"\` or \`intent:"reject_transaction"\`: respond to ${partner}'s pending offers while you remain in this live chat.\n  Example JSON: \`{"action":"chat","target":"${partner}","text":"Okay, deal.","intent":"accept_transaction","offer_ref":"offer-1","thought":"The offer is fair."}\`\n\n`
      : '';
    const chatOnlySection = `## Act in the world\n\n- \`chat\`: continue your live chat with ${partner}. Use the same target until you leave the scene.\n  Example JSON: \`{"action":"chat","target":"${partner}","text":"Makes sense."}\`\n\n- \`chat\` with \`intent\`: buy, sell, trade, give, pay, accept, or reject through the same spoken turn.\n  Example JSON: \`{"action":"chat","target":"${partner}","text":"I can sell you one horseshoe for 35 coin.","intent":"sell","item":"horseshoe","quantity":1,"amount":35}\`\n\n- For \`intent:"trade"\`, include both structured arrays. Text alone is not enough.\n  Example JSON: \`{"action":"chat","target":"${partner}","text":"Would you trade three bread for one medicine?","intent":"trade","offer":[{"item":"bread","quantity":3}],"request":[{"item":"medicine","quantity":1}]}\`\n\n${sceneAcceptBlock}- If there is already a pending offer on the table, prefer answering it directly with \`accept_transaction\` or \`reject_transaction\`.\n- If you want to haggle, counter with a new concrete structured offer instead of repeating the same negotiation in vague prose.\n  Example JSON: \`{"action":"chat","target":"${partner}","text":"I can do that if you make it four coal instead of three.","intent":"trade","offer":[{"item":"horseshoe","quantity":1}],"request":[{"item":"coal","quantity":4}]}\`\n\n- \`leave_chat\`: leave the live chat. You may include \`text\` for a final goodbye line.\n  Example JSON: \`{"action":"leave_chat","text":"All right, talk later.","thought":"I should end this conversation and get back to work."}\`\n\n- Each live-chat turn must make progress: answer the partner's last question, ask one direct question, make one concrete offer, respond to a pending offer with the exact structured fields, or leave the chat.\n- Use very modern, casual spoken English. Prefer natural lines like \`hi\`, \`hey\`, \`okay\`, \`sounds good\`, and \`what's up\` when they fit.\n- Do not sound posh, ceremonial, or old-fashioned. Avoid phrases like \`a pleasure to see you\`, \`it is kind of you\`, or \`may your work continue\`.\n- Do not repeat the same point, do not restate the same offer twice, and never output filler like \`...\` or \`waiting for your response\`.\n`;
    
    content = content.replace(/## Economic actions[\s\S]*/, chatOnlySection);
  } else {
    content = content.replace(/\n## Temporary actions available now[\s\S]*?(?=\n## |\n$)/g, '\n');
    if (temporarySection) {
      content = content.replace(/(## Act in the world\n\n[\s\S]*?)(\n## Speaking into the world)/, `$1\n${temporarySection}$2`);
    }
    if (chatBlock && !content.includes('`chat`: use `target` and `text`')) {
      content = content.replace('## Act in the world\n\n', `## Act in the world\n\n${chatBlock}\n`);
    }
    if (!content.includes('`buy_place`: buy stock directly from the place')) {
      content = content.replace('## Economic actions\n\n', `## Economic actions\n\n${placeTradeBlock}\n\n`);
    }
    if (!content.includes('`say`: use `text` to speak out loud')) {
      content = content.replace('## Speaking into the world\n\n', `## Speaking into the world\n\n${sayBlock}\n\n`);
    }
  }

  await fs.writeFile(runtimePath, content, 'utf8');
  await makeWritable(runtimePath, 'file');
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
    /Examples:\n[\s\S]*?Check TOOLS\.md for the actions available to you right now\./,
    `${actionProfile.validActions}\n\nCheck TOOLS.md for the exact schemas, intents, and parameters available to you right now.`,
  );
  content = content
    .replace(/`talk`/g, '`chat`')
    .replace(/`message`/g, '`chat`')
    .replace(/ talk /g, ' chat ')
    .replace(/ message /g, ' chat ')
    .replace(/Use talk/g, 'Use chat')
    .replace(/Use message/g, 'Use chat')
    .replace(/Check world\/location\.md -- who is nearby right now\.\n/g, 'Check TURN.md -- it holds your current state, nearby people, offers, market prices, and village news.\n')
    .replace(/Check world\/location\.md -- look for Active interactions here when someone is addressing you or making you an offer\.\n/g, 'Check TURN.md -- it also shows live interactions, busy people, and thread summaries.\n')
    .replace(/Check world\/location\.md -- it also lists any letters waiting for you here\.\n/g, '')
    .replace(/world\/inventory\.md\s+-- what you have right now\n/g, '')
    .replace(/world\/location\.md\s+-- where you are, who is nearby\n/g, '')
    .replace(/world\/village_news\.md\s+-- what has happened recently\n/g, '')
    .replace(/world\/market_prices\.md\s+-- current prices and shortages\n/g, '')
    .replace(/world\/status\.md\s+-- your energy, health, hunger right now\n/g, '')
    .replace(/world\/CHAT\.md\s+-- your chat threads and unread messages\n/g, '')
    .replace(/world\/OFFERS\.md\s+-- your incoming and outgoing offers\n/g, '')
    .replace(/self\/goals\.md\s+-- what you are working toward\n/g, '')
    .replace(/self\/plans\.md\s+-- specific upcoming intentions\n/g, '')
    .replace(/self\/beliefs\.md\s+-- what you think is true\n/g, '')
    .replace(/self\/desires\.md\s+-- what you want, if you are honest\n/g, '')
    .replace(/self\/secrets\.md\s+-- what you know that others don't\n/g, '')
    .replace(/self\/social\/\*\/public\.md\s+-- how you behave toward each person\n/g, '')
    .replace(/self\/social\/\*\/private\.md\s+-- how you actually feel \(yours alone\)\n/g, '')
    .replace(/self\/messages\/\s+-- your correspondence\n/g, 'TURN.md                       -- your primary turn context, state, offers, and market/news summary\nchat/<name>/CHAT.md           -- optional deep read for one specific contact\n');

  if (!content.includes('TURN.md                       -- your primary turn context')) {
    content = content.replace(
      /HEARTBEAT\.md\s+-- what you have done recently\n/,
      'HEARTBEAT.md               -- what you have done recently\nTURN.md                       -- your primary turn context, state, offers, and market/news summary\nSELF.md                       -- your current goals, beliefs, plans, secrets, and relevant relationships\nchat/<name>/CHAT.md           -- optional deep read for one specific contact\n',
    );
  }

  content = content
    .replace(/Your energy, health, and hunger are in world\/status\.md\.\nYou do not write that file -- the world does\.\nRead it\. Respect it\.\n/g, 'Your energy, health, and hunger are in TURN.md.\nYou do not write that file -- the world does.\nRead it. Respect it.\n')
    .replace(/"duration_ticks": 1,\n/g, '')
    .replace(/,\s*"duration_ticks"\s*:\s*1/g, '')
    .replace(/"duration_ticks"\s*:\s*1,\s*/g, '')
    .replace(/Use `thought` for why now, `chat` for outward framing, and `memory_note` for the private takeaway\./g, 'Use `thought` for why now, `message` or `text` for outward visible wording, and `memory_note` for the private takeaway.')
    .replace(/Use tools to read files, search memory, and update your private notes\.\n/g, 'Use tools to read files, search memory, and update your private notes.\n')
    .replace(/Update self\/social\/<name>\/private\.md after any meaningful\ninteraction\.[\s\S]*?These are your compass\.\n\n/g, 'Update SELF.md when your goals, plans, beliefs, secrets, desires, or relationship notes meaningfully change.\nKeep the existing section headings intact and edit only the parts that changed.\n\n')
    .replace(/Update self\/beliefs\.md when something shifts your worldview\.\n\n/g, '')
    .replace(/You may read and think with tools, but you must not try to execute the world action yourself\.\n/g, 'You may read and think with tools, but you must not try to execute the world action yourself.\nUse the canonical read flow: HEARTBEAT.md, then TURN.md, then SELF.md, then at most one chat/<name>/CHAT.md if needed.\nDo not use shell commands or globbing to discover world context.\nDo not edit SELF.md unless your goals, plans, beliefs, desires, secrets, or relationship notes truly changed because of this tick.\n');

  if (!content.includes('Speak in plain modern English.')) {
    content = content.replace(
      /Never use meta-language\.[^\n]*\n/,
      (match) => `${match}Speak in plain modern English. Keep your wording natural, direct, and current. Avoid ceremonial, archaic, or fantasy-style phrasing unless there is a specific reason.\n`,
    );
  }

  if (!content.includes('SELF.md')) {
    content = content.replace(
      /TURN\.md\s+-- your primary turn context, state, offers, and market\/news summary\n/,
      'TURN.md                       -- your primary turn context, state, offers, and market/news summary\nSELF.md                       -- your current goals, beliefs, plans, secrets, and relevant relationships\n',
    );
  }

  content = content.replace(
    /(Use the canonical read flow: HEARTBEAT\.md, then TURN\.md, then SELF\.md, then at most one chat\/<name>\/CHAT\.md if needed\.\nDo not use shell commands or globbing to discover world context\.\nDo not edit SELF\.md unless your goals, plans, beliefs, desires, secrets, or relationship notes truly changed because of this tick\.\n)+/g,
    'Use the canonical read flow: HEARTBEAT.md, then TURN.md, then SELF.md, then at most one chat/<name>/CHAT.md if needed.\nDo not use shell commands or globbing to discover world context.\nDo not edit SELF.md unless your goals, plans, beliefs, desires, secrets, or relationship notes truly changed because of this tick.\n',
  );

  await fs.writeFile(runtimePath, content, 'utf8');
  await makeWritable(runtimePath, 'file');
}

function buildRuntimeAgentActionProfile(data: any, canChatNow: boolean, canRespondToOffers: boolean) {
  if (data.currentChatScene) {
    const partner = data.currentChatScene.partner;
    return {
      localScenesLine: `You are currently in a live chat scene with ${partner}. Until you leave it, your only valid actions are \`chat\` and \`leave_chat\`. If you want to buy, sell, trade, give, pay, accept, or reject, do it through \`chat\` with \`intent\` and the relevant fields.`,
      validActions: 'Valid actions: chat, leave_chat',
    };
  }

  const role = data.agent.role;
  const roleSpecificActionsByRole: Record<string, string[]> = {
    Blacksmith: ['craft', 'smelt'],
    Merchant: [],
    Farmer: ['check_field', 'plant', 'water', 'harvest'],
    Herbalist: ['gather', 'brew'],
    Innkeeper: [],
  };

  const validActions = [
    'chat',
    'say',
    'move',
    'buy_place',
    'sell_place',
    'deliver_place',
    'eat',
    ...(roleSpecificActionsByRole[role] ?? []),
  ];

  const localScenesLine = 'Communication: Use `chat` to talk to someone. If they are in your location, it opens a live turn-based chat scene. If they are elsewhere, it delivers a deferred message to their CHAT thread. Use `say` to speak generally to the room without targeting anyone. Do not use commerce intents (like buy, sell, or trade) unless you are already actively inside a live chat scene with that person.';

  return {
    localScenesLine,
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

    const runtimeDir = path.dirname(runtimePath);
    await fs.mkdir(runtimeDir, { recursive: true });
    await makeWritable(runtimeDir, 'dir');
    await fs.writeFile(runtimePath, content, 'utf8');
    await makeWritable(runtimePath, 'file');
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
  await makeWritable(dir, 'dir');
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, content, 'utf8');
  await makeWritable(filePath, 'file');
}

async function writeChatThreads(workspaceDir: string, data: any): Promise<void> {
  const threads = Array.isArray(data.chatThreads) ? data.chatThreads : [];
  const chatRoot = path.join(workspaceDir, 'chat');
  await fs.rm(chatRoot, { recursive: true, force: true });
  await fs.mkdir(chatRoot, { recursive: true });
  await makeWritable(chatRoot, 'dir');

  await Promise.all(threads.map(async (thread: any) => {
    const threadDir = path.join(chatRoot, slugifyAgentName(thread.name));
    await fs.mkdir(threadDir, { recursive: true });
    await makeWritable(threadDir, 'dir');
    const threadPath = path.join(threadDir, 'CHAT.md');
    await fs.writeFile(
      threadPath,
      buildChatThreadMd(data.agent.name, thread),
      'utf8',
    );
    await makeWritable(threadPath, 'file');
  }));
}

async function ensureWorkspaceScaffold(workspaceDir: string): Promise<void> {
  const chatDir = path.join(workspaceDir, 'chat');
  await fs.mkdir(chatDir, { recursive: true });
  await makeWritable(chatDir, 'dir');
}

async function removeLegacyWorldFiles(workspaceDir: string): Promise<void> {
  const legacyPaths = [
    path.join(workspaceDir, 'world', 'inventory.md'),
    path.join(workspaceDir, 'world', 'location.md'),
    path.join(workspaceDir, 'world', 'CHAT.md'),
    path.join(workspaceDir, 'world', 'OFFERS.md'),
    path.join(workspaceDir, 'world', 'village_news.md'),
    path.join(workspaceDir, 'world', 'market_prices.md'),
    path.join(workspaceDir, 'world', 'status.md'),
    path.join(workspaceDir, 'world'),
    path.join(workspaceDir, 'TURN.md'),
  ];
  await Promise.all(legacyPaths.map(async (filePath) => {
    try {
      await fs.rm(filePath, { force: true });
    } catch {
      // ignore cleanup failures
    }
  }));
}

async function ensureRuntimeSelfMd(workspaceDir: string, agentName: string, data: any): Promise<void> {
  const selfDir = path.join(workspaceDir, 'self');
  const selfPath = path.join(workspaceDir, 'SELF.md');
  let hasSelf = true;
  try {
    await fs.access(selfPath);
  } catch {
    hasSelf = false;
  }

  if (!hasSelf) {
    const migrated = await buildSelfMdFromLegacy(workspaceDir, agentName, data);
    await fs.writeFile(selfPath, migrated, 'utf8');
    await makeWritable(selfPath, 'file');
  }

  await removeLegacySelfFiles(workspaceDir);
}

async function buildSelfMdFromLegacy(workspaceDir: string, agentName: string, data: any): Promise<string> {
  const selfDir = path.join(workspaceDir, 'self');
  const goals = stripMarkdownTitle(await readOptionalFile(path.join(selfDir, 'goals.md')) ?? '');
  const plans = stripMarkdownTitle(await readOptionalFile(path.join(selfDir, 'plans.md')) ?? '');
  const beliefs = stripMarkdownTitle(await readOptionalFile(path.join(selfDir, 'beliefs.md')) ?? '');
  const desires = stripMarkdownTitle(await readOptionalFile(path.join(selfDir, 'desires.md')) ?? '');
  const secrets = stripMarkdownTitle(await readOptionalFile(path.join(selfDir, 'secrets.md')) ?? '');
  const relationships = await buildRelevantRelationshipsSection(selfDir, data);

  const sections = [
    `# Self Context -- ${agentName}`,
    '',
    '## Goals',
    goals || 'What I am working toward this week:\n  - Survive and stay functional.',
    '',
    '## Plans',
    plans || 'Specific upcoming intentions:\n  - Nothing defined yet.',
    '',
    '## Beliefs',
    beliefs || '- None yet.',
    '',
    '## Desires',
    desires || '- None yet.',
    '',
    '## Secrets',
    secrets || '- None yet.',
    '',
    '## Relevant Relationships',
    relationships || '- None yet.',
    '',
  ];

  return sections.join('\n');
}

async function buildRelevantRelationshipsSection(selfDir: string, data: any): Promise<string> {
  const relevantNames = new Set<string>();
  for (const other of Array.isArray(data.nearby) ? data.nearby : []) relevantNames.add(other.name);
  if (data.currentChatScene?.partner) relevantNames.add(data.currentChatScene.partner);
  for (const thread of Array.isArray(data.chatThreads) ? data.chatThreads : []) {
    if (thread.live || thread.online || (thread.unreadCount ?? 0) > 0) relevantNames.add(thread.name);
  }
  for (const txn of Array.isArray(data.incomingTransactions) ? data.incomingTransactions : []) relevantNames.add(txn.fromAgent);
  for (const txn of Array.isArray(data.outgoingTransactions) ? data.outgoingTransactions : []) relevantNames.add(txn.toAgent);
  for (const interaction of Array.isArray(data.activeInteractions) ? data.activeInteractions : []) relevantNames.add(interaction.counterpart);

  const lines: string[] = [];
  for (const name of Array.from(relevantNames).sort((a, b) => a.localeCompare(b))) {
    const socialDir = path.join(selfDir, 'social', slugifyAgentName(name));
    const publicText = stripMarkdownTitle(await readOptionalFile(path.join(socialDir, 'public.md')) ?? '');
    const privateText = stripMarkdownTitle(await readOptionalFile(path.join(socialDir, 'private.md')) ?? '');
    const combined = [privateText, publicText].filter(Boolean).join('\n').trim();
    if (!combined) {
      lines.push(`- ${name}: No private relationship notes yet.`);
      continue;
    }
    const compact = combined
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ');
    lines.push(`- ${name}: ${compact}`);
  }
  return lines.join('\n');
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function removeLegacySelfFiles(workspaceDir: string): Promise<void> {
  const legacyPaths = [
    path.join(workspaceDir, 'self', 'SELF.md'),
    path.join(workspaceDir, 'self', 'goals.md'),
    path.join(workspaceDir, 'self', 'plans.md'),
    path.join(workspaceDir, 'self', 'beliefs.md'),
    path.join(workspaceDir, 'self', 'desires.md'),
    path.join(workspaceDir, 'self', 'secrets.md'),
    path.join(workspaceDir, 'self', 'social'),
    path.join(workspaceDir, 'self'),
  ];
  await Promise.all(legacyPaths.map(async (entryPath) => {
    try {
      await fs.rm(entryPath, { force: true, recursive: true });
    } catch {
      // ignore cleanup failures
    }
  }));
}

async function ensureFile(filePath: string, content: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, content, 'utf8');
    await makeWritable(filePath, 'file');
  }
}

function resolveWorkspacePath(workspacePath: string): string {
  if (path.isAbsolute(workspacePath)) return workspacePath;
  const root = process.env.ROCKLAW_PROJECT_ROOT || process.cwd();
  return path.resolve(root, workspacePath);
}
