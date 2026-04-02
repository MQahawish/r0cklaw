/**
 * File Compaction -- Phase 6
 *
 * Runs every 10 ticks. For each agent, checks growing files against thresholds
 * and compacts them: either by trimming (no LLM) or by LLM summarisation.
 *
 * Thresholds (from spec):
 *   HEARTBEAT.md          managed inline in appendHeartbeat -- not touched here
 *   JOURNAL.md               > 160 lines  → LLM summary (preserve durable journal memory)
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';

// ── Thresholds ────────────────────────────────────────────────────────────────

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
