/**
 * File Compaction -- Phase 6
 *
 * Runs every 10 ticks. For each agent, checks growing files against thresholds
 * and compacts them: either by trimming (no LLM) or by LLM summarisation.
 *
 * Thresholds (from spec):
 *   05_MEMORY.md             > 150 lines  → LLM summary (preserve incidents + emotional arc)
 *   06_HEARTBEAT.md          managed inline in appendHeartbeat -- not touched here
 *   self/beliefs.md          > 60 lines   → LLM summary (preserve core worldview)
 *   self/messages/sent_log.md > 20 entries → keep last 5 verbatim, summarise older
 *   self/social/<x>/private.md > 80 lines → LLM summary (preserve emotional trajectory)
 */

import { v } from 'convex/values';
import { internalAction, internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';
import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'fs/promises';

// ── Thresholds ────────────────────────────────────────────────────────────────

const MEMORY_LINE_THRESHOLD   = 150;
const BELIEFS_LINE_THRESHOLD  = 60;
const SENT_LOG_ENTRY_THRESHOLD = 20;
const SOCIAL_LINE_THRESHOLD   = 80;

// ── Run compaction for all agents ─────────────────────────────────────────────

export const runCompaction = internalAction({
  args: {},
  handler: async (ctx) => {
    const agents = await ctx.runQuery(internal.rocklaw.compact.getAllAgents);
    console.log(`[compact] Running compaction for ${agents.length} agents`);

    // Run agents sequentially to avoid overwhelming OpenRouter
    for (const agent of agents) {
      await ctx.runAction(internal.rocklaw.compact.compactAgent, {
        agentName: agent.name,
        workspacePath: agent.workspacePath,
      });
    }

    console.log('[compact] Compaction complete');
  },
});

// ── Compact one agent ────────────────────────────────────────────────────────

export const compactAgent = internalAction({
  args: {
    agentName: v.string(),
    workspacePath: v.string(),
  },
  handler: async (_ctx, { agentName, workspacePath }) => {
    const absPath = path.resolve(workspacePath);
    const results: string[] = [];

    // 1. MEMORY.md
    const memoryPath = path.join(absPath, '05_MEMORY.md');
    const memResult = await compactIfOver(
      memoryPath,
      MEMORY_LINE_THRESHOLD,
      (content) => summariseWithLLM(content, MEMORY_PROMPT(agentName)),
      agentName,
      'MEMORY',
    );
    if (memResult) results.push(memResult);

    // 2. self/beliefs.md
    const beliefsPath = path.join(absPath, 'self', 'beliefs.md');
    const belResult = await compactIfOver(
      beliefsPath,
      BELIEFS_LINE_THRESHOLD,
      (content) => summariseWithLLM(content, BELIEFS_PROMPT(agentName)),
      agentName,
      'beliefs',
    );
    if (belResult) results.push(belResult);

    // 3. self/messages/sent_log.md
    const sentLogPath = path.join(absPath, 'self', 'messages', 'sent_log.md');
    const sentResult = await compactSentLog(sentLogPath, agentName);
    if (sentResult) results.push(sentResult);

    // 4. self/social/*/private.md
    const socialDir = path.join(absPath, 'self', 'social');
    try {
      const entries = await fs.readdir(socialDir);
      for (const entry of entries) {
        const privatePath = path.join(socialDir, entry, 'private.md');
        const socialResult = await compactIfOver(
          privatePath,
          SOCIAL_LINE_THRESHOLD,
          (content) => summariseWithLLM(content, SOCIAL_PROMPT(agentName, entry)),
          agentName,
          `social/${entry}`,
        );
        if (socialResult) results.push(socialResult);
      }
    } catch {
      // social/ directory may not exist yet if no relationships formed
    }

    if (results.length > 0) {
      console.log(`[compact] ${agentName}: ${results.join(', ')}`);
    }
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Reads a file, checks line count against threshold.
 * If over, calls compact() to get new content and writes it back.
 * Returns a summary string on compact, null otherwise.
 */
async function compactIfOver(
  filePath: string,
  threshold: number,
  compact: (content: string) => Promise<string>,
  agentName: string,
  label: string,
): Promise<string | null> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    return null; // file doesn't exist yet
  }

  const lineCount = content.split('\n').length;
  if (lineCount <= threshold) return null;

  console.log(`[compact] ${agentName}/${label}: ${lineCount} lines > ${threshold}, compacting`);
  const compacted = await compact(content);
  await fs.writeFile(filePath, compacted, 'utf8');
  return `${label} ${lineCount}→${compacted.split('\n').length}L`;
}

/**
 * Compacts sent_log.md:
 *   - Count entries (lines starting with "- Day" or "- [")
 *   - If > threshold: keep last 5 verbatim, summarise the rest with LLM
 */
async function compactSentLog(filePath: string, agentName: string): Promise<string | null> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }

  const lines = content.split('\n');
  const entryLines = lines.filter((l) => l.startsWith('- '));
  if (entryLines.length <= SENT_LOG_ENTRY_THRESHOLD) return null;

  console.log(`[compact] ${agentName}/sent_log: ${entryLines.length} entries > ${SENT_LOG_ENTRY_THRESHOLD}`);

  const last5 = entryLines.slice(-5);
  const older = entryLines.slice(0, -5);

  // Summarise older entries with LLM
  const olderText = older.join('\n');
  const summary = await summariseWithLLM(olderText, SENT_LOG_PROMPT(agentName));

  const newContent = [
    `# Sent Log -- ${agentName}`,
    '',
    '## Summary of older messages',
    summary,
    '',
    '## Recent (last 5)',
    ...last5,
    '',
  ].join('\n');

  await fs.writeFile(filePath, newContent, 'utf8');
  return `sent_log ${entryLines.length}→${last5.length}+summary`;
}

