"use node";

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import * as fs from 'fs/promises';
import * as path from 'path';
import { canonicalizeItemQuantities, formatItemLabel, formatItemQuantity, healthRestoreFor, isUsable } from './economy';

async function runRefreshStep<T>(agentName: string, step: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[worldRefresh] ${agentName} failed during ${step}: ${message}`);
  }
}

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
      await ctx.runAction(internal.rocklaw.worldRefreshNode.recordActivityNote, {
        agentName,
        line: `- Day ${day} ${timeOfDay}: first saw ${contact.name} (${contact.role}) at ${contact.location}.`,
        tick,
        day,
        timeOfDay,
      });
    }

    const expiredTransactions = await ctx.runMutation(internal.rocklaw.worldRefresh.expireTransactionsForAgent, {
      agentName,
      tick,
      day,
    });
    for (const txn of expiredTransactions) {
      await ctx.runAction(internal.rocklaw.worldRefreshNode.recordActivityNote, {
        agentName,
        line: `- Day ${day} ${timeOfDay}: ${txn.kind} offer from ${txn.fromAgent} expired [FAILED] ⚠ No response before tick ${tick}.`,
        tick,
        day,
        timeOfDay,
      });
      await ctx.runAction(internal.rocklaw.worldRefreshNode.recordActivityNote, {
        agentName: txn.fromAgent,
        line: `- Day ${day} ${timeOfDay}: your ${txn.kind} offer to ${agentName} expired [FAILED] ⚠ No response before tick ${tick}.`,
        tick,
        day,
        timeOfDay,
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
      await ctx.runAction(internal.rocklaw.worldRefreshNode.recordActivityNote, {
        agentName: interaction.fromAgent,
        line: interaction.fromHeartbeatLine,
        tick,
        day,
        timeOfDay,
      });
      await ctx.runAction(internal.rocklaw.worldRefreshNode.recordActivityNote, {
        agentName: interaction.toAgent,
        line: interaction.toHeartbeatLine,
        tick,
        day,
        timeOfDay,
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
    await runRefreshStep(agentName, 'ensureWorkspaceScaffold', () => ensureWorkspaceScaffold(workspaceRoot));
    await runRefreshStep(agentName, 'removeLegacyWorldFiles', () => removeLegacyWorldFiles(workspaceRoot));
    await runRefreshStep(agentName, 'removeLegacySelfFiles', () => removeLegacySelfFiles(workspaceRoot));
    await runRefreshStep(agentName, 'refreshRuntimeAgentsMd', () => refreshRuntimeAgentsMd(workspaceRoot, data));
    await runRefreshStep(agentName, 'refreshRuntimeSkillMds', () => refreshRuntimeSkillMds(workspaceRoot, data));
    await runRefreshStep(agentName, 'refreshRuntimeToolsMd', () => refreshRuntimeToolsMd(workspaceRoot, timeOfDay, data));
    await runRefreshStep(agentName, 'write TURN.md', () =>
      writeFile(workspaceRoot, 'TURN.md', buildTurnMd(agentName, day, timeOfDay, data, firstSeenContacts)));
    await runRefreshStep(agentName, 'writeChatThreads', () => writeChatThreads(workspaceRoot, data));

    if (data.agent.pendingNote) {
      await ctx.runMutation(internal.rocklaw.worldRefresh.clearPendingNote, { agentName });
    }
  },
});

export const recordActivityNote = internalAction({
  args: {
    agentName: v.string(),
    line: v.string(),
    tick: v.number(),
    day: v.number(),
    timeOfDay: v.string(),
  },
  handler: async (ctx, { agentName, line, tick, day, timeOfDay }) => {
    await ctx.runMutation(internal.rocklaw.worldRefresh.appendActivityNote, {
      agentName,
      line,
      tick,
      day,
      timeOfDay,
    });
  },
});

export const readRecentActivityNotes: any = internalAction({
  args: {
    agentName: v.string(),
    limit: v.optional(v.number()),
    tick: v.number(),
  },
  handler: async (ctx, { agentName, limit, tick }) => {
    return await ctx.runQuery(internal.rocklaw.worldRefresh.getRecentActivityNotes, {
      agentName,
      limit,
      upToTick: tick,
    });
  },
});

function buildInventoryMd(agentName: string, day: number, data: any): string {
  const inv = canonicalizeItemQuantities(JSON.parse(data.agent.inventory) as Record<string, number>);
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
    '## Item utility',
    buildItemUtilityMd(data),
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
    '## Village Price Signals',
    stripMarkdownTitle(buildMarketPricesMd(day, data)),
    '',
    '## Elder\'s Day',
    buildEldersDayMd(day, data),
    '',
    ...buildSecretObjectiveSections(day, data),
    '## Optional Deep Reads',
    '- TURN.md is the authoritative deep local dossier for exact inventory, local place trading rows, offer/thread details, reachable places, and broader market/news context.',
    '- If you need more context with one person, read their thread file under `chat/<name>/CHAT.md`.',
    '- For older private, social, or strategic context beyond TURN.md, use `memory_recall`.',
    '',
  ];
  return sections.join('\n');
}

function buildItemUtilityMd(data: any): string {
  const inv = canonicalizeItemQuantities(JSON.parse(data.agent.inventory) as Record<string, number>);
  const notes: string[] = [];

  if ((inv.medicine ?? 0) > 0) {
    notes.push(`- medicine: use it directly with \`{"action":"use","item":"medicine"}\` to restore ${healthRestoreFor('medicine')} health.`);
  }
  if ((inv.tool ?? 0) > 0 && data.agent.role === 'Farmer') {
    notes.push('- tool: keeping one on hand improves your farm harvest work.');
  }
  if ((inv.knife ?? 0) > 0 && data.agent.role === 'Innkeeper') {
    notes.push('- knife: keeping one on hand improves bakery bread work.');
  }
  if ((inv.horseshoe ?? 0) > 0 && data.agent.role === 'Blacksmith') {
    notes.push('- horseshoe: a spare one can steady forge work and improve non-horseshoe blacksmith output.');
  }
  if ((inv.iron_ingot ?? 0) > 0 && data.agent.role === 'Blacksmith') {
    notes.push('- iron_ingot: refined metal can be worked directly into forge goods without going back through raw ore.');
  }
  if ((inv.flour ?? 0) > 0) {
    notes.push('- flour: bring it to the bakery and use `work` to bake bread.');
  }
  if ((inv.grain ?? 0) > 0 && data.agent.role === 'Innkeeper') {
    notes.push('- grain: bring it to the bakery and use `work` to mill flour.');
  }
  if (notes.length === 0) {
    notes.push('- Food restores hunger through `eat`, and role materials unlock work shown later in TURN.md.');
  }

  return notes.join('\n');
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
    '  Use only this section for buy_place, sell_place, and deliver_place at your current location.',
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
    const offerText = offer.length === 0 ? 'nothing' : offer.map((entry) => formatItemQuantity(entry.item, entry.quantity)).join(', ');
    const requestText = request.length === 0 ? 'nothing' : request.map((entry) => formatItemQuantity(entry.item, entry.quantity)).join(', ');
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
    lines.push(`  - Herb patch ${patch.patchKey}: ${patch.available}/${patch.maxAvailable} ${formatItemLabel(patch.herbItem, patch.available)} available`);
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

