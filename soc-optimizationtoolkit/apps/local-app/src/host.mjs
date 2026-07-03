// @soc/local-app host entry. Thin by design: all host logic lives in
// src/host/ (config loading, API routing, Azure/leader proxies, file-backed
// secrets and jobs, static UI serving). See src/host/server.mjs for the API
// surface and apps/local-app/CONTEXT.md for status and security posture.

import { main } from './host/main.mjs';

await main();
