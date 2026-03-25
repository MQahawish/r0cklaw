"use node";

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import * as fs from 'fs/promises';
import * as path from 'path';

const ZEROCLAW_BOOTSTRAP_FILES = [
  ['00_IDENTITY.md', 'IDENTITY.md'],
  ['01_SOUL.md', 'SOUL.md'],
  ['02_AGENTS.md', 'AGENTS.md'],
  ['03_TOOLS.md', 'TOOLS.md'],
  ['05_MEMORY.md', 'MEMORY.md'],
] as const;

export const refreshWorldFiles = internalAction({
  args: {
    agentName: v.string(),
    tick: v.number(),
    day: v.number(),
    timeOfDay: v.string(),
  },
  handler: async (ctx, { agentName, tick, day, timeOfDay }) => {
    const data = await ctx.runQuery(internal.rocklaw.worldRefresh.getWorldSnapshot, {
      agentName,
      tick,
      day,
    });
    if (!data) {
      console.error(`[worldRefresh] No data for ${agentName}`);
      return;
    }

    await syncZeroClawBootstrapFiles(resolveWorkspacePath(data.workspacePath));

    const letters = await ctx.runMutation(internal.rocklaw.worldRefresh.deliverLetters, {
      agentName,
      locationId: data.locationDoc?._id ?? null,
      day,
    });

    const workspacePath = path.join(resolveWorkspacePath(data.workspacePath), 'world');

    await Promise.all([
      writeFile(workspacePath, 'inventory.md', buildInventoryMd(agentName, day, data)),
      writeFile(workspacePath, 'location.md', buildLocationMd(agentName, day, timeOfDay, data, letters)),
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

    const heartbeatPath = path.join(resolveWorkspacePath(agent.workspacePath), '06_HEARTBEAT.md');

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
  ].join('\n');
}

async function writeFile(dir: string, filename: string, content: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), content, 'utf8');
}

async function syncZeroClawBootstrapFiles(workspaceDir: string): Promise<void> {
  await Promise.all(
    ZEROCLAW_BOOTSTRAP_FILES.map(async ([sourceName, targetName]) => {
      const sourcePath = path.join(workspaceDir, sourceName);
      const targetPath = path.join(workspaceDir, targetName);

      try {
        const content = await fs.readFile(sourcePath, 'utf8');
        await fs.writeFile(targetPath, content, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }),
  );
}

function resolveWorkspacePath(workspacePath: string): string {
  if (path.isAbsolute(workspacePath)) return workspacePath;
  const root = process.env.ROCKLAW_PROJECT_ROOT || process.cwd();
  return path.resolve(root, workspacePath);
}
