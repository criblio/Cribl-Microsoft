// Cloud-shell Logger adapter (porting-plan Unit 3): the @soc/core Logger
// port over a bounded in-memory ring, with warn/error entries mirrored to
// ONE rolling plain KV entry so the most recent problems survive a reload.
//
// Division of labor: @soc/core log-model owns every pure decision (the ring
// append semantics, the pinned line format); this adapter owns TIME (it
// stamps entries with new Date().toISOString() - core never reads clocks)
// and IO (console mirroring in dev, the KV write).
//
// HARD RULE inheritance: the Logger port's LogContext admits only
// string | number | boolean | null, so nothing that reaches this adapter can
// carry a secret object; this module never adds anything of its own to an
// entry beyond the timestamp.
//
// KV mirror semantics: warn/error entries append their FORMATTED line to a
// bounded rolling array (last KV_MIRROR_MAX_LINES) persisted as one plain KV
// entry - one PUT per warn/error, which respects the platform write volume
// because warn/error are rare by design (debug/info stay in memory only).
// Writes are FIRE-AND-FORGET on the established race-timeout pattern
// (fetchWithTimeout): logging must never change control flow, so every
// failure here is swallowed. Writes are serialized through a promise chain
// so concurrent warn/error calls cannot interleave their read-modify-write.

import { appendLogEntry, formatLogLine } from '@soc/core';
import type { LogContext, LogEntry, LogLevel, Logger } from '@soc/core';
import { fetchWithTimeout, kvUrl } from './http';

/** Ring capacity: how many entries getRecent()/the Logs screen can show. */
export const LOG_RING_MAX_ENTRIES = 500;

/** Plain KV key holding the rolling warn/error lines (a JSON string array). */
export const LOG_KV_MIRROR_KEY = 'diagnosticsWarnLog';

/** How many warn/error lines the rolling KV entry keeps (newest last). */
export const KV_MIRROR_MAX_LINES = 100;

// Short timeout for the fire-and-forget KV writes: a slow bridge must not
// pile up queued log writes behind a hung request.
const KV_MIRROR_TIMEOUT_MS = 5000;

const CONSOLE_SINKS: Record<LogLevel, (line: string) => void> = {
  debug: (line) => console.debug(line),
  info: (line) => console.info(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

/**
 * The cloud shell's Logger. Construct ONE instance for the app's lifetime
 * (module scope in App.tsx) so the ring survives connection switches; the
 * ports factory receives it by reference.
 */
export class PlatformLogger implements Logger {
  private ring: readonly LogEntry[] = [];
  // null until the first warn/error seeds it from the stored KV entry, so
  // lines from a previous session roll instead of being clobbered.
  private kvLines: string[] | null = null;
  private kvChain: Promise<void> = Promise.resolve();
  private readonly mirrorToConsole: boolean;

  constructor(options?: { mirrorToConsole?: boolean }) {
    // Console mirroring is a dev affordance; the installed app stays quiet.
    this.mirrorToConsole = options?.mirrorToConsole ?? import.meta.env.DEV;
  }

  debug(message: string, context?: LogContext, jobId?: string): void {
    this.append('debug', message, context, jobId);
  }

  info(message: string, context?: LogContext, jobId?: string): void {
    this.append('info', message, context, jobId);
  }

  warn(message: string, context?: LogContext, jobId?: string): void {
    this.append('warn', message, context, jobId);
  }

  error(message: string, context?: LogContext, jobId?: string): void {
    this.append('error', message, context, jobId);
  }

  /** The recorded entries, oldest first (the Logs screen's data source). */
  getRecent(): readonly LogEntry[] {
    return this.ring;
  }

  private append(
    level: LogLevel,
    message: string,
    context?: LogContext,
    jobId?: string,
  ): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
    };
    if (context !== undefined) {
      entry.context = { ...context };
    }
    if (jobId !== undefined) {
      entry.jobId = jobId;
    }
    this.ring = appendLogEntry(this.ring, entry, LOG_RING_MAX_ENTRIES);
    if (this.mirrorToConsole) {
      CONSOLE_SINKS[level](formatLogLine(entry));
    }
    if (level === 'warn' || level === 'error') {
      this.mirrorToKv(formatLogLine(entry));
    }
  }

  // Append one formatted line to the rolling KV entry. Fire-and-forget: the
  // chain serializes writes and swallows every failure (a broken log sink is
  // this adapter's problem, never the caller's).
  private mirrorToKv(line: string): void {
    this.kvChain = this.kvChain
      .then(async () => {
        if (this.kvLines === null) {
          this.kvLines = await this.seedKvLines();
        }
        this.kvLines = [...this.kvLines, line].slice(-KV_MIRROR_MAX_LINES);
        await fetchWithTimeout(
          kvUrl(LOG_KV_MIRROR_KEY),
          { method: 'PUT', body: JSON.stringify(this.kvLines) },
          KV_MIRROR_TIMEOUT_MS,
        );
      })
      .catch(() => undefined);
  }

  // Tolerant read of the stored rolling array: any failure (missing key,
  // bridge timeout, garbage body) starts a fresh array - losing old mirror
  // lines is acceptable, breaking logging is not.
  private async seedKvLines(): Promise<string[]> {
    try {
      const res = await fetchWithTimeout(
        kvUrl(LOG_KV_MIRROR_KEY),
        undefined,
        KV_MIRROR_TIMEOUT_MS,
      );
      if (!res.ok) {
        return [];
      }
      const parsed: unknown = JSON.parse(await res.text());
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed
        .filter((item): item is string => typeof item === 'string')
        .slice(-KV_MIRROR_MAX_LINES);
    } catch {
      return [];
    }
  }
}
