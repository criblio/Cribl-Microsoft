import { IpcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import { configDir, appDataRoot } from './app-paths';

function getRepoRoot(): string {
  return configDir();
}

export function registerConfigHandlers(ipcMain: IpcMain) {
  ipcMain.handle('config:read', async (_event, { filePath }: { filePath: string }) => {
    const repoRoot = getRepoRoot();
    const fullPath = path.resolve(repoRoot, filePath);

    if (!fullPath.startsWith(repoRoot)) {
      throw new Error('Access denied: path outside repository');
    }

    if (!fs.existsSync(fullPath)) {
      throw new Error(`Config file not found: ${filePath}`);
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    return JSON.parse(content);
  });

  ipcMain.handle('config:write', async (_event, { filePath, data }: { filePath: string; data: Record<string, unknown> }) => {
    const repoRoot = getRepoRoot();
    const fullPath = path.resolve(repoRoot, filePath);

    if (!fullPath.startsWith(repoRoot)) {
      throw new Error('Access denied: path outside repository');
    }

    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(fullPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  });

  ipcMain.handle('config:repo-root', async () => {
    return appDataRoot();
  });
}
