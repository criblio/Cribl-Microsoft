import type { LogContext, LogEntry, Logger, LogLevel } from '../ports/logger';

/**
 * In-memory {@link Logger} for tests.
 *
 * Records every call as a full {@link LogEntry} on {@link entries}, in call
 * order. Timestamps come from the injectable clock (defaults to the real
 * time, matching the other fakes) so tests can assert on entry timestamps
 * deterministically. Context objects are copied defensively: mutating the
 * object a caller logged does not rewrite history.
 */
export class FakeLogger implements Logger {
  /** Every entry logged, in call order. Assert on this. */
  readonly entries: LogEntry[] = [];
  private readonly clock: () => string;

  /**
   * @param clock Optional ISO-timestamp source, e.g. a counter-backed fake
   *   clock for deterministic timestamp assertions.
   */
  constructor(clock?: () => string) {
    this.clock = clock ?? (() => new Date().toISOString());
  }

  debug(message: string, context?: LogContext, jobId?: string): void {
    this.record('debug', message, context, jobId);
  }

  info(message: string, context?: LogContext, jobId?: string): void {
    this.record('info', message, context, jobId);
  }

  warn(message: string, context?: LogContext, jobId?: string): void {
    this.record('warn', message, context, jobId);
  }

  error(message: string, context?: LogContext, jobId?: string): void {
    this.record('error', message, context, jobId);
  }

  /** Messages of the recorded entries at `level`, for compact assertions. */
  messagesAt(level: LogLevel): string[] {
    return this.entries
      .filter((entry) => entry.level === level)
      .map((entry) => entry.message);
  }

  private record(
    level: LogLevel,
    message: string,
    context?: LogContext,
    jobId?: string,
  ): void {
    const entry: LogEntry = { timestamp: this.clock(), level, message };
    if (context !== undefined) {
      entry.context = { ...context };
    }
    if (jobId !== undefined) {
      entry.jobId = jobId;
    }
    this.entries.push(entry);
  }
}
