/**
 * LogsScreen - the in-app diagnostics viewer (porting-plan Unit 3): the
 * shared surface over whatever the shell's Logger adapter recorded. The
 * cloud shell hands it the in-memory ring's entries; the local shell hands
 * it the host log tail re-parsed via logs-state parseLogLine. Filtering
 * (minimum level, exact job id, grep-style text over the FORMATTED line) and
 * rendering both go through the @soc/core log-model, so what the user sees
 * here is exactly what a support bundle carries.
 *
 * Download support bundle composes core buildSupportBundle from the current
 * entries, the most recent job records (JobStore, all kinds), and the
 * shell-provided platform facts, delivered through the ArtifactSink port.
 * Pure React over the ports: ZERO direct fetch or storage access here.
 */

import { useCallback, useEffect, useState } from "react";
import { buildSupportBundle, filterLogEntries, formatLogLine } from "@soc/core";
import type { LogContextValue, LogEntry } from "@soc/core";
import { usePorts } from "../../ports-context";
import {
  LEVEL_FILTER_OPTIONS,
  RECENT_JOBS_LIMIT,
  SUPPORT_BUNDLE_FILENAME,
  buildLogFilter,
} from "./logs-state";

export interface LogsScreenProps {
  /**
   * Shell-provided accessor for the recent log entries, oldest first (the
   * ring buffer's / log file's natural order). Called on mount and on
   * Refresh; it may hit the shell's log source (e.g. the local host's tail
   * endpoint) or just snapshot an in-memory ring.
   */
  getRecentLogs: () => Promise<readonly LogEntry[]>;
  /**
   * Shell facts for the support bundle's platform section (shell kind, app
   * id, mode, ...). Primitives only - the Logger hard rule applies to the
   * bundle exactly as it does to log context.
   */
  platformInfo: Record<string, LogContextValue>;
}

export function LogsScreen({ getRecentLogs, platformInfo }: LogsScreenProps) {
  const { ports } = usePorts();
  const [entries, setEntries] = useState<readonly LogEntry[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [level, setLevel] = useState<string>("all");
  const [jobId, setJobId] = useState("");
  const [text, setText] = useState("");
  const [bundleFeedback, setBundleFeedback] = useState("");
  const [bundleBusy, setBundleBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setEntries(await getRecentLogs());
      setLoadError("");
    } catch (err) {
      setLoadError(String(err));
    }
  }, [getRecentLogs]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered =
    entries === null
      ? []
      : filterLogEntries(entries, buildLogFilter({ level, jobId, text }));

  // Assemble and deliver the support bundle: fresh entries (unfiltered - a
  // support bundle must not depend on what the viewer happened to filter),
  // the newest job records across all kinds, and the shell's platform facts.
  const downloadBundle = async () => {
    setBundleBusy(true);
    setBundleFeedback("");
    try {
      const [bundleEntries, jobs] = await Promise.all([
        getRecentLogs(),
        ports.jobs.list(),
      ]);
      const bundle = buildSupportBundle({
        entries: bundleEntries,
        jobs: jobs.slice(0, RECENT_JOBS_LIMIT),
        platformInfo,
      });
      await ports.artifacts.save(
        SUPPORT_BUNDLE_FILENAME,
        "text/plain",
        bundle,
      );
      setBundleFeedback(
        `Download dispatched (${SUPPORT_BUNDLE_FILENAME}): ` +
          `${bundleEntries.length} log entries, ` +
          `${Math.min(jobs.length, RECENT_JOBS_LIMIT)} job records.`,
      );
    } catch (err) {
      setBundleFeedback(`Support bundle failed: ${String(err)}`);
    } finally {
      setBundleBusy(false);
    }
  };

  return (
    <section className="panel">
      <h2 className="panel-title">Logs</h2>
      <p className="panel-desc">
        Recent diagnostics recorded by this shell&apos;s logger. Secrets and
        tokens are excluded by construction - log context only ever carries
        primitive values, and sensitive material appears only as a redacted
        length. Filter by minimum level, exact job id, or grep-style text over
        the formatted line.
      </p>
      <div className="form-grid">
        <label className="field">
          <span className="field-label">Minimum level</span>
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            {LEVEL_FILTER_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Job id</span>
          <input
            type="text"
            value={jobId}
            onChange={(e) => setJobId(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="exact job id"
          />
        </label>
        <label className="field">
          <span className="field-label">Text</span>
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="substring, case-insensitive"
          />
        </label>
      </div>
      <div className="panel-controls">
        <button className="run-button" onClick={() => void load()}>
          Refresh
        </button>
        <button
          className="run-button"
          onClick={() => void downloadBundle()}
          disabled={bundleBusy}
        >
          Download support bundle
        </button>
        {entries !== null && (
          <span className="field-hint">
            showing {filtered.length} of {entries.length} entries
          </span>
        )}
      </div>
      {loadError !== "" && <pre className="result">{loadError}</pre>}
      {bundleFeedback !== "" && <p className="panel-desc">{bundleFeedback}</p>}
      {entries !== null && entries.length === 0 && loadError === "" && (
        <p className="panel-desc">No log entries recorded yet.</p>
      )}
      {filtered.length > 0 && (
        <pre className="result">
          {filtered.map(formatLogLine).join("\n")}
        </pre>
      )}
      {entries !== null && entries.length > 0 && filtered.length === 0 && (
        <p className="panel-desc">No entries match the current filter.</p>
      )}
    </section>
  );
}
