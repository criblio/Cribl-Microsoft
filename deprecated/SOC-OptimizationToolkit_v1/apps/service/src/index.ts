// Service shell (Phase 0). The same usecases the GUI and CLI use, exposed over HTTP.
// Phase 1+ remounts each capability as a route (the electron-stub / api-router seam) with SSE progress.
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 4317);

const server = createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, phase: 0, destination: 'microsoft-sentinel' }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  console.log(
    `SOC Optimization Toolkit service (Phase 0 shell) listening on http://127.0.0.1:${PORT}`,
  );
});
