import { IpcMain, BrowserWindow } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import crypto from 'crypto';
import { getLinkedRepo } from './app-paths';

const activeProcesses = new Map<string, ChildProcess>();

function getRepoRoot(): string {
  return getLinkedRepo() || '';
}

function generateId(): string {
  return crypto.randomBytes(8).toString('hex');
}

export function registerPowerShellHandlers(ipcMain: IpcMain) {
  ipcMain.handle('ps:execute', async (event, { script, args }: { script: string; args: string[] }) => {
    const id = generateId();
    const repoRoot = getRepoRoot();
    const fullScriptPath = path.resolve(repoRoot, script);

    const psArgs = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', fullScriptPath,
      ...args,
    ];

    const proc = spawn('powershell.exe', psArgs, {
      cwd: path.dirname(fullScriptPath),
      env: { ...process.env },
      windowsHide: true,
    });

    activeProcesses.set(id, proc);

    proc.stdout?.on('data', (data: Buffer) => {
      const sender = event.sender;
      if (!sender.isDestroyed()) {
        sender.send('ps:output', { id, stream: 'stdout', data: data.toString() });
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const sender = event.sender;
      if (!sender.isDestroyed()) {
        sender.send('ps:output', { id, stream: 'stderr', data: data.toString() });
      }
    });

    proc.on('close', (code: number | null) => {
      activeProcesses.delete(id);
      const sender = event.sender;
      if (!sender.isDestroyed()) {
        sender.send('ps:exit', { id, code });
      }
    });

    proc.on('error', (err: Error) => {
      activeProcesses.delete(id);
      const sender = event.sender;
      if (!sender.isDestroyed()) {
        sender.send('ps:output', { id, stream: 'stderr', data: `Process error: ${err.message}` });
        sender.send('ps:exit', { id, code: -1 });
      }
    });

    return { id, pid: proc.pid ?? -1 };
  });

  ipcMain.handle('ps:cancel', async (_event, { id }: { id: string }) => {
    const proc = activeProcesses.get(id);
    if (proc) {
      proc.kill('SIGTERM');
      activeProcesses.delete(id);
    }
  });
}

export function killAllProcesses() {
  for (const [id, proc] of activeProcesses) {
    proc.kill('SIGTERM');
    activeProcesses.delete(id);
  }
}
