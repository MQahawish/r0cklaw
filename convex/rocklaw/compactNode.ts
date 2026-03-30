"use node";

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import * as fs from 'fs/promises';
import * as path from 'path';

const MEMORY_LINE_THRESHOLD = 150;
const SELF_LINE_THRESHOLD = 120;

export const runCompaction = internalAction({
  args: {},
  handler: async (ctx) => {
    const agents = await ctx.runQuery(internal.rocklaw.compact.getAllAgents);
    console.log(`[compact] Running compaction for ${agents.length} agents`);

    for (const agent of agents) {
      await ctx.runAction(internal.rocklaw.compactNode.compactAgent, {
        agentName: agent.name,
        workspacePath: agent.workspacePath,
      });
    }

    console.log('[compact] Compaction complete');
  },
});

export const compactAgent = internalAction({
  args: {
    agentName: v.string(),
    workspacePath: v.string(),
  },
  handler: async (_ctx, { agentName, workspacePath }) => {
    const absPath = resolveWorkspacePath(workspacePath);
    const results: string[] = [];

    const memoryPath = path.join(absPath, 'MEMORY.md');
    const memResult = await compactIfOver(
      memoryPath,
      MEMORY_LINE_THRESHOLD,
      (content) => summariseWithLLM(content, MEMORY_PROMPT(agentName)),
      agentName,
      'MEMORY',
    );
    if (memResult) results.push(memResult);

    const selfPath = path.join(absPath, 'SELF.md');
    const selfResult = await compactIfOver(
      selfPath,
      SELF_LINE_THRESHOLD,
      (content) => summariseWithLLM(content, SELF_PROMPT(agentName)),
      agentName,
      'self',
    );
    if (selfResult) results.push(selfResult);

    if (results.length > 0) {
      console.log(`[compact] ${agentName}: ${results.join(', ')}`);
    }
  },
});

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
    return null;
  }

  const lineCount = content.split('\n').length;
  if (lineCount <= threshold) return null;

  console.log(`[compact] ${agentName}/${label}: ${lineCount} lines > ${threshold}, compacting`);
  const compacted = await compact(content);
  await fs.writeFile(filePath, compacted, 'utf8');
  return `${label} ${lineCount}→${compacted.split('\n').length}L`;
}

async function summariseWithLLM(content: string, systemPrompt: string): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
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
        model: 'google/gemini-3.1-flash-lite-preview',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content },
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

function truncateFallback(content: string): string {
  const lines = content.split('\n');
  if (lines.length <= 60) return content;
  return ['[...earlier content trimmed...]', ...lines.slice(-60)].join('\n');
}

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

const SELF_PROMPT = (name: string) => `\
You are the self-state keeper for ${name}, a character in a medieval village simulation.
Summarise this self context file. The output will replace the original file.
Rules:
- Preserve current goals, plans, beliefs, desires, secrets, and relationship state that still matter
- Preserve commitments, grudges, trust changes, and emotionally meaningful relationship turns
- Drop superseded details and repetitive rumination
- Keep the section structure legible
- Keep under 60 lines
- Write in the same first-person tone as the original`;

function resolveWorkspacePath(workspacePath: string): string {
  if (path.isAbsolute(workspacePath)) return workspacePath;
  const root = process.env.ROCKLAW_PROJECT_ROOT || process.cwd();
  return path.resolve(root, workspacePath);
}
