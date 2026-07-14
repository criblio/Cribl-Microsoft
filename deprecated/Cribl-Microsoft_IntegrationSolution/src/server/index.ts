// Web Server Entry Point
// Replaces Electron's main process with an Express server.
// All IPC handlers are exposed as POST /api/{channel} routes.
// The React frontend calls fetch('/api/{channel}', { body }) instead of ipcRenderer.invoke().

// MUST be first: stub Electron APIs before any module imports electron
import Module from 'module';
import path from 'path';
const electronStubPath = path.resolve(__dirname, 'electron-stub');
const origResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...args: any[]) {
  if (request === 'electron') {
    return electronStubPath;
  }
  return origResolve.call(this, request, ...args);
};

import express from 'express';
import cors from 'cors';
import path from 'path';
import { initAppPaths } from '../main/ipc/app-paths';
import { createApiRouter } from './api-router';
import { createEventBus } from './event-bus';

const PORT = parseInt(process.env.PORT || '3001', 10);
const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Initialize app data directories
initAppPaths();

// Event bus for server->client push (replaces Electron's sender.send)
const eventBus = createEventBus();

// Download .crbl file endpoint
import fs from 'fs';
app.get('/api/pack/download', (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath || !fs.existsSync(filePath) || !filePath.endsWith('.crbl')) {
    res.status(404).json({ error: 'File not found' });
    return;
  }
  const fileName = filePath.split(/[/\\]/).pop() || 'pack.crbl';
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Type', 'application/gzip');
  res.sendFile(filePath);
});

// File upload endpoint (replaces Electron's dialog.showOpenDialog)
import multer from 'multer';
import { parseSampleContent } from '../main/ipc/sample-parser';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
app.post('/api/samples/upload-files', upload.array('files', 20), (req, res) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      res.json([]);
      return;
    }
    const results = files.map((file) => {
      const content = file.buffer.toString('utf-8');
      return parseSampleContent(content, file.originalname);
    });
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Mount the API router (all IPC handlers as REST endpoints)
const apiRouter = createApiRouter(eventBus);
app.use('/api', apiRouter);

// SSE endpoint for push events (replaces ipcRenderer.on)
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('data: {"type":"connected"}\n\n');

  const listener = (event: { channel: string; data: unknown }) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  eventBus.on('push', listener);

  req.on('close', () => {
    eventBus.off('push', listener);
  });
});

// Serve static React frontend in production
const distPath = path.resolve(__dirname, '../../dist');
app.use(express.static(distPath));
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(distPath, 'index.html'));
  }
});

app.listen(PORT, () => {
  console.log(`Cribl SOC Optimization Toolkit server running at http://localhost:${PORT}`);
  console.log(`API: http://localhost:${PORT}/api`);
  console.log(`Events: http://localhost:${PORT}/api/events`);
});
