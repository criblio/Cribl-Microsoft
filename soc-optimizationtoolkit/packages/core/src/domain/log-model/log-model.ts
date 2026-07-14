/**
 * log-model: pure model behind in-app diagnostics (porting-plan Unit 3,
 * roadmap Phase 2 logger item). Everything here is deterministic and IO-free:
 * the ring buffer is an immutable append, timestamps arrive ON the entries
 * (injected by adapters - core never reads clocks), and the support bundle is
 * a pure function of its inputs.
 *
 * Line-format prior art: the legacy Electron logger wrote single-line
 * `{iso} [{LEVEL}] [{module}] {message} | {error}` records. That single-line
 * greppable spirit is kept with the new structure:
 *
 *   {iso} [{LEVEL padded to 5}] [job:{jobId}]? {message} {key=value ...}
 *
 * The exact format is PINNED by tests - change it deliberately, it is what
 * users grep and what support bundles carry.
 */

import type { LogContextValue, LogEntry, LogLevel } from "../../ports/logger";
import type { JobRecord } from "../../ports/job-store";

/** Log levels, lowest to highest severity. */
export const LOG_LEVELS = Object.freeze([
  "debug",
  "info",
  "warn",
  "error",
] as const);

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** Fixed level column width in a formatted line ("ERROR".length). */
const LEVEL_PAD = 5;

// ---------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------

/**
 * Append `entry` to `entries`, keeping at most `maxEntries` (the OLDEST
 * entries are dropped first). Always returns a NEW array; the input is never
 * mutated. A `maxEntries` of zero or less yields an empty buffer.
 */
export function appendLogEntry(
  entries: readonly LogEntry[],
  entry: LogEntry,
  maxEntries: number,
): LogEntry[] {
  const max = Math.floor(maxEntries);
  if (max <= 0) {
    return [];
  }
  const next = [...entries, entry];
  return next.length > max ? next.slice(next.length - max) : next;
}

// ---------------------------------------------------------------------------
// Line rendering
// ---------------------------------------------------------------------------

/**
 * Render one entry as a single greppable line:
 * ISO time, level padded to a fixed 5-char column, `[job:{id}]` tag when the
 * entry carries a jobId, the message (newlines escaped to a literal `\n`),
 * then one ` key=value` pair per context key in insertion order. String
 * values are emitted bare unless empty or containing whitespace, `"`, `=`,
 * or control characters - those are JSON-quoted so the line never breaks.
 */
export function formatLogLine(entry: LogEntry): string {
  const level = `[${entry.level.toUpperCase().padEnd(LEVEL_PAD)}]`;
  const jobTag = entry.jobId !== undefined ? ` [job:${entry.jobId}]` : "";
  let line = `${entry.timestamp} ${level}${jobTag} ${singleLine(entry.message)}`;
  if (entry.context !== undefined) {
    for (const [key, value] of Object.entries(entry.context)) {
      line += ` ${key}=${formatContextValue(value)}`;
    }
  }
  return line;
}

/** Escape newlines so a formatted record is always exactly one line. */
function singleLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, "\\n");
}

/** k=v value rendering: bare when safe, JSON-quoted when it would break. */
function formatContextValue(value: LogContextValue): string {
  if (typeof value === "string") {
    return value === "" || needsQuoting(value) ? JSON.stringify(value) : value;
  }
  return String(value);
}

/** True when a bare string would break k=v parsing or the single-line rule. */
function needsQuoting(value: string): boolean {
  if (/[\s"=]/.test(value)) {
    return true;
  }
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 0x20) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/** Criteria for {@link filterLogEntries}; absent fields do not filter. */
export interface LogFilter {
  /** MINIMUM severity: 'warn' keeps warn and error entries. */
  level?: LogLevel;
  /** Exact job id match. */
  jobId?: string;
  /**
   * Case-insensitive substring match against the FORMATTED line (so it finds
   * text in the message, the context keys/values, and the job tag alike -
   * exactly what a user would grep). An empty string does not filter.
   */
  text?: string;
}

/** Filter entries by minimum level, exact jobId, and formatted-line text. */
export function filterLogEntries(
  entries: readonly LogEntry[],
  filter: LogFilter,
): LogEntry[] {
  const needle = filter.text !== undefined ? filter.text.toLowerCase() : "";
  return entries.filter((entry) => {
    if (
      filter.level !== undefined &&
      LEVEL_WEIGHT[entry.level] < LEVEL_WEIGHT[filter.level]
    ) {
      return false;
    }
    if (filter.jobId !== undefined && entry.jobId !== filter.jobId) {
      return false;
    }
    if (needle !== "" && !formatLogLine(entry).toLowerCase().includes(needle)) {
      return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Support bundle
// ---------------------------------------------------------------------------

/**
 * Render one job record as a compact single line for the support bundle.
 * Deliberately EXCLUDES `input` and `result` (unknown-typed payloads have no
 * place in a diagnostics text file); the step list and error text tell the
 * story.
 */
export function formatJobLine(job: JobRecord): string {
  const steps = job.steps
    .map((step) => `${step.name}:${step.status}`)
    .join(",");
  let line =
    `${job.id} kind=${formatContextValue(job.kind)} status=${job.status}` +
    ` createdAt=${job.createdAt} updatedAt=${job.updatedAt} steps=[${steps}]`;
  if (job.error !== undefined) {
    line += ` error=${formatContextValue(job.error)}`;
  }
  return line;
}

/** Input for {@link buildSupportBundle}. */
export interface SupportBundleInput {
  /** Log entries, oldest first (the ring buffer's natural order). */
  entries: readonly LogEntry[];
  /** Recent job records, in the order they should be shown. */
  jobs: readonly JobRecord[];
  /** Shell-provided facts (shell kind, app version, ...); primitives only. */
  platformInfo: Record<string, LogContextValue>;
}

/**
 * Build the deterministic support-bundle text: a platform-info section, a
 * compact recent-jobs section, and the formatted log lines. Pure function of
 * its inputs - no clock reads, no ordering surprises (sections render their
 * inputs in the given/insertion order), so the same inputs always produce the
 * same bytes. Delivery (download via ArtifactSink) is the shell's job.
 */
export function buildSupportBundle(input: SupportBundleInput): string {
  const lines: string[] = [];
  lines.push("=== SOC Optimization Toolkit support bundle ===");
  lines.push("");

  lines.push("--- Platform ---");
  const platform = Object.entries(input.platformInfo);
  if (platform.length === 0) {
    lines.push("(none)");
  } else {
    for (const [key, value] of platform) {
      lines.push(`${key}=${formatContextValue(value)}`);
    }
  }
  lines.push("");

  lines.push(`--- Recent jobs (${input.jobs.length}) ---`);
  if (input.jobs.length === 0) {
    lines.push("(none)");
  } else {
    for (const job of input.jobs) {
      lines.push(formatJobLine(job));
    }
  }
  lines.push("");

  lines.push(`--- Log entries (${input.entries.length}) ---`);
  if (input.entries.length === 0) {
    lines.push("(none)");
  } else {
    for (const entry of input.entries) {
      lines.push(formatLogLine(entry));
    }
  }
  lines.push("");

  return lines.join("\n");
}
