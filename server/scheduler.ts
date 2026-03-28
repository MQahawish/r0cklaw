/**
 * server/scheduler.ts
 * setTimeout-based scheduler that persists jobs to SQLite.
 * Replaces Convex's ctx.scheduler (runAfter, runAt).
 *
 * Jobs survive restarts: on startup, load pending jobs and re-arm them.
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';

export type ScheduledFn = (ctx: unknown, args: unknown) => Promise<void> | void;

interface ScheduledJob {
  _id: string;
  fnName: string;
  argsJson: string;
  runAtMs: number;
  status: 'pending' | 'running' | 'done' | 'failed';
}

// Registry of all schedulable functions by name.
const fnRegistry = new Map<string, ScheduledFn>();

export function registerFn(name: string, fn: ScheduledFn) {
  fnRegistry.set(name, fn);
}

export class Scheduler {
  private db: Database.Database;
  private getCtx: () => unknown;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(db: Database.Database, getCtx: () => unknown) {
    this.db = db;
    this.getCtx = getCtx;
  }

  /** Schedule a function to run after `delayMs` milliseconds. */
  runAfter(delayMs: number, fnNameOrFn: string | ScheduledFn, args: unknown): string {
    const fnName = typeof fnNameOrFn === 'string' ? fnNameOrFn : fnNameOrFn.name;
    return this._schedule(fnName, args, Date.now() + delayMs);
  }

  /** Schedule a function to run at a specific timestamp (unix ms). */
  runAt(timestampMs: number, fnNameOrFn: string | ScheduledFn, args: unknown): string {
    const fnName = typeof fnNameOrFn === 'string' ? fnNameOrFn : fnNameOrFn.name;
    return this._schedule(fnName, args, timestampMs);
  }

  /** Cancel a scheduled job by ID. */
  cancel(jobId: string) {
    const timer = this.timers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(jobId);
    }
    this.db.prepare(`UPDATE _scheduler SET status='done' WHERE _id=?`).run(jobId);
  }

  /** Load pending jobs from DB and re-arm them. Call once on startup. */
  resumePendingJobs() {
    const jobs = this.db
      .prepare(`SELECT * FROM _scheduler WHERE status='pending' ORDER BY runAtMs ASC`)
      .all() as ScheduledJob[];

    for (const job of jobs) {
      const delay = Math.max(0, job.runAtMs - Date.now());
      this._arm(job._id, job.fnName, JSON.parse(job.argsJson), delay);
    }
  }

  private _schedule(fnName: string, args: unknown, runAtMs: number): string {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO _scheduler (_id, fnName, argsJson, runAtMs, status) VALUES (?,?,?,?,?)`)
      .run(id, fnName, JSON.stringify(args ?? {}), runAtMs, 'pending');

    const delay = Math.max(0, runAtMs - Date.now());
    this._arm(id, fnName, args, delay);
    return id;
  }

  private _arm(id: string, fnName: string, args: unknown, delayMs: number) {
    const timer = setTimeout(async () => {
      this.timers.delete(id);
      this.db.prepare(`UPDATE _scheduler SET status='running' WHERE _id=?`).run(id);
      try {
        const fn = fnRegistry.get(fnName);
        if (!fn) {
          console.error(`[scheduler] Unknown function: ${fnName}`);
          this.db.prepare(`UPDATE _scheduler SET status='failed' WHERE _id=?`).run(id);
          return;
        }
        await fn(this.getCtx(), args);
        this.db.prepare(`UPDATE _scheduler SET status='done' WHERE _id=?`).run(id);
      } catch (err) {
        console.error(`[scheduler] Error running ${fnName}:`, err);
        this.db.prepare(`UPDATE _scheduler SET status='failed' WHERE _id=?`).run(id);
      }
    }, delayMs);

    this.timers.set(id, timer);
  }
}