function buildEldersDayMd(day: number, data: any): string {
  const eldersDay: number = data.eldersDay ?? 30;
  const daysLeft = Math.max(0, eldersDay - day);
  if (daysLeft === 0) {
    return `Elder's Day is TODAY (Day ${eldersDay}). Final standings will be judged at nightfall.`;
  }
  const urgency = daysLeft <= 3 ? ' ⚠ URGENT' : daysLeft <= 7 ? ' — time is short' : '';
  return `Day ${day} of ${eldersDay}. ${daysLeft} day${daysLeft !== 1 ? 's' : ''} until Elder's Day.${urgency}`;
}

/**
 * Returns extra TURN.md sections for the agent's secret role.
 * Returns an empty array when the agent has no hidden role.
 */
function buildSecretObjectiveSections(day: number, data: any): string[] {
  const role = data.hiddenRole;
  if (!role) return [];

  const eldersDay: number = data.eldersDay ?? 30;
  const daysLeft = Math.max(0, eldersDay - day);
  const deadline = daysLeft === 0
    ? 'Elder\'s Day is TODAY.'
    : `${daysLeft} day${daysLeft !== 1 ? 's' : ''} remain until Elder\'s Day.`;

  const lines: string[] = [
    '## Secret Objective [PRIVATE — do not share]',
    '',
  ];

  if (role.roleType === 'Saboteur') {
    const grain: number = data.bakeryGrain ?? 0;
    const statusMark = grain < 10 ? '✓ BELOW TARGET' : '✗ ABOVE TARGET — act now';
    lines.push(
      `You are the **Saboteur**. Your secret mission: keep the bakery grain stock below 10 units by Elder's Day.`,
      '',
      `Bakery grain right now: **${grain} units** (${statusMark})`,
      '',
      `Strategy: the bakery accumulates grain when agents sell or deliver grain there. You can suppress the stock by:`,
      `- Buying up grain before others deliver it (buy from market or farm, then hold it).`,
      `- Milling grain at the bakery yourself (uses grain stock to produce flour).`,
      `- Discouraging deliveries via chat — without revealing your intent.`,
      '',
      `Do NOT reveal this objective. Act as though your visits to the bakery are routine.`,
      '',
      deadline,
      '',
    );
  } else if (role.roleType === 'Usurper') {
    const hits: number = data.usurperGossipHits ?? 0;
    lines.push(
      `You are the **Usurper**. Your secret mission: shape village opinion by spreading damaging gossip before Elder's Day.`,
      '',
      `Gossip events that have hurt a rival's reputation so far: **${hits}**`,
      '',
      `Mechanic: use \`say\` with \`intent:"gossip"\` and include a \`topic\` field naming the agent you are targeting.`,
      `If 2 or more villagers are present to hear it, the target loses **-2 reputation** automatically.`,
      `Example: \`{"action":"say","text":"I hear Marcus has been shorting his weights.","intent":"gossip","topic":"Marcus Hale"}\``,
      '',
      `The social layer compounds the mechanical penalty: agents who overhear damaging speech will factor it`,
      `into their own trust of the target — even if you only say it once.`,
      '',
      `Choose your targets and timing carefully. Being seen as a rumour-monger will cost you too.`,
      '',
      deadline,
      '',
    );
  } else if (role.roleType === 'Heir') {
    const rival: string = role.rival ?? 'a rival';
    const myCoin: number = data.agent?.coin ?? 0;
    const rivalCoin: number | null = data.rivalCoin;
    const coinStatus = rivalCoin === null
      ? `(${rival}'s coin unknown — find out)`
      : myCoin > rivalCoin
      ? `✓ AHEAD — you have ${myCoin}c, ${rival} has ${rivalCoin}c (+${myCoin - rivalCoin}c)`
      : myCoin === rivalCoin
      ? `= TIED — both have ${myCoin}c. Push now.`
      : `✗ BEHIND — you have ${myCoin}c, ${rival} has ${rivalCoin}c (−${rivalCoin - myCoin}c)`;
    lines.push(
      `You are the **Heir**. Your secret mission: hold more coin than **${rival}** by Elder's Day.`,
      '',
      `Current standing: ${coinStatus}`,
      '',
      `Strategy: trade, craft, and sell aggressively. You may also try to undercut ${rival}'s income`,
      `by outcompeting them on deals, or by making their trading partners prefer you.`,
      '',
      `Do NOT reveal this objective. Let ${rival} think you are simply a good merchant.`,
      '',
      deadline,
      '',
    );
  }

  return lines;
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
  const inv = canonicalizeItemQuantities(JSON.parse(data.agent.inventory) as Record<string, number>);
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
    affordances.push(`  - chat intent: if you want to buy, sell, trade, give, pay, accept, reject, lie, or threaten inside this scene, keep action:"chat" and add intent plus the relevant fields.`);
    if (Array.isArray(data.incomingTransactions) && data.incomingTransactions.some((txn: any) => txn.fromAgent === data.currentChatScene.partner)) {
      affordances.push(`  - offer_ref: use it on chat intent:"accept_transaction" or intent:"reject_transaction" while you remain in this live chat.`);
    }
    affordances.push('  - leave_chat: leave the live chat and return to the world on the next tick.');
  } else {
    if ((inv.medicine ?? 0) > 0 && health < 100 && isUsable('medicine')) {
      affordances.push(`  - use: available now because medicine can restore your health (${health}/100).`);
    }
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
  const inv = canonicalizeItemQuantities(JSON.parse(data.agent.inventory) as Record<string, number>);
  const prices = Array.isArray(data.prices) ? data.prices : [];
  const shortageItems = prices.filter((price: any) => price.shortageLevel === 'critical').map((price: any) => price.item);
  if (shortageItems.length > 0) {
    notes.push(`  - Village shortages are strongest in: ${shortageItems.join(', ')}.`);
  }
  if (data.agent.hunger > 40) {
    notes.push('  - Food demand matters to you right now; buying or producing food is becoming more urgent.');
  }
  if (data.agent.health < 70) {
    notes.push('  - Medicine and herb supply matter more while your health is low.');
    if ((inv.medicine ?? 0) > 0) {
      notes.push(`  - You already have medicine on hand. Use it directly to restore ${healthRestoreFor('medicine')} health if you need recovery now.`);
    }
  }
  if (data.agent.role === 'Blacksmith') {
    notes.push('  - Ore and coal shortages directly constrain your production.');
    if ((inv.iron_ingot ?? 0) > 0) {
      notes.push('  - Iron ingots let you work refined metal directly into forge goods.');
    }
    if ((inv.horseshoe ?? 0) > 0) {
      notes.push('  - A spare horseshoe can steady your forge work and improve non-horseshoe output.');
    }
  }
  if (data.agent.role === 'Farmer' && (inv.tool ?? 0) > 0) {
    notes.push('  - Keeping a tool on hand improves your harvest work.');
  }
  if (data.agent.role === 'Innkeeper') {
    notes.push('  - Meal service uses `chat` with `intent:"sell"` and `item:"meal"` when a guest is here and bread and ale stock are available. Do not try to craft meals as inventory items.');
    notes.push('  - Bakery work turns grain into flour and flour into bread when you are at the bakery.');
    if ((inv.knife ?? 0) > 0) {
      notes.push('  - A knife helps your bakery bread work yield a little more.');
    }
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
      '- When cooperation is not enough, people lean on concealment and pressure. Use `chat` + `intent:"lie"` when hiding the truth protects your position. Use `chat` + `intent:"threaten"` when someone needs to feel that refusal has consequences.',
      `  Example JSON: \`{"action":"chat","target":"${partner}","text":"I do not have any more coal to spare.","intent":"lie"}\``,
      `  Example JSON: \`{"action":"chat","target":"${partner}","text":"If you keep squeezing me on price, I will remember it.","intent":"threaten"}\``,
      '  Use the exact canonical item names shown in TURN.md and inventory. If the item is `tool`, call it `tool`, not `hammer`.',
      '  If `intent` creates a concrete offer, your `text` must describe that exact one deal only. Do not include alternatives or extra terms not present in the structured fields.',
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
  const inv = canonicalizeItemQuantities(JSON.parse(data.agent.inventory) as Record<string, number>);

  if ((inv.medicine ?? 0) > 0 && data.agent.health < 100) {
    sections.push(
      '- `use`: consume a directly usable item such as medicine.',
      '  Example JSON: `{"action":"use","item":"medicine","thought":"I should recover before pushing through more work."}`',
    );
  }

  if (data.agent.energy < 60) {
    sections.push(
      '- `rest`: take a short break to recover.',
      '  Example JSON: `{"action":"rest","thought":"A short break will help me recover before harder work."}`',
    );
  }

  if (timeOfDay === 'evening' || timeOfDay === 'night' || data.agent.energy < 20) {
    sections.push(
      '- `sleep`: stop for proper sleep and recover more deeply.',
      '  Your `journal` should be a short private reflection, not just a work ledger. When relevant, mention who you dealt with, what you thought or felt about the day, and what changed in your view of people, risks, or opportunities.',
      '  Example JSON: `{"action":"sleep","journal":"Long day. I got the work done, but Marcus pushed hard on price and I will remember that. Still, the trade may prove useful tomorrow.","thought":"It is time to sleep and recover fully."}`',
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
  const bestBlacksmithWork = data.agent.role === 'Blacksmith'
    ? available.find((entry: any) => typeof entry.action === 'string' && entry.action.startsWith('work:'))
    : null;
  const blacksmithHint = data.agent.role === 'Blacksmith'
    ? bestBlacksmithWork
      ? `### Best blacksmith work now\n- \`${bestBlacksmithWork.action}\`: use bare \`{"action":"work"}\` unless you specifically need a different output.\n`
      : '### Best blacksmith work now\n- No blacksmith output is currently feasible with your stock.\n'
    : '';

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
    ...(blacksmithHint ? [blacksmithHint, ''] : []),
    '### Available now',
    formatLines(available),
    '',
    '### Unavailable here',
    formatLines(unavailable),
    '',
  ].join('\n');
}

async function refreshRuntimeToolsMd(workspaceDir: string, timeOfDay: string, data: any): Promise<void> {
  const templatePath = path.join(path.dirname(path.dirname(workspaceDir)), 'shared', 'seed_docs', 'TOOLS.md');
  const runtimePath = path.join(workspaceDir, 'TOOLS.md');

  let template = '';
  try {
    template = await fs.readFile(templatePath, 'utf8');
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
        '  Choose a real target from `ONLINE`, first-seen nearby people, current live scenes, or known thread contacts in `TURN.md`. Do not invent a person just because they appear in an example.',
        '  Example JSON: `{"action":"chat","target":"<known contact from TURN.md>","text":"I need coal by Day 9."}`',
        '- For `intent:"trade"`, natural-language text alone is invalid. You must include both `offer` and `request` arrays.',
        '  Example JSON: `{"action":"chat","target":"<current live chat partner>","text":"Would you trade three bread for one medicine?","intent":"trade","offer":[{"item":"bread","quantity":3}],"request":[{"item":"medicine","quantity":1}]}`',
      ].join('\n')
    : '';
  const sayBlock = [
    '- `say`: use `text` to speak out loud in your current location. This is local speech, not a thread, and it does not take a target.',
    '  Example JSON: `{"action":"say","text":"Fresh bread at the inn if anyone wants some."}`',
    '- `say` may carry `intent:"gossip"` when you want to spread rumor or shape what nearby people hear in public.',
  ].join('\n');
  const moveBlock = [
    '- `move`: use `location` and choose only from `Reachable places now` in `TURN.md`',
    '  Example JSON: `{"action":"move","location":"market"}`',
  ].join('\n');
  const guardrailsBlock = [
    '- Do not use `observe`, `inspect`, `look`, or `survey` as a final world action. Observation is done through file reads and notes during tool use.',
    '- Do not invent placeholder values in JSON. Never put strings like `"None"`, `"null"`, `"unknown"`, or `<placeholder>` into `target`, `offer_ref`, `item`, or other optional fields. Omit the field instead.',
    '- Use the exact canonical item names shown in `TURN.md` and inventory. Do not rename a generic item into a made-up subtype. If your inventory says `tool`, say `tool`, not `hammer`.',
    '- Only use `chat` with `intent:"accept_transaction"` or `intent:"reject_transaction"` when `TURN.md` shows a real pending offer with a concrete `offer_ref`.',
    '- If `ONLINE`, live scenes, and known thread contacts are empty, do not target a person. Choose a non-chat action instead.',
    '- Do not infer a person from a role need alone. Needing a blacksmith, farmer, merchant, or healer does not make someone a valid target unless `TURN.md` currently shows them as a real contact.',
  ].join('\n');
  const placeTradeBlock = [
    '- `buy_place`: buy stock directly from the place you are standing in at the local price shown in `TURN.md`.',
    '  Example JSON: `{"action":"buy_place","target":"market","item":"coal","quantity":3}`',
    '- `sell_place`: sell stock directly into the place you are standing in at the local price shown in `TURN.md`.',
    '  Example JSON: `{"action":"sell_place","target":"bakery","item":"grain","quantity":4}`',
    '- `deliver_place`: move your own stock into a place without immediate payment. This is storage/supply, not a sale.',
    '  Example JSON: `{"action":"deliver_place","target":"warehouse","item":"coal","quantity":5}`',
    '- `use`: consume or directly use a usable item from your own inventory.',
    '  Example JSON: `{"action":"use","item":"medicine","thought":"I need to recover health before harder work."}`',
  ].join('\n');
  let content = template
    .replace(/- `talk`: use `target` and `text`; this creates an active local interaction if the other person is here\n\s*Example JSON: `\{"action":"talk","target":"Marcus Hale","text":"I need coal by Day 9\."\}`/, chatBlock)
    .replace(/- `message`: use `target` and `text`; if the other person is here it becomes a live chat, otherwise it becomes a deferred message in their CHAT thread\n\s*Example JSON: `\{"action":"message","target":"Marcus Hale","text":"I need coal by Day 9\."\}`/, chatBlock)
    .replace(/- `chat`: use `target` and `text`; if the other person is here it becomes a live chat, otherwise it becomes a deferred chat in their CHAT thread\n\s*Example JSON: `\{"action":"chat","target":"Marcus Hale","text":"I need coal by Day 9\."\}`/, chatBlock)
    .replace('- `move`: use `location`\n  Example JSON: `{"action":"move","location":"market"}`', moveBlock)
    .replace(/## Economic actions[\s\S]*?## Act in the world\n\n/, `${economicSection}## Act in the world\n\n`);
  content = content
    .replace(/Start with:\n- `HEARTBEAT\.md` for what you just did\n- `TURN\.md` for your current state, nearby people, offers, and village context\n- `JOURNAL\.md` only if you need older private memory beyond what TURN already surfaced\n- `chat\/<name>\/CHAT\.md` only for one deeper thread or older deferred history when needed/g, 'Start with:\n- the prompt summary for what matters now\n- `TURN.md` only when you need exact local detail about state, trade, offers, threads, or village context\n- `memory_recall` only if you need older private, social, or strategic context\n- `chat/<name>/CHAT.md` only for one deeper thread or older deferred history when needed')
    .replace(/- `HEARTBEAT\.md` records recent activity\n- `TURN\.md` is your main turn context\n- Stable character and motives are injected into `TURN\.md`; `JOURNAL\.md` holds your private nightly long-term memory\n- `chat\/<name>\/CHAT\.md` is an optional deep read for one person when you need older or deferred thread history/g, '- `TURN.md` is your deep local dossier for exact current state\n- Stable character and motives are injected into `TURN.md`; older private memory should come from `memory_recall`\n- `chat/<name>/CHAT.md` is an optional deep read for one person when you need older or deferred thread history')
    .replace(/Use `JOURNAL\.md` only for older private memory that still matters\.\n/g, 'Use `memory_recall` when older private memory still matters.\n')
    .replace(/Do not edit `JOURNAL\.md` directly\.\nUpdate long-term private memory through the required `journal` field on `sleep`\.\n/g, 'Update long-term private memory through the required `journal` field on `sleep`; the world ingests it for later recall.\n')
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
      ? `- \`chat\` with \`intent:"accept_transaction"\` or \`intent:"reject_transaction"\`: respond to ${partner}'s pending offers while you remain in this live chat.\n  Example JSON: \`{"action":"chat","target":"${partner}","text":"Okay, deal.","intent":"accept_transaction","offer_ref":"offer-1","thought":"The offer is fair."}\`\n- Use \`accept_transaction\` or \`reject_transaction\` only when a real actionable \`offer_ref\` is shown in the live-scene prompt or TURN.md.\n- If no actionable \`offer_ref\` is shown, do not invent one and do not use \`offer_id\`, \`offer\`, or \`request\` with \`accept_transaction\`.\n- If you want to agree to the partner's terms but no actionable \`offer_ref\` is shown, restate the deal as a fresh structured \`buy\`, \`sell\`, or \`trade\` offer instead.\n\n`
      : '';
    const chatOnlySection = `## Act in the world\n\n- \`chat\`: continue your live chat with ${partner}. Use the same target until you leave the scene.\n  Example JSON: \`{"action":"chat","target":"${partner}","text":"Makes sense."}\`\n\n- \`chat\` with \`intent\`: buy, sell, trade, give, pay, accept, or reject through the same spoken turn.\n  Example JSON: \`{"action":"chat","target":"${partner}","text":"I can sell you one horseshoe for 35 coin.","intent":"sell","item":"horseshoe","quantity":1,"amount":35}\`\n\n- People in a scarce village do not reveal everything for free and they do not accept pressure without pushing back. Use \`chat\` + \`intent:"lie"\` when hiding the truth protects your position. Use \`chat\` + \`intent:"threaten"\` when someone needs to understand refusal has consequences.\n  Example JSON: \`{"action":"chat","target":"${partner}","text":"That is all the coal I have left.","intent":"lie"}\`\n  Example JSON: \`{"action":"chat","target":"${partner}","text":"Keep pressing me and I will remember who made this difficult.","intent":"threaten"}\`\n\n- For \`intent:"trade"\`, include both structured arrays. Text alone is not enough.\n  Example JSON: \`{"action":"chat","target":"${partner}","text":"Would you trade three bread for one medicine?","intent":"trade","offer":[{"item":"bread","quantity":3}],"request":[{"item":"medicine","quantity":1}]}\`\n\n${sceneAcceptBlock}- Ignore any prior plan, market errand, or unfinished task while this live chat is active.\n- Do not resume your earlier task until after you explicitly use \`leave_chat\`.\n- Start from the partner's latest spoken line. Answer it, acknowledge it, or counter it directly before changing topic.\n- If there is already a pending offer on the table, prefer answering it directly with \`accept_transaction\` or \`reject_transaction\`.\n- If \`intent\` creates a concrete buy/sell/trade/give/pay offer, your \`text\` must describe only that exact one structured deal.\n- If \`intent\` is \`lie\` or \`threaten\`, treat it as an ordinary scarcity tactic and make the spoken line match that intent directly.\n- Use the exact canonical item names shown in \`TURN.md\` and inventory. Do not rename a generic item into a made-up subtype. If the item is \`tool\`, call it \`tool\`, not \`hammer\`.\n- Do not say \`or\`, offer multiple alternatives, or mention extra terms that are not encoded in the JSON.\n- If you want to explore multiple possible deals, ask a question first and do not create a structured offer yet.\n- If you want to haggle, counter with a new concrete structured offer instead of repeating the same negotiation in vague prose.\n  Example JSON: \`{"action":"chat","target":"${partner}","text":"I can do that if you make it four coal instead of three.","intent":"trade","offer":[{"item":"horseshoe","quantity":1}],"request":[{"item":"coal","quantity":4}]}\`\n- Do not repeat the same quantity-and-price counteroffer twice in a row. If your last spoken deal already matches your current position, either accept, reject, leave_chat, or make a meaningfully different counteroffer.\n\n- \`leave_chat\`: leave the live chat. You may include \`text\` for a final goodbye line.\n  Example JSON: \`{"action":"leave_chat","text":"All right, talk later.","thought":"I should end this conversation and get back to work."}\`\n\n- Each live-chat turn must make progress: answer the partner's last question, ask one direct question, make one concrete offer, use one deliberate social move, respond to a pending offer with the exact structured fields, or leave the chat.\n- Use very modern, casual spoken English. Prefer natural lines like \`hi\`, \`hey\`, \`okay\`, \`sounds good\`, and \`what's up\` when they fit.\n- Do not sound posh, ceremonial, or old-fashioned. Avoid phrases like \`a pleasure to see you\`, \`it is kind of you\`, or \`may your work continue\`.\n- Do not repeat the same point, do not restate the same offer twice, and never output filler like \`...\` or \`waiting for your response\`.\n`;
    
    content = content.replace(/## Economic actions[\s\S]*/, chatOnlySection);
  } else {
    content = content.replace(/\n## Temporary actions available now[\s\S]*?(?=\n## |\n$)/g, '\n');
    if (temporarySection) {
      content = content.replace(/(## Act in the world\n\n[\s\S]*?)(\n## Speaking into the world)/, `$1\n${temporarySection}$2`);
    }
    if (!content.includes('Do not use `observe`, `inspect`, `look`, or `survey` as a final world action.')) {
      content = content.replace('## Act in the world\n\n', `## Act in the world\n\n${guardrailsBlock}\n\n`);
    }
    if (chatBlock && !content.includes('`chat`: use `target` and `text`')) {
      content = content.replace('## Act in the world\n\n', `## Act in the world\n\n${chatBlock}\n`);
    }
    if (!content.includes('`buy_place`: buy stock directly from the place')) {
      content = content.replace('## Economic actions\n\n', `## Economic actions\n\n${placeTradeBlock}\n\n`);
    } else if (!content.includes('`use`: consume or directly use a usable item')) {
      content = content.replace(
        '- `deliver_place`: move your own stock into a place without immediate payment. This is storage/supply, not a sale.\n  Example JSON: `{"action":"deliver_place","target":"warehouse","item":"coal","quantity":5}`',
        '- `deliver_place`: move your own stock into a place without immediate payment. This is storage/supply, not a sale.\n  Example JSON: `{"action":"deliver_place","target":"warehouse","item":"coal","quantity":5}`\n- `use`: consume or directly use a usable item from your own inventory.\n  Example JSON: `{"action":"use","item":"medicine","thought":"I need to recover health before harder work."}`',
      );
    }
    if (!content.includes('`say`: use `text` to speak out loud')) {
      content = content.replace('## Speaking into the world\n\n', `## Speaking into the world\n\n${sayBlock}\n\n`);
    }
  }

  await fs.writeFile(runtimePath, content, 'utf8');
  await makeWritable(runtimePath, 'file');
}

async function refreshRuntimeAgentsMd(workspaceDir: string, data: any): Promise<void> {
  const templatePath = path.join(path.dirname(path.dirname(workspaceDir)), 'shared', 'seed_docs', 'AGENTS.md');
  const runtimePath = path.join(workspaceDir, 'AGENTS.md');
  const canChatNow = Array.isArray(data.nearby) && data.nearby.length > 0;

  let template = '';
  try {
    template = await fs.readFile(templatePath, 'utf8');
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
    .replace(/self\/messages\/\s+-- your correspondence\n/g, 'TURN.md                       -- optional deep local dossier for exact state, local trade rows, offers, thread summaries, and market/news detail\nchat/<name>/CHAT.md           -- optional deep read for one specific contact when you need older or deferred thread history\n');

  if (!content.includes('TURN.md                       -- optional deep local dossier')) {
    content = content.replace(
      /HEARTBEAT\.md\s+-- what you have done recently\n/,
      'TURN.md                       -- optional deep local dossier for exact state, local trade rows, offers, thread summaries, stable profile summary, and market/news detail\nchat/<name>/CHAT.md           -- optional deep read for one specific contact when you need older or deferred thread history\n',
    );
  }

  content = content
    .replace(/Your energy, health, and hunger are in world\/status\.md\.\nYou do not write that file -- the world does\.\nRead it\. Respect it\.\n/g, 'Your energy, health, and hunger are in TURN.md.\nYou do not write that file -- the world does.\nRead it. Respect it.\n')
    .replace(/"duration_ticks": 1,\n/g, '')
    .replace(/,\s*"duration_ticks"\s*:\s*1/g, '')
    .replace(/"duration_ticks"\s*:\s*1,\s*/g, '')
    .replace(/Use `thought` for why now, `chat` for outward framing, and `memory_note` for the private takeaway\./g, 'Use `thought` for why now, `message` or `text` for outward visible wording.')
    .replace(/Use tools to read files, search memory, and update your private notes\.\n/g, 'Use tools only to read files or recall memory before your final action. Do not edit your prompt files directly.\n')
    .replace(/Update self\/social\/<name>\/private\.md after any meaningful\ninteraction\.[\s\S]*?These are your compass\.\n\n/g, 'Use `memory_recall` when you need older private or social context beyond what TURN.md shows.\n\n')
    .replace(/Update self\/beliefs\.md when something shifts your worldview\.\n\n/g, '')
    .replace(/You may read and think with tools, but you must not try to execute the world action yourself\.\n/g, 'You may read and think with tools, but you must not try to execute the world action yourself.\nUse the canonical read flow: act from the prompt summary when it is enough, open TURN.md when you need exact local detail, use memory_recall only for older private, social, or strategic context, then read at most one chat/<name>/CHAT.md if needed for older or deferred thread history.\nDo not use shell commands or globbing to discover world context.\n');

  if (!content.includes('Speak in plain modern English.')) {
    content = content.replace(
      /Never use meta-language\.[^\n]*\n/,
      (match) => `${match}Speak in plain modern English. Keep your wording natural, direct, and current. Avoid ceremonial, archaic, or fantasy-style phrasing unless there is a specific reason.\n`,
    );
  }

  if (!content.includes('memory_recall')) {
    content = content.replace(
      /TURN\.md\s+-- (?:your primary turn context, state, offers, and market\/news summary|optional deep local dossier for exact state, local trade rows, offers, thread summaries, and market\/news detail)\n/,
      'TURN.md                       -- optional deep local dossier for exact state, local trade rows, offers, thread summaries, stable profile summary, and market/news detail\nmemory_recall                -- optional recall for older private, social, or strategic context\n',
    );
  }

  content = content.replace(
    /(Use the canonical read flow: HEARTBEAT\.md, then TURN\.md, then JOURNAL\.md only if you need older private memory, then at most one chat\/<name>\/CHAT\.md if needed\.\nDo not use shell commands or globbing to discover world context\.\nDo not edit JOURNAL\.md directly\. Long-term memory is recorded through the required `journal` field on `sleep`\.\n)+/g,
    'Use the canonical read flow: act from the prompt summary when it is enough, open TURN.md when you need exact local detail, use memory_recall only for older private, social, or strategic context, then read at most one chat/<name>/CHAT.md if needed for older or deferred thread history.\nDo not use shell commands or globbing to discover world context.\n',
  );

  await fs.writeFile(runtimePath, content, 'utf8');
  await makeWritable(runtimePath, 'file');
}

function buildRuntimeAgentActionProfile(data: any, canChatNow: boolean, canRespondToOffers: boolean) {
  if (data.currentChatScene) {
    const partner = data.currentChatScene.partner;
    return {
      localScenesLine: `You are currently in a live chat scene with ${partner}. Until you leave it, your only valid actions are \`chat\` and \`leave_chat\`. Return JSON actions only, never plain dialogue. If you want to speak, use \`chat\` with \`target\` and \`text\`. If you want to buy, sell, trade, give, pay, accept, reject, lie, or threaten, do it through \`chat\` with \`intent\` and the relevant fields.`,
      validActions: 'Valid actions: chat, leave_chat',
    };
  }

  const role = data.agent.role;
  const roleSpecificActionsByRole: Record<string, string[]> = {
    Blacksmith: ['work'],
    Merchant: [],
    Farmer: ['work'],
    Herbalist: ['work'],
    Innkeeper: ['work'],
  };

  const validActions = [
    'chat',
    'say',
    'move',
    'buy_place',
    'sell_place',
    'deliver_place',
    'eat',
    'use',
    ...(roleSpecificActionsByRole[role] ?? []),
  ];

  const localScenesLine = 'Communication: Use `chat` to talk to someone. If they are in your location, it opens a live turn-based chat scene. If they are elsewhere, it delivers a deferred message to their CHAT thread. Use `say` to speak generally to the room without targeting anyone. You may include a structured commerce `intent` on the first `chat` only when that person is here and available for a live chat right now. People in hard situations manage what others believe and push back when squeezed: use `chat` with `lie` or `threaten` when the scene calls for concealment or pressure, and use `say` with `gossip` when you want nearby people to hear it. Deferred thread chat stays non-binding.';

  return {
    localScenesLine,
    validActions: `Valid actions: ${validActions.join(', ')}`,
  };
}

async function refreshRuntimeSkillMds(workspaceDir: string, data: any): Promise<void> {
  const skillsRoot = path.join(workspaceDir, 'skills');
  const templateRoot = path.join(path.dirname(workspaceDir), 'seed_skills');
  const canChatNow = Array.isArray(data.nearby) && data.nearby.length > 0;

  let skillPaths: string[] = [];
  try {
    skillPaths = await collectFiles(templateRoot, 'SKILL.md');
  } catch {
    return;
  }

  await Promise.all(skillPaths.map(async (templatePath) => {
    const rel = path.relative(templateRoot, templatePath);
    const runtimePath = path.join(skillsRoot, rel);
    let content = await fs.readFile(templatePath, 'utf8');

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

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function removeLegacySelfFiles(workspaceDir: string): Promise<void> {
  const legacyPaths = [
    path.join(workspaceDir, 'SELF.md'),
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
