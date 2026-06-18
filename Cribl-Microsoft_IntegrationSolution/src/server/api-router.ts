// API Router - Converts all IPC handlers to Express routes.
// Instead of modifying each handler module, we intercept ipcMain.handle()
// calls and register them as POST routes.

import { Router, Request, Response } from 'express';
import { EventBus, createFakeEvent } from './event-bus';
import { pathToChannel } from '../api/channels';

// Collected handlers from the registration phase
const handlers = new Map<string, (event: any, args: any) => Promise<any>>();

// Fake IpcMain that captures handle() registrations
function createFakeIpcMain() {
  return {
    handle(channel: string, handler: (event: any, ...args: any[]) => Promise<any>) {
      // Wrap the handler to match our (event, args) signature
      handlers.set(channel, async (event: any, args: any) => {
        return handler(event, args);
      });
    },
    // Some modules may call other IpcMain methods -- stub them
    on() {},
    once() {},
    removeHandler() {},
    removeAllListeners() {},
  };
}

export function createApiRouter(eventBus: EventBus): Router {
  const router = Router();
  const fakeIpcMain = createFakeIpcMain();

  // Register all IPC handler modules from the single shared registry (the same list the
  // Electron main process uses in src/main/ipc/index.ts), so the two transports cannot drift.
  // Loaded lazily via dynamic import so the electron stub installed in server/index.ts is in
  // place before the handler modules import 'electron'.
  const registerAll = async () => {
    const { HANDLER_MODULES } = await import('../api/registry');
    for (const mod of HANDLER_MODULES) {
      mod.register(fakeIpcMain as any);
    }
    console.log(`Registered ${handlers.size} API handlers`);
  };

  // Run registration (async but we handle it)
  registerAll().catch((err) => {
    console.error('Failed to register handlers:', err);
  });

  // All requests handled as middleware.
  // Channel derived from URL path: /auth/status -> auth:status
  router.use((req: Request, res: Response) => {
    const rawPath = req.path.replace(/^\/+/, '');
    const channel = pathToChannel(rawPath);

    // Root listing
    if (!channel) {
      res.json({
        channels: Array.from(handlers.keys()).sort(),
        total: handlers.size,
      });
      return;
    }

    const handler = handlers.get(channel);
    if (!handler) {
      res.status(404).json({ error: `No handler: ${channel}`, path: req.path });
      return;
    }

    const fakeEvent = createFakeEvent(eventBus);
    const args = req.method === 'POST' ? req.body : (Object.keys(req.query).length > 0 ? req.query : undefined);

    handler(fakeEvent, args)
      .then((result) => { res.json(result ?? { success: true }); })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : '';
        console.error(`[API] ${channel} error:`, msg, '\n', stack);
        res.status(500).json({ error: msg, channel, stack });
      });
  });

  return router;
}
