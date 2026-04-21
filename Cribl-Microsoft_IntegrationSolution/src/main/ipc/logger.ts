// Persistent Logger
// Writes all log entries to %APPDATA%/.cribl-microsoft/logs/app.log
// Log file persists across app executions. Rotated when it exceeds 10MB.

import fs from 'fs';
import path from 'path';

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ROTATED_FILES = 3;

let logDir: string | null = null;
let logFilePath: string | null = null;
let writeStream: fs.WriteStream | null = null;

function getLogDir(): string {
  if (logDir) return logDir;
  const appData = process.env.APPDATA || process.env.HOME || '';
  logDir = path.join(appData, '.cribl-microsoft', 'logs');
  return logDir;
}

function getLogFilePath(): string {
  if (logFilePath) return logFilePath;
  logFilePath = path.join(getLogDir(), 'app.log');
  return logFilePath;
}

function ensureLogDir(): void {
  const dir = getLogDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function rotateIfNeeded(): void {
  const filePath = getLogFilePath();
  try {
    if (!fs.existsSync(filePath)) return;
    const stats = fs.statSync(filePath);
    if (stats.size < MAX_LOG_SIZE) return;

    // Close current stream before rotating
    if (writeStream) {
      writeStream.end();
      writeStream = null;
    }

    // Shift existing rotated files (app.3.log -> deleted, app.2.log -> app.3.log, etc.)
    for (let i = MAX_ROTATED_FILES; i >= 1; i--) {
      const older = path.join(getLogDir(), `app.${i}.log`);
      if (i === MAX_ROTATED_FILES) {
        if (fs.existsSync(older)) fs.unlinkSync(older);
      } else {
        const newer = path.join(getLogDir(), `app.${i + 1}.log`);
        if (fs.existsSync(older)) fs.renameSync(older, newer);
      }
    }

    // Current -> app.1.log
    fs.renameSync(filePath, path.join(getLogDir(), 'app.1.log'));
  } catch {
    // Rotation failed -- continue writing to current file
  }
}

function getStream(): fs.WriteStream {
  if (writeStream) return writeStream;
  ensureLogDir();
  rotateIfNeeded();
  writeStream = fs.createWriteStream(getLogFilePath(), { flags: 'a' });
  writeStream.on('error', () => {
    writeStream = null;
  });
  return writeStream;
}

function timestamp(): string {
  return new Date().toISOString();
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack || `${err.name}: ${err.message}`;
  }
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

function write(level: string, module: string, message: string, err?: unknown): void {
  const errStr = err !== undefined ? ` | ${formatError(err)}` : '';
  const line = `${timestamp()} [${level}] [${module}] ${message}${errStr}\n`;

  // Always write to log file
  try {
    getStream().write(line);
  } catch {
    // Last resort: can't write to log file
  }

  // Also write to console for dev visibility
  switch (level) {
    case 'ERROR':
      console.error(`[${module}] ${message}`, err !== undefined ? err : '');
      break;
    case 'WARN':
      console.warn(`[${module}] ${message}`, err !== undefined ? err : '');
      break;
    default:
      console.log(`[${module}] ${message}`);
      break;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const logger = {
  error(module: string, message: string, err?: unknown): void {
    write('ERROR', module, message, err);
  },

  warn(module: string, message: string, err?: unknown): void {
    write('WARN', module, message, err);
  },

  info(module: string, message: string): void {
    write('INFO', module, message);
  },

  debug(module: string, message: string): void {
    write('DEBUG', module, message);
  },

  /** Returns the path to the active log file */
  logFilePath(): string {
    return getLogFilePath();
  },

  /** Flush and close the write stream (call on app quit) */
  close(): void {
    if (writeStream) {
      writeStream.end();
      writeStream = null;
    }
  },
};

export default logger;
