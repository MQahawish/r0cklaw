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

    const letters = await ctx.runMutation(internal.rocklaw.worldRefresh.deliverLetters, {
      agentName,
      locationId: data.locationDoc?._id ?? null,
      day,
    });

    const workspacePath = path.join(workspaceRoot, 'world');
    await refreshRuntimeToolsMd(workspaceRoot, timeOfDay, data);

    await Promise.all([
      writeFile(workspacePath, 'inventory.md', buildInventoryMd(agentName, day, data)),
      writeFile(workspacePath, 'location.md', buildLocationMd(agentName, day, timeOfDay, data, letters, firstSeenContacts)),
      writeFile(workspacePath, 'village_news.md', buildVillageNewsMd(day, data)),
      writeFile(workspacePath, 'market_prices.md', buildMarketPricesMd(day, data)),
      writeFile(workspacePath, 'status.md', buildStatusMd(agentName, day, timeOfDay, data)),
    ]);

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
  letters: any[] = [],
  firstSeenContacts: Array<{ name: string; role: string; location: string }> = [],
): string {
  const nearbyLines = data.nearby.length === 0
    ? '  (nobody nearby)'
    : data.nearby.map((a: any) => `  - ${a.name} (${a.role})`).join('\n');

  const board = data.locationDoc?.messageBoard
    ? JSON.parse(data.locationDoc.messageBoard) as string[]
    : [];
  const boardLines = board.length === 0
    ? '  (none)'
    : board.map((m: string) => `  - ${m}`).join('\n');

  const letterLines = letters.length === 0
    ? '  (none)'
    : letters.map((l: any) =>
        `  From ${l.fromAgent} (Day ${l.daySent}):\n  "${l.content}"`,
      ).join('\n\n');

  const sections = [
    `# Location -- ${agentName} -- Day ${day}, ${timeOfDay}`,
    '',
    `Current: ${data.agent.location}`,
    'Reachable places now:',
    Array.isArray(data.reachableLocations) && data.reachableLocations.length > 0
      ? data.reachableLocations.map((name: string) => `  - ${name}`).join('\n')
      : '  (none)',
    '',
    'Nearby:',
    nearbyLines,
    '',
    'Message board:',
    boardLines,
    '',
    'Letters waiting for you here:',
    letterLines,
    '',
  ];

  const pendingOffers = Array.isArray(data.pendingTransactions) ? data.pendingTransactions : [];
  const pendingOfferLines = pendingOffers.length === 0
    ? '  (none)'
    : pendingOffers.map((txn: any) => {
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
  sections.push('Pending offers here:');
  sections.push(pendingOfferLines);
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

  const firstSeenLines = firstSeenContacts.length === 0
    ? '  (none)'
    : firstSeenContacts.map((contact) => `  - You notice someone here for the first time: ${contact.name} (${contact.role}).`).join('\n');
  sections.push('First seen here:');
  sections.push(firstSeenLines);
  sections.push('');

  if (data.agent.pendingNote) {
    sections.push('From last tick:');
    sections.push(`  ${data.agent.pendingNote}`);
    sections.push('');
  }

  return sections.join('\n');
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

  const activeTalks = Array.isArray(data.activeInteractions)
    ? data.activeInteractions.filter((interaction: any) => interaction.kind === 'talk')
    : [];
  const affordances: string[] = [];
  if (activeTalks.length > 0) {
    const counterparts = Array.from(new Set(activeTalks.map((interaction: any) => interaction.counterpart)));
    affordances.push(`  - wait: available now because you are in a live conversation with ${counterparts.join(', ')}.`);
  }
  if (energy < 60) {
    affordances.push(`  - rest: available now because your energy is ${energy}/100.`);
  }
  if (timeOfDay === 'evening') {
    affordances.push('  - sleep: available now because it is evening.');
  } else if (energy < 20) {
    affordances.push(`  - sleep: available now because your energy is critically low (${energy}/100).`);
  }
  const affordanceLines = affordances.length === 0 ? '  (none)' : affordances.join('\n');

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
    'Action affordances:',
    affordanceLines,
    '',
  ].join('\n');
}

function buildTemporaryActionsSection(timeOfDay: string, data: any): string {
  const activeTalks = Array.isArray(data.activeInteractions)
    ? data.activeInteractions.filter((interaction: any) => interaction.kind === 'talk')
    : [];
  const sections: string[] = [];

  if (activeTalks.length > 0) {
    sections.push(
      '- `wait`: remain where you are and keep the current live conversation open.',
      '  Example JSON: `{"action":"wait","duration_ticks":1,"thought":"Stay here and keep the conversation open for a reply."}`',
    );
  }

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
  const canTalkNow = Array.isArray(data.nearby) && data.nearby.length > 0;
  const talkBlock = canTalkNow
    ? [
        '- `talk`: use `target` and `text`; this creates an active local interaction if the other person is here',
        '  Example JSON: `{"action":"talk","target":"Marcus Hale","text":"I need coal by Day 9.","duration_ticks":1}`',
      ].join('\n')
    : '';
  const moveBlock = [
    '- `move`: use `location` and choose only from `Reachable places now` in `world/location.md`',
    '  Example JSON: `{"action":"move","location":"market","duration_ticks":1}`',
  ].join('\n');
  const content = template
    .replace('- `talk`: use `target` and `text`; this creates an active local interaction if the other person is here\n  Example JSON: `{"action":"talk","target":"Marcus Hale","text":"I need coal by Day 9.","duration_ticks":1}`', talkBlock)
    .replace('- `move`: use `location`\n  Example JSON: `{"action":"move","location":"market","duration_ticks":1}`', moveBlock)
    .replace('{{TEMPORARY_ACTIONS}}\n', temporarySection);
  await fs.writeFile(runtimePath, content, 'utf8');
}

async function refreshRuntimeAgentsMd(workspaceDir: string, data: any): Promise<void> {
  const backupPath = path.join(workspaceDir, 'state', 'seeded_docs', 'AGENTS.md');
  const runtimePath = path.join(workspaceDir, 'AGENTS.md');
  const canTalkNow = Array.isArray(data.nearby) && data.nearby.length > 0;

  let template = '';
  try {
    template = await fs.readFile(backupPath, 'utf8');
  } catch {
    template = await fs.readFile(runtimePath, 'utf8');
  }

  let content = template;
  if (!canTalkNow) {
    content = content
      .replace(
        'For local scenes: when someone is present and `talk` appears in TOOLS.md, it creates an active local interaction. `buy`, `sell`, and `trade` create in-person offers when both people are present. These do not transfer goods immediately. Use `accept_transaction` or `reject_transaction` with the short pending offer reference shown in your location file, such as `offer-1`.',
        'For local scenes: `buy`, `sell`, and `trade` create in-person offers when both people are present. These do not transfer goods immediately. Use `accept_transaction` or `reject_transaction` with the short pending offer reference shown in your location file, such as `offer-1`.',
      )
      .replace(
        'Valid actions: talk, move, craft, repair, smelt, eat,\n',
        'Valid actions: move, craft, repair, smelt, eat,\n',
      );
  }

  await fs.writeFile(runtimePath, content, 'utf8');
}

async function refreshRuntimeSkillMds(workspaceDir: string, data: any): Promise<void> {
  const skillsRoot = path.join(workspaceDir, 'skills');
  const backupRoot = path.join(workspaceDir, 'state', 'seeded_skills');
  const canTalkNow = Array.isArray(data.nearby) && data.nearby.length > 0;

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

    if (!canTalkNow) {
      content = content.replace(/^-\sWhen someone is present and `talk` is available in TOOLS\.md,.*\n/gm, '');
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

async function ensureWorkspaceScaffold(workspaceDir: string): Promise<void> {
  const messagesDir = path.join(workspaceDir, 'self', 'messages');
  const inboxDir = path.join(messagesDir, 'inbox');
  const outboxDir = path.join(messagesDir, 'outbox');
  const sentLogPath = path.join(messagesDir, 'sent_log.md');
  const inboxReadmePath = path.join(inboxDir, 'README.md');

  await fs.mkdir(inboxDir, { recursive: true });
  await fs.mkdir(outboxDir, { recursive: true });

  await ensureFile(
    sentLogPath,
    '# Sent Messages Log\n\nNo sent messages yet.\n',
  );
  await ensureFile(
    inboxReadmePath,
    '# Inbox\n\nIncoming letters are reflected in world/location.md under "Letters waiting for you here".\nUse this folder only as your personal correspondence archive when needed.\n',
  );
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
