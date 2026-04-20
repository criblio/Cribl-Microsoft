import { IpcMain } from 'electron';
import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { isRepoLinked, getLinkedRepo, configDir } from './app-paths';

export interface DepStatus {
  name: string;
  description: string;
  required: boolean;
  installed: boolean;
  version: string;
  installHint: string;
}

function checkCommand(cmd: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 10000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, output: '' });
        } else {
          resolve({ ok: true, output: (stdout || stderr || '').trim() });
        }
      });
    } catch {
      resolve({ ok: false, output: '' });
    }
  });
}

function extractVersion(output: string): string {
  const match = output.match(/(\d+\.\d+[\.\d]*)/);
  return match ? match[1] : 'unknown';
}

async function checkPowerShell(): Promise<DepStatus> {
  // Try pwsh first (PowerShell 7+), then powershell.exe (5.1)
  let result = await checkCommand('pwsh', ['--version']);
  if (result.ok) {
    return {
      name: 'PowerShell',
      description: 'Required to run all automation scripts',
      required: true,
      installed: true,
      version: extractVersion(result.output),
      installHint: '',
    };
  }
  result = await checkCommand('powershell.exe', ['-Command', '$PSVersionTable.PSVersion.ToString()']);
  if (result.ok) {
    return {
      name: 'PowerShell',
      description: 'Required to run all automation scripts',
      required: true,
      installed: true,
      version: extractVersion(result.output),
      installHint: '',
    };
  }
  return {
    name: 'PowerShell',
    description: 'Required to run all automation scripts',
    required: true,
    installed: false,
    version: '',
    installHint: 'Install PowerShell 7+: winget install Microsoft.PowerShell',
  };
}

async function checkAzModule(): Promise<DepStatus> {
  const result = await checkCommand('powershell.exe', [
    '-NoProfile', '-Command',
    "if (Get-Module -ListAvailable -Name Az.Accounts) { (Get-Module -ListAvailable Az.Accounts | Select-Object -First 1).Version.ToString() } else { 'NOT_FOUND' }",
  ]);
  const installed = result.ok && !result.output.includes('NOT_FOUND') && result.output.length > 0;
  return {
    name: 'Az PowerShell Module',
    description: 'Required for Azure resource management (DCR deployment, discovery, labs)',
    required: true,
    installed,
    version: installed ? extractVersion(result.output) : '',
    installHint: 'Install-Module -Name Az -Repository PSGallery -Force -Scope CurrentUser',
  };
}

async function checkAzLogin(): Promise<DepStatus> {
  const result = await checkCommand('powershell.exe', [
    '-NoProfile', '-Command',
    "try { $ctx = Get-AzContext -ErrorAction Stop; if ($ctx -and $ctx.Account) { $ctx.Account.Id } else { 'NOT_LOGGED_IN' } } catch { 'NOT_LOGGED_IN' }",
  ]);
  const loggedIn = result.ok && !result.output.includes('NOT_LOGGED_IN') && result.output.length > 0;
  return {
    name: 'Azure Authentication',
    description: 'Active Azure session needed before running deployments or discovery',
    required: false,
    installed: loggedIn,
    version: loggedIn ? result.output.trim() : '',
    installHint: 'Connect-AzAccount',
  };
}

async function checkRepoStructure(): Promise<DepStatus> {
  const linked = isRepoLinked();
  const repoRoot = getLinkedRepo();
  return {
    name: 'Repository Structure',
    description: 'Cribl-Microsoft repository with automation scripts',
    required: true,
    installed: linked,
    version: linked && repoRoot ? repoRoot : '',
    installHint: linked ? '' : 'No repository linked. Use Settings to link a Cribl-Microsoft repository.',
  };
}

function checkNodeVersion(): DepStatus {
  const version = process.versions.node;
  const major = parseInt(version.split('.')[0], 10);
  return {
    name: 'Node.js',
    description: 'JavaScript runtime (18+ recommended)',
    required: true,
    installed: true,
    version: version,
    installHint: major < 18 ? 'Upgrade Node.js to 18+: https://nodejs.org/' : '',
  };
}

function getIntegrationMode(): string {
  try {
    const modeFile = path.join(configDir(), 'integration-mode.json');
    if (fs.existsSync(modeFile)) {
      return JSON.parse(fs.readFileSync(modeFile, 'utf-8')).mode || 'full';
    }
  } catch { /* default */ }
  return 'full';
}

export function registerDepsHandlers(ipcMain: IpcMain) {
  ipcMain.handle('deps:check', async () => {
    const mode = getIntegrationMode();
    const needsAzure = mode === 'full' || mode === 'azure-only';
    const needsCribl = mode === 'full' || mode === 'cribl-only';

    const ps = await checkPowerShell();
    const az = await checkAzModule();
    const azLogin = await checkAzLogin();
    const repo = await checkRepoStructure();
    const node = checkNodeVersion();

    // Adjust required flags based on integration mode
    if (!needsAzure) {
      ps.required = false;
      ps.description = 'Required for Azure deployment (not needed in current mode)';
      az.required = false;
      az.description = 'Required for Azure resource management (not needed in current mode)';
      azLogin.description = 'Azure session (not needed in current mode)';
    }

    return [node, ps, az];
  });

  ipcMain.handle('deps:install', async (event, { command }: { command: string }) => {
    return new Promise<{ success: boolean; output: string }>((resolve) => {
      const proc = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command,
      ], { windowsHide: true });

      let output = '';
      proc.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        output += text;
        if (!event.sender.isDestroyed()) {
          event.sender.send('ps:output', { id: 'deps-install', stream: 'stdout', data: text });
        }
      });
      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        output += text;
        if (!event.sender.isDestroyed()) {
          event.sender.send('ps:output', { id: 'deps-install', stream: 'stderr', data: text });
        }
      });
      proc.on('close', (code) => {
        resolve({ success: code === 0, output });
      });
      proc.on('error', (err) => {
        resolve({ success: false, output: err.message });
      });
    });
  });
}
