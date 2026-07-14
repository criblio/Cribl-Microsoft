/**
 * logs-state: the pure layer behind LogsScreen (porting-plan Unit 3).
 *
 * The interesting piece is {@link parseLogLine}: the LOCAL shell's log truth
 * is the host's app.log file, whose records are formatLogLine lines (the
 * format is PINNED by @soc/core log-model tests). Parsing a line back yields
 * a LogEntry whose message carries the rest of the line verbatim (message +
 * rendered k=v context together - the two cannot be split apart reliably, and
 * do not need to be), so formatLogLine(parseLogLine(line)) reproduces the
 * original line exactly. That round-trip is what lets ONE LogsScreen filter
 * and render entries from BOTH shells: the cloud shell hands it real
 * in-memory entries, the local shell hands it re-parsed file lines, and core
 * filterLogEntries / buildSupportBundle work identically over either.
 *
 * Everything here is deterministic and IO-free; tests build their input
 * lines with the REAL @soc/core formatLogLine so any drift in the pinned
 * format breaks these tests, not the viewer.
 */

import { LOG_LEVELS } from "@soc/core";
import type { LogEntry, LogFilter, LogLevel } from "@soc/core";

/** Fixed name of the downloaded support bundle (delivered via ArtifactSink). */
export const SUPPORT_BUNDLE_FILENAME = "support-bundle.txt";

/** How many recent job records the support bundle includes (newest first). */
export const RECENT_JOBS_LIMIT = 20;

/** Options for the level filter select: 'all' plus the four levels. */
export const LEVEL_FILTER_OPTIONS = Object.freeze([
  "all",
  ...LOG_LEVELS,
] as const);

// One formatLogLine record: `{iso} [{LEVEL padded to 5}] [job:{id}]? {rest}`.
// The timestamp never contains whitespace (ISO 8601), the level column is an
// upper-case word padded with spaces, and the optional job tag precedes the
// message. Everything after that single separating space is the rest of the
// record (message plus rendered context), kept verbatim.
const LINE_RE = /^(\S+) \[([A-Z]+) *\](?: \[job:([^\]]+)\])? (.*)$/;

const LEVEL_SET: ReadonlySet<string> = new Set(LOG_LEVELS);

/**
 * Parse one formatLogLine record back into a LogEntry, or null when the line
 * does not match the pinned format (e.g. a hand-edited or truncated record).
 * The returned entry has no `context`: the rendered k=v pairs stay inside
 * `message`, which keeps the round-trip exact (see module doc).
 */
export function parseLogLine(line: string): LogEntry | null {
  const match = LINE_RE.exec(line);
  if (match === null) {
    return null;
  }
  const level = match[2].toLowerCase();
  if (!LEVEL_SET.has(level)) {
    return null;
  }
  const entry: LogEntry = {
    timestamp: match[1],
    level: level as LogLevel,
    message: match[4],
  };
  if (match[3] !== undefined) {
    entry.jobId = match[3];
  }
  return entry;
}

/**
 * {@link parseLogLine} with a tolerant fallback: an unparseable line becomes
 * an info entry carrying the raw line as its message (empty timestamp), so a
 * foreign line in the host log is still VISIBLE in the viewer and the bundle
 * rather than silently dropped.
 */
export function logLineToEntry(line: string): LogEntry {
  return parseLogLine(line) ?? { timestamp: "", level: "info", message: line };
}

/** The three filter inputs as they arrive from the screen's controls. */
export interface LogFilterInputs {
  /** 'all' or one of the LOG_LEVELS (minimum severity). */
  level: string;
  /** Exact job id; blank means no job filter. */
  jobId: string;
  /** Case-insensitive substring over the formatted line; blank = no filter. */
  text: string;
}

/**
 * Turn the raw control values into a core {@link LogFilter}: 'all' or an
 * unknown level value means no level filter, and blank (after trimming)
 * jobId/text inputs do not filter.
 */
export function buildLogFilter(inputs: LogFilterInputs): LogFilter {
  const filter: LogFilter = {};
  if (LEVEL_SET.has(inputs.level)) {
    filter.level = inputs.level as LogLevel;
  }
  const jobId = inputs.jobId.trim();
  if (jobId !== "") {
    filter.jobId = jobId;
  }
  const text = inputs.text.trim();
  if (text !== "") {
    filter.text = text;
  }
  return filter;
}
