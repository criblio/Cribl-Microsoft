// Local-shell browser Logger adapter (porting-plan Unit 3): the @soc/core
// Logger port over a batched, fire-and-forget POST /api/logs to the loopback
// host, which appends the entries to data/logs/app.log (rotation and the
// pinned line format live host-side in src/host/logger.mjs). The browser
// keeps NO log store of its own - the host log file is the single source of
// truth, and the Logs screen reads it back via GET /api/logs?tail=500.
//
// Batching: entries queue in memory and flush as ONE POST when the queue
// reaches LOG_BATCH_MAX entries or LOG_FLUSH_INTERVAL_MS after the first
// queued entry, whichever comes first - so a chatty usecase run costs a
// couple of loopback requests, not one per line. Flushes are fire-and-forget
// (logging never changes control flow); a failed POST drops that batch,
// which is acceptable for diagnostics and keeps failure handling out of
// every logging call site.
//
// TIME: this adapter stamps entries with new Date().toISOString() at log
// time (core never reads clocks); the host preserves adapter-provided
// timestamps so file order and entry time can honestly disagree by a few
// seconds of batching delay.
//
// HARD RULE inheritance: LogContext admits only string | number | boolean |
// null, so no secret object can reach this adapter; the host additionally
// re-sanitizes every shipped entry before writing (defense in depth - the
// endpoint is reachable by anything on loopback).

import type { LogContext, LogEntry, LogLevel, Logger } from '@soc/core';
import { fetchWithTimeout } from './local-adapters';

/** Queue size that triggers an immediate flush. */
export const LOG_BATCH_MAX = 20;

/** How long a queued entry waits (at most) before its batch flushes. */
export const LOG_FLUSH_INTERVAL_MS = 3000;

// Short bound for the fire-and-forget POST: a wedged host must not pile up
// pending log requests.
const LOG_POST_TIMEOUT_MS = 5000;

/**
 * The local shell's Logger. Construct ONE instance for the page's lifetime
 * (module scope in local-app.tsx) and hand it to makeLocalPorts so usecases
 * invoked with the ports bundle log for free.
 */
export class HostLogger implements Logger {
  private queue: LogEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

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

  /**
   * Ship the queued entries now (fire-and-forget). Called automatically by
   * the batching rules; the Logs screen also calls it before reading the
   * host tail so just-logged entries are on their way.
   */
  flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.queue.length === 0) {
      return;
    }
    const entries = this.queue;
    this.queue = [];
    void fetchWithTimeout(
      '/api/logs',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries }),
      },
      LOG_POST_TIMEOUT_MS,
    ).catch(() => undefined);
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
    this.queue.push(entry);
    if (this.queue.length >= LOG_BATCH_MAX) {
      this.flush();
      return;
    }
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flush(), LOG_FLUSH_INTERVAL_MS);
    }
  }
}
