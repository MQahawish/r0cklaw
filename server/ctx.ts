/**
 * server/ctx.ts
 * Convex-compatible context object passed to all ported handler functions.
 *
 * Implements the same API surface as Convex's ctx:
 *   ctx.db.get / insert / patch / replace / delete / query(...)
 *   ctx.scheduler.runAfter / runAt / cancel
 *   ctx.runQuery / ctx.runMutation / ctx.runAction
 *   ctx.storage.getUrl
 *
 * The DB query builder supports the full Convex filter DSL via in-memory
 * filtering (safe for local single-user use).
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { Scheduler } from './scheduler.js';
import { getSubscriptionManager } from './subscriptions.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type Doc = Record<string, unknown> & { _id: string; _creationTime: number };

export type FilterBuilder = {
  field: (name: string) => unknown;
  eq:  (a: unknown, b: unknown) => boolean;
  neq: (a: unknown, b: unknown) => boolean;
  lt:  (a: unknown, b: unknown) => boolean;
  lte: (a: unknown, b: unknown) => boolean;
  gt:  (a: unknown, b: unknown) => boolean;
  gte: (a: unknown, b: unknown) => boolean;
  and: (...conds: boolean[]) => boolean;
  or:  (...conds: boolean[]) => boolean;
  not: (cond: boolean) => boolean;
};

export interface LocalCtx {
  db: DbClient;
  scheduler: Scheduler;
  runQuery<T>(fn: (ctx: LocalCtx, args: unknown) => T | Promise<T>, args?: unknown): Promise<T>;
  runMutation<T>(fn: (ctx: LocalCtx, args: unknown) => T | Promise<T>, args?: unknown): Promise<T>;
  runAction<T>(fn: (ctx: LocalCtx, args: unknown) => T | Promise<T>, args?: unknown): Promise<T>;
  storage: { getUrl(storageId: string): Promise<string | null> };
}

// ─── Query Builder ───────────────────────────────────────────────────────────

class QueryBuilder {
  private rows: Doc[];
  private _order: 'asc' | 'desc' = 'asc';

  constructor(rows: Doc[]) {
    this.rows = rows;
  }

  filter(fn: (q: FilterBuilder) => boolean): this {
    this.rows = this.rows.filter(row => {
      const q = makeFilterBuilder(row);
      return fn(q);
    });
    return this;
  }

  withIndex(_indexName: string, fn: (q: FilterBuilder) => boolean): this {
    // Index is used for performance in Convex; here we just filter in memory.
    return this.filter(fn);
  }

  order(direction: 'asc' | 'desc'): this {
    this._order = direction;
    return this;
  }

  collect(): Doc[] {
    return this._order === 'desc' ? [...this.rows].reverse() : this.rows;
  }

  first(): Doc | null {
    const ordered = this.collect();
    return ordered[0] ?? null;
  }

  unique(): Doc | null {
    const ordered = this.collect();
    if (ordered.length > 1) {
      throw new Error(`unique() found ${ordered.length} documents`);
    }
    return ordered[0] ?? null;
  }

  take(n: number): Doc[] {
    return this.collect().slice(0, n);
  }
}

function makeFilterBuilder(row: Doc): FilterBuilder {
  return {
    field: (name: string) => {
      // Support dot-notation for nested JSON fields (e.g. 'data.type')
      if (name.includes('.')) {
        return name.split('.').reduce<unknown>((obj, key) => {
          if (obj && typeof obj === 'object') return (obj as Record<string, unknown>)[key];
          return undefined;
        }, row);
      }
      return row[name];
    },
    eq:  (a, b) => a === b,
    neq: (a, b) => a !== b,
    lt:  (a, b) => (a as number) < (b as number),
    lte: (a, b) => (a as number) <= (b as number),
    gt:  (a, b) => (a as number) > (b as number),
    gte: (a, b) => (a as number) >= (b as number),
    and: (...conds) => conds.every(Boolean),
    or:  (...conds) => conds.some(Boolean),
    not: (cond)    => !cond,
  };
}

// ─── Table → Column mapping ───────────────────────────────────────────────────
// Tables that store complex nested Convex documents as a single `dataJson` TEXT blob.
const JSON_BLOB_TABLES = new Set([
  'worlds', 'maps', 'playerDescriptions', 'agentDescriptions',
  'archivedPlayers', 'archivedAgents', 'memories', 'memoryEmbeddings',
]);

function rowToDoc(table: string, row: Record<string, unknown>): Doc {
  if (JSON_BLOB_TABLES.has(table) && row.dataJson) {
    const data = JSON.parse(row.dataJson as string);
    return { ...data, _id: row._id as string, _creationTime: row._creationTime as number };
  }

  // Expand any *Json columns back to their real key names
  const doc: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.endsWith('Json') && typeof v === 'string') {
      const realKey = k.slice(0, -4); // strip 'Json'
      try { doc[realKey] = JSON.parse(v); } catch { doc[realKey] = v; }
    } else if (typeof v === 'number' && (k === 'running' || k === 'busy' || k === 'paused' ||
               k === 'isDefault' || k === 'active' || k === 'blankSelf' ||
               k === 'interruptedContextPending')) {
      doc[k] = Boolean(v);
    } else {
      doc[k] = v;
    }
  }
  return doc as Doc;
}

function docToRow(table: string, doc: Record<string, unknown>): Record<string, unknown> {
  if (JSON_BLOB_TABLES.has(table)) {
    const { _id, _creationTime, ...rest } = doc;
    return { _id, _creationTime, dataJson: JSON.stringify(rest) };
  }

  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v)) {
      // Objects (non-array) → store as JSON
      row[`${k}Json`] = JSON.stringify(v);
    } else if (Array.isArray(v)) {
      row[`${k}Json`] = JSON.stringify(v);
    } else if (typeof v === 'boolean') {
      row[k] = v ? 1 : 0;
    } else {
      row[k] = v;
    }
  }
  return row;
}

// ─── DB Client ────────────────────────────────────────────────────────────────

export class DbClient {
  private rawDb: Database.Database;

  constructor(db: Database.Database) {
    this.rawDb = db;
  }

  get(id: string): Doc | null {
    // We don't know which table — scan all tables. In practice callers know the table.
    // This is a fallback; prefer typed helpers.
    for (const table of this._allTables()) {
      try {
        const row = this.rawDb.prepare(`SELECT * FROM ${table} WHERE _id=?`).get(id) as Record<string, unknown> | undefined;
        if (row) return rowToDoc(table, row);
      } catch { /* table may not exist yet */ }
    }
    return null;
  }

  getFromTable(table: string, id: string): Doc | null {
    const row = this.rawDb.prepare(`SELECT * FROM "${table}" WHERE _id=?`).get(id) as Record<string, unknown> | undefined;
    return row ? rowToDoc(table, row) : null;
  }

  insert(table: string, doc: Record<string, unknown>): string {
    const id = randomUUID();
    const ts = Date.now();
    const full = { ...doc, _id: id, _creationTime: ts };
    const row = docToRow(table, full);
    const cols = Object.keys(row).map(k => `"${k}"`).join(', ');
    const placeholders = Object.keys(row).map(() => '?').join(', ');
    this.rawDb
      .prepare(`INSERT INTO "${table}" (${cols}) VALUES (${placeholders})`)
      .run(...Object.values(row));
    this._notifyChange(table);
    return id;
  }

  patch(id: string, fields: Record<string, unknown>): void {
    const table = this._findTable(id);
    if (!table) throw new Error(`patch: document not found: ${id}`);
    this._patchInTable(table, id, fields);
  }

  patchInTable(table: string, id: string, fields: Record<string, unknown>): void {
    this._patchInTable(table, id, fields);
  }

  private _patchInTable(table: string, id: string, fields: Record<string, unknown>): void {
    if (JSON_BLOB_TABLES.has(table)) {
      // For JSON blob tables: merge fields into the stored JSON
      const existing = this.getFromTable(table, id);
      if (!existing) throw new Error(`patch: not found in ${table}: ${id}`);
      const merged = { ...existing, ...fields };
      const { _id, _creationTime, ...rest } = merged;
      this.rawDb
        .prepare(`UPDATE "${table}" SET dataJson=? WHERE _id=?`)
        .run(JSON.stringify(rest), id);
    } else {
      const row = docToRow(table, fields);
      delete row._id;
      delete row._creationTime;
      if (Object.keys(row).length === 0) return;
      const sets = Object.keys(row).map(k => `"${k}"=?`).join(', ');
      this.rawDb.prepare(`UPDATE "${table}" SET ${sets} WHERE _id=?`).run(...Object.values(row), id);
    }
    this._notifyChange(table);
  }

  replace(id: string, doc: Record<string, unknown>): void {
    const table = this._findTable(id);
    if (!table) throw new Error(`replace: document not found: ${id}`);
    const full = { ...doc, _id: id, _creationTime: Date.now() };
    const row = docToRow(table, full);
    const cols = Object.keys(row).map(k => `"${k}"`).join(', ');
    const placeholders = Object.keys(row).map(() => '?').join(', ');
    this.rawDb
      .prepare(`INSERT OR REPLACE INTO "${table}" (${cols}) VALUES (${placeholders})`)
      .run(...Object.values(row));
    this._notifyChange(table);
  }

  delete(id: string): void {
    const table = this._findTable(id);
    if (!table) return; // already gone
    this.rawDb.prepare(`DELETE FROM "${table}" WHERE _id=?`).run(id);
    this._notifyChange(table);
  }

  deleteFromTable(table: string, id: string): void {
    this.rawDb.prepare(`DELETE FROM "${table}" WHERE _id=?`).run(id);
    this._notifyChange(table);
  }

  query(table: string): QueryBuilder {
    const rows = this.rawDb.prepare(`SELECT * FROM "${table}" ORDER BY _creationTime ASC`).all() as Record<string, unknown>[];
    const docs = rows.map(r => rowToDoc(table, r));
    return new QueryBuilder(docs);
  }

  // Raw SQL escape hatch for performance-critical paths
  raw<T = unknown>(sql: string, ...params: unknown[]): T[] {
    return this.rawDb.prepare(sql).all(...params) as T[];
  }

  transaction<T>(fn: () => T): T {
    return this.rawDb.transaction(fn)();
  }

  private _findTable(id: string): string | null {
    for (const table of this._allTables()) {
      try {
        const row = this.rawDb.prepare(`SELECT _id FROM "${table}" WHERE _id=? LIMIT 1`).get(id);
        if (row) return table;
      } catch { /* skip */ }
    }
    return null;
  }

  private _allTables(): string[] {
    const rows = this.rawDb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[];
    return rows.map(r => r.name);
  }

  private _notifyChange(table: string) {
    // Notify subscription manager that this table changed
    getSubscriptionManager()?.notifyTableChanged(table);
  }
}

// ─── Context factory ──────────────────────────────────────────────────────────

export function makeCtx(db: Database.Database, scheduler: Scheduler): LocalCtx {
  const dbClient = new DbClient(db);

  const ctx: LocalCtx = {
    db: dbClient,
    scheduler,
    async runQuery(fn, args = {}) {
      return fn(ctx, args);
    },
    async runMutation(fn, args = {}) {
      // Wrap in SQLite transaction for atomicity
      return db.transaction(() => fn(ctx, args))() as ReturnType<typeof fn>;
    },
    async runAction(fn, args = {}) {
      return fn(ctx, args);
    },
    storage: {
      async getUrl(storageId: string) {
        // Music files are served as static assets; return a local URL.
        return `/storage/${storageId}`;
      },
    },
  };

  return ctx;
}
