/**
 * File Compaction -- Phase 6
 *
 * Runs every 10 ticks. For each agent, checks growing files against thresholds
 * and compacts them: either by trimming (no LLM) or by LLM summarisation.
 *
 * Markdown compaction targets have been removed from Rocklaw. The scheduler
 * remains in place as a no-op hook in case future runtime docs need pruning.
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
