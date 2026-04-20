// API Router - Converts all IPC handlers to Express routes.
// Instead of modifying each handler module, we intercept ipcMain.handle()
// calls and register them as POST routes.

import { Router, Request, Response } from 'express';
import { EventBus, createFakeEvent } from './event-bus';

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

  // Register all IPC handler modules using the fake IpcMain.
  // Each module's registerXxxHandlers(ipcMain) call will populate the handlers map.
  // We do this synchronously during server startup.

  // Import and register all modules
  const registerAll = async () => {
    const { registerDepsHandlers } = await import('../main/ipc/deps');
    const { registerConfigHandlers } = await import('../main/ipc/config');
    const { registerGitHubHandlers } = await import('../main/ipc/github');
    const { registerPackBuilderHandlers } = await import('../main/ipc/pack-builder');
    const { registerVendorResearchHandlers } = await import('../main/ipc/vendor-research');
    const { registerRegistrySyncHandlers } = await import('../main/ipc/registry-sync');
    const { registerChangeDetectionHandlers } = await import('../main/ipc/change-detection');
    const { registerAzureDeployHandlers } = await import('../main/ipc/azure-deploy');
    const { registerParamFormHandlers } = await import('../main/ipc/param-forms');
    const { registerAuthHandlers } = await import('../main/ipc/auth');
    const { registerE2EHandlers } = await import('../main/ipc/e2e-orchestrator');
    const { registerSentinelRepoHandlers } = await import('../main/ipc/sentinel-repo');
    const { registerSampleParserHandlers } = await import('../main/ipc/sample-parser');
    const { registerPermissionCheckHandlers } = await import('../main/ipc/permission-check');
    const { registerDefaultSampleHandlers } = await import('../main/ipc/default-samples');
    const { registerFieldMatcherHandlers } = await import('../main/ipc/field-matcher');
    const { registerAppPathsHandlers } = await import('../main/ipc/app-paths');

    registerAppPathsHandlers(fakeIpcMain as any);
    registerDepsHandlers(fakeIpcMain as any);
    registerConfigHandlers(fakeIpcMain as any);
    registerGitHubHandlers(fakeIpcMain as any);
    registerPackBuilderHandlers(fakeIpcMain as any);
    registerVendorResearchHandlers(fakeIpcMain as any);
    registerRegistrySyncHandlers(fakeIpcMain as any);
    registerChangeDetectionHandlers(fakeIpcMain as any);
    registerAzureDeployHandlers(fakeIpcMain as any);
    registerParamFormHandlers(fakeIpcMain as any);
    registerAuthHandlers(fakeIpcMain as any);
    registerE2EHandlers(fakeIpcMain as any);
    registerSentinelRepoHandlers(fakeIpcMain as any);
    registerSampleParserHandlers(fakeIpcMain as any);
    registerPermissionCheckHandlers(fakeIpcMain as any);
    registerDefaultSampleHandlers(fakeIpcMain as any);
    registerFieldMatcherHandlers(fakeIpcMain as any);

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
    const channel = rawPath.replace(/\//g, ':');

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
