/**
 * Logger port: structured diagnostics for usecases and adapters (porting-plan
 * Unit 3, roadmap Phase 2 logger item).
 *
 * HARD RULE - NO SECRET OR TOKEN VALUE IS EVER LOGGABLE, BY CONSTRUCTION:
 * {@link LogContextValue} admits ONLY string | number | boolean | null.
 * There is deliberately no unknown / object / array passthrough, so whole
 * config objects, HTTP bodies, or credential records cannot ride into a log
 * entry by accident - callers must pick individual safe primitives (names,
 * ids, counts, flags). When a sensitive value must be REFERENCED ("a client
 * secret was provided"), log its shape via {@link redactedLength}, never the
 * value itself. Review enforces the rest: no code path may interpolate a
 * secret into a message string.
 *
 * Layering: pure domain modules stay log-free; usecases and adapters log
 * through this port, tagging entries with the jobId where applicable so a
 * run's diagnostics attach to its job record. Core never reads the clock -
 * the adapter behind the port stamps {@link LogEntry.timestamp} at write
 * time (entries carry timestamps INJECTED by adapters).
 *
 * Implementations:
 * - Cloud shell: bounded in-memory ring buffer (see domain/log-model), with
 *   warn/error mirrored to KV.
 * - Local shell: file log with rotation. The legacy Electron logger is prior
 *   art for the line format and rotation policy ONLY (10MB rotation, 3 kept
 *   files, single-line records) - it is reimplemented, never ported.
 */

/** Severity of a log entry, lowest to highest. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * The only values a log context may carry. Restricting context to these
 * primitives (no objects, no arrays, no unknown) is what makes the hard rule
 * structural: a secrets record or raw response body does not typecheck here.
 */
export type LogContextValue = string | number | boolean | null;

/** Structured key/value context attached to a log entry. Primitives only. */
export type LogContext = Record<string, LogContextValue>;

/** One structured log entry as stored, filtered, and rendered. */
export interface LogEntry {
  /** ISO 8601 timestamp, INJECTED by the adapter (core never reads clocks). */
  timestamp: string;
  level: LogLevel;
  /** Human-readable, single-purpose message; keep it constant and put the
   * variable parts in `context` so lines stay greppable. */
  message: string;
  /** Optional structured context; primitive values only (see hard rule). */
  context?: LogContext;
  /** Job the entry belongs to, when emitted inside a job run. */
  jobId?: string;
}

/**
 * The Logger port. Methods are fire-and-forget (void): logging must never
 * change control flow, and a failing sink is the adapter's problem. An
 * ABSENT logger anywhere it is optional means no-op - zero behavior change.
 */
export interface Logger {
  debug(message: string, context?: LogContext, jobId?: string): void;
  info(message: string, context?: LogContext, jobId?: string): void;
  warn(message: string, context?: LogContext, jobId?: string): void;
  error(message: string, context?: LogContext, jobId?: string): void;
}

/**
 * Reference a sensitive value in logs WITHOUT exposing it: returns
 * `<redacted:Nchars>` where N is the value's length. This is the ONE
 * sanctioned way sensitive material relates to a log entry - it proves a
 * value was present (and roughly its shape) while making the value itself
 * unrecoverable.
 *
 * Example: `redactedLength("hunter2secret")` returns `"<redacted:13chars>"`.
 */
export function redactedLength(value: string): string {
  return `<redacted:${value.length}chars>`;
}