// ── LLM summarisation ─────────────────────────────────────────────────────────

async function summariseWithLLM(content: string, systemPrompt: string): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    // No API key: do a simple line truncation as fallback
    console.warn('[compact] No OPENROUTER_API_KEY — falling back to line truncation');
    return truncateFallback(content);
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://rocklaw.sim',
        'X-Title': 'Rocklaw Compact',
      },
      body: JSON.stringify({
        model: 'google/gemini-flash-1.5',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: content },
        ],
        temperature: 0.3,
        max_tokens: 800,
      }),
    });

    if (!response.ok) throw new Error(`OpenRouter ${response.status}`);
    const data = await response.json() as any;
    return data.choices?.[0]?.message?.content ?? truncateFallback(content);
  } catch (err) {
    console.error('[compact] LLM summarisation failed:', err);
    return truncateFallback(content);
  }
}

/** Keep the last 60 lines as a hard fallback when the LLM is unavailable. */
function truncateFallback(content: string): string {
  const lines = content.split('\n');
  if (lines.length <= 60) return content;
  return ['[...earlier content trimmed...]', ...lines.slice(-60)].join('\n');
}

// ── Prompts ───────────────────────────────────────────────────────────────────

const MEMORY_PROMPT = (name: string) => `\
You are the memory keeper for ${name}, a character in a medieval village simulation.
Summarise this memory log. The output will replace the original file.
Rules:
- Preserve every named incident that still has consequences (debts, grudges, promises, discoveries)
- Preserve the emotional arc: who trusts who, who has been wronged
- Preserve any secrets or sensitive knowledge
- Drop trivial daily routines unless they reveal character
- Keep under 80 lines
- Write in the same first-person tone as the original
- Do NOT add any meta-commentary like "(compacted)" — just write the content`;

const BELIEFS_PROMPT = (name: string) => `\
You are the belief keeper for ${name}, a character in a medieval village simulation.
Summarise these beliefs. The output will replace the original file.
Rules:
- Preserve core convictions about how the world works
- Preserve beliefs about specific people (trust, suspicion, respect)
- Preserve beliefs about their own role and purpose
- Drop beliefs that were clearly superseded by new ones
- Keep under 30 lines
- Write in the same first-person tone as the original`;

const SOCIAL_PROMPT = (name: string, otherName: string) => `\
You are summarising ${name}'s private feelings about ${otherName} in a medieval village simulation.
Summarise this relationship history. The output will replace the original file.
Rules:
- Preserve specific incidents that shaped the relationship
- Capture the emotional trajectory clearly (trust → betrayal, indifference → affection, etc.)
- Keep the current emotional temperature legible
- Keep under 20 lines
- Write in the same first-person tone as the original`;

const SENT_LOG_PROMPT = (name: string) => `\
Summarise these older sent letters from ${name} in a medieval village simulation.
Write a brief paragraph (3-5 lines) capturing:
- Who was written to most
- The general tone and purpose of the correspondence
- Any significant letters that had consequences
Be concise. This is an archive summary, not a full record.`;

// ── DB query ──────────────────────────────────────────────────────────────────

export const getAllAgents = internalQuery({
  args: {},
  handler: async (ctx) => {
    return ctx.db.query('rl_agents').collect();
  },
});
