/**
 * File Compaction -- Phase 6
 *
 * Runs every 10 ticks. For each agent, checks growing files against thresholds
 * and compacts them: either by trimming (no LLM) or by LLM summarisation.
 *
 * Thresholds (from spec):
 *   MEMORY.md                > 150 lines  → LLM summary (preserve incidents + emotional arc)
 *   HEARTBEAT.md          managed inline in appendHeartbeat -- not touched here
 *   SELF.md                  > 120 lines  → LLM summary (preserve durable self-state)
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';

// ── Thresholds ────────────────────────────────────────────────────────────────

const MEMORY_LINE_THRESHOLD   = 150;
const BELIEFS_LINE_THRESHOLD  = 60;
const SENT_LOG_ENTRY_THRESHOLD = 20;
const SOCIAL_LINE_THRESHOLD   = 80;

// ── DB query ──────────────────────────────────────────────────────────────────

export const getAllAgents = internalQuery({
  args: {},
  handler: async (ctx) => {
    return ctx.db.query('rl_agents').collect();
  },
});
