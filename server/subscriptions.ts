/**
 * server/subscriptions.ts
 * WebSocket subscription manager.
 *
 * Clients send:  { type: 'subscribe',   id: string, queryName: string, args: unknown }
 *                { type: 'unsubscribe', id: string }
 * Server sends:  { type: 'result', id: string, value: unknown }
 *                { type: 'error',  id: string, message: string }
 *
 * After any mutation touches a table, all subscriptions that depend on that
 * table are re-evaluated and updated results are pushed to subscribers.
 */

import type { WebSocket } from 'ws';
import type { LocalCtx } from './ctx.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type QueryHandler = (ctx: LocalCtx, args: unknown) => unknown | Promise<unknown>;

interface Subscription {
  id: string;          // client-chosen subscription ID
  queryName: string;
  args: unknown;
  ws: WebSocket;
  lastResultJson: string;
}

// Static map: table name → query names that depend on it.
// When a table changes, we re-run all listed queries for subscribed clients.
const TABLE_DEPS: Record<string, string[]> = {
  rl_world_state:    ['world.defaultWorldStatus', 'world.worldState'],
  rl_agents:         ['world.worldState', 'rocklaw.god.getDashboard', 'world.userStatus'],
  rl_locations:      ['world.worldState', 'rocklaw.god.getDashboard'],
  rl_world_events:   ['rocklaw.god.getDashboard'],
  rl_market_prices:  ['rocklaw.god.getDashboard', 'rocklaw.observe.getPriceHistory'],
  rl_price_history:  ['rocklaw.observe.getPriceHistory'],
  rl_reputation:     ['rocklaw.god.getDashboard'],
  rl_actions_log:    ['rocklaw.god.getDashboard'],
  rl_systems_state:  ['rocklaw.systems.getSystems'],
  rl_social_knowledge: ['rocklaw.observe.getRelationships'],
  rl_interactions:   ['rocklaw.god.getDashboard'],
  rl_transactions:   ['rocklaw.god.getDashboard'],
  rl_chat_scenes:    ['rocklaw.god.getDashboard'],
  rl_chat_messages:  ['rocklaw.god.getDashboard'],
  messages:          ['messages.listMessages'],
  worlds:            ['world.worldState', 'world.gameDescriptions'],
  worldStatus:       ['world.defaultWorldStatus', 'world.worldState'],
  playerDescriptions: ['world.gameDescriptions'],
  agentDescriptions:  ['world.gameDescriptions'],
};

// ─── Manager ─────────────────────────────────────────────────────────────────

let _instance: SubscriptionManager | null = null;

export function getSubscriptionManager(): SubscriptionManager | null {
  return _instance;
}

export function createSubscriptionManager(getCtx: () => LocalCtx): SubscriptionManager {
  _instance = new SubscriptionManager(getCtx);
  return _instance;
}

export class SubscriptionManager {
  private getCtx: () => LocalCtx;
  private queryRegistry = new Map<string, QueryHandler>();
  // Map: subscriptionId → Subscription
  private subscriptions = new Map<string, Subscription>();
  // Map: ws → Set of subscriptionIds
  private clientSubs = new Map<WebSocket, Set<string>>();

  constructor(getCtx: () => LocalCtx) {
    this.getCtx = getCtx;
  }

  registerQuery(name: string, handler: QueryHandler) {
    this.queryRegistry.set(name, handler);
  }

  // Called when a new WebSocket client connects
  addClient(ws: WebSocket) {
    this.clientSubs.set(ws, new Set());

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'subscribe') {
          this._handleSubscribe(ws, msg.id, msg.queryName, msg.args ?? {});
        } else if (msg.type === 'unsubscribe') {
          this._handleUnsubscribe(ws, msg.id);
        }
      } catch (err) {
        console.error('[subscriptions] Bad message:', err);
      }
    });

    ws.on('close', () => {
      this._removeClient(ws);
    });
  }

  // Called by DbClient after any write to a table
  notifyTableChanged(table: string) {
    const affectedQueries = TABLE_DEPS[table] ?? [];
    if (affectedQueries.length === 0) return;

    const affectedSet = new Set(affectedQueries);
    for (const sub of this.subscriptions.values()) {
      if (affectedSet.has(sub.queryName)) {
        this._pushUpdate(sub);
      }
    }
  }

  // Push a result update to a single subscription
  private async _pushUpdate(sub: Subscription) {
    try {
      const handler = this.queryRegistry.get(sub.queryName);
      if (!handler) return;
      const result = await handler(this.getCtx(), sub.args);
      const json = JSON.stringify(result ?? null);
      if (json === sub.lastResultJson) return; // no change, skip push
      sub.lastResultJson = json;
      if (sub.ws.readyState === 1 /* OPEN */) {
        sub.ws.send(JSON.stringify({ type: 'result', id: sub.id, value: result ?? null }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (sub.ws.readyState === 1) {
        sub.ws.send(JSON.stringify({ type: 'error', id: sub.id, message }));
      }
    }
  }

  private async _handleSubscribe(ws: WebSocket, id: string, queryName: string, args: unknown) {
    const sub: Subscription = { id, queryName, args, ws, lastResultJson: '' };
    this.subscriptions.set(id, sub);
    this.clientSubs.get(ws)?.add(id);
    // Immediately send current value
    await this._pushUpdate(sub);
  }

  private _handleUnsubscribe(ws: WebSocket, id: string) {
    this.subscriptions.delete(id);
    this.clientSubs.get(ws)?.delete(id);
  }

  private _removeClient(ws: WebSocket) {
    const subs = this.clientSubs.get(ws);
    if (subs) {
      for (const id of subs) {
        this.subscriptions.delete(id);
      }
    }
    this.clientSubs.delete(ws);
  }
}
