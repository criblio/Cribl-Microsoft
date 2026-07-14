// Startup for the local host: load and validate config, then bind the HTTP
// server to 127.0.0.1 (loopback only - see server.mjs for the security
// posture). Exits non-zero with the loader's actionable message when the
// config is missing or malformed.

import { existsSync } from 'node:fs';
import { CONFIG_PATH, WEB_ROOT, loadLocalConfig } from './config.mjs';
import { createHostServer } from './server.mjs';

export async function main() {
  let loaded;
  try {
    loaded = await loadLocalConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  const { config, warnings } = loaded;

  const server = createHostServer(config);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `Port ${config.port} on 127.0.0.1 is already in use. ` +
          `Stop the other process or change "port" in ${CONFIG_PATH}.`
      );
    } else {
      console.error(`Server error: ${err.message}`);
    }
    process.exitCode = 1;
  });

  server.listen(config.port, '127.0.0.1', () => {
    console.log(`SOC Optimization Toolkit local host listening on http://127.0.0.1:${config.port}`);
    console.log(`  config: ${CONFIG_PATH}`);
    if (existsSync(WEB_ROOT)) {
      console.log(`  ui:     serving ${WEB_ROOT}`);
    } else {
      console.log(`  ui:     ${WEB_ROOT} not found - "/" serves build instructions until the web build runs`);
    }
    console.log('  note:   loopback-only, no API auth (single-operator tool); secrets never leave this process');
    for (const warning of warnings) {
      console.warn(`  warning: ${warning}`);
    }
  });
}
