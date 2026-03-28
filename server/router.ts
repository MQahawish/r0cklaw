/**
 * server/router.ts
 * Express HTTP router + WebSocket upgrade handler.
 *
 * Routes:
 *   WS  /                       → subscription WebSocket
 *   GET  /query/:name            → one-shot query (non-subscribed)
 *   POST /mutation/:name         → run mutation, push subscription updates
 *   POST /action/:name           → run action (async, returns result)
 *   GET  /storage/:id            → serve local storage files (music etc.)
 *   GET  /health                 → liveness check
 */

import express, { Request, Response, NextFunction } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import type { LocalCtx } from './ctx.js';
import type { SubscriptionManager } from './subscriptions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Handler registry ─────────────────────────────────────────────────────────

type Handler = (ctx: LocalCtx, args: unknown) => unknown | Promise<unknown>;

export const queryHandlers   = new Map<string, Handler>();
export const mutationHandlers = new Map<string, Handler>();
export const actionHandlers  = new Map<string, Handler>();

export function registerQuery(name: string, fn: Handler)    { queryHandlers.set(name, fn); }
export function registerMutation(name: string, fn: Handler) { mutationHandlers.set(name, fn); }
export function registerAction(name: string, fn: Handler)   { actionHandlers.set(name, fn); }

// ─── Server factory ───────────────────────────────────────────────────────────

export function createServer(
  getCtx: () => LocalCtx,
  subManager: SubscriptionManager,
  port: number = 3210,
  staticDir?: string,
): { httpServer: http.Server; wss: WebSocketServer } {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  // CORS for local Vite dev server
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, ts: Date.now() });
  });

  // One-shot query
  app.get('/query/:name', async (req: Request, res: Response) => {
    const name = (req.params.name as string).replace(/__/g, '.');
    const handler = queryHandlers.get(name);
    if (!handler) { res.status(404).json({ error: `Unknown query: ${name}` }); return; }
    try {
      const args = req.query.args ? JSON.parse(req.query.args as string) : {};
      const result = await handler(getCtx(), args);
      res.json({ result: result ?? null });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Mutation
  app.post('/mutation/:name', async (req: Request, res: Response) => {
    const name = (req.params.name as string).replace(/__/g, '.');
    const handler = mutationHandlers.get(name);
    if (!handler) { res.status(404).json({ error: `Unknown mutation: ${name}` }); return; }
    try {
      const result = await handler(getCtx(), req.body ?? {});
      res.json({ result: result ?? null });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Action
  app.post('/action/:name', async (req: Request, res: Response) => {
    const name = (req.params.name as string).replace(/__/g, '.');
    const handler = actionHandlers.get(name);
    if (!handler) { res.status(404).json({ error: `Unknown action: ${name}` }); return; }
    try {
      const result = await handler(getCtx(), req.body ?? {});
      res.json({ result: result ?? null });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Static file storage (music etc.)
  app.get('/storage/:id', (req: Request, res: Response) => {
    const storageDir = path.join(__dirname, '..', 'data', 'storage');
    const filePath = path.join(storageDir, req.params.id as string);
    if (!fs.existsSync(filePath)) { res.status(404).send('Not found'); return; }
    res.sendFile(filePath);
  });

  // Serve frontend static files if built
  if (staticDir && fs.existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }

  const httpServer = http.createServer(app);

  // WebSocket server (shares the HTTP server)
  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', (ws: WebSocket) => {
    subManager.addClient(ws);
  });

  httpServer.listen(port, '127.0.0.1', () => {
    console.log(`[server] Listening on http://127.0.0.1:${port}`);
  });

  return { httpServer, wss };
}
