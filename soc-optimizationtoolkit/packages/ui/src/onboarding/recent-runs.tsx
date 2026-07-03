/**
 * RecentRuns - the app's run log, rendered from the persisted JobStore
 * records. Every onboard-table run (including failures) is stored with its
 * step-by-step statuses, timestamps, and outcome, so this list survives
 * reloads and answers "what did the app do, when, and where" without any
 * external logging system. Pure React over the ports: zero direct IO.
 */

import { useCallback, useEffect, useState } from "react";
import { ONBOARD_TABLE_JOB_KIND } from "@soc/core";
import type { JobRecord, OnboardTableOutcome } from "@soc/core";
import { usePorts } from "../ports-context";
import { formatStepLine } from "./step-line";
import { summaryText } from "./summary";

/** One-line label for a run: when, what table, terminal status. */
function runLabel(job: JobRecord): string {
  const table =
    (job.input as { table?: string } | null | undefined)?.table ??
    "(unknown table)";
  return `${job.updatedAt}  ${table}  [${job.status}]`;
}

/** Expanded detail: the recorded steps plus the outcome or error. */
function runDetail(job: JobRecord): string {
  const lines = job.steps.map(formatStepLine);
  if (job.result !== undefined && job.result !== null) {
    lines.push("", summaryText(job.result as OnboardTableOutcome));
  }
  if (job.error !== undefined) {
    lines.push("", `error: ${job.error}`);
  }
  return lines.join("\n");
}

export interface RecentRunsProps {
  /** Bump to reload the list (e.g. after a run completes). */
  refreshToken: number;
}

export function RecentRuns({ refreshToken }: RecentRunsProps) {
  const { ports } = usePorts();
  const [jobs, setJobs] = useState<JobRecord[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setJobs(await ports.jobs.list(ONBOARD_TABLE_JOB_KIND));
      setError("");
    } catch (err) {
      setError(String(err));
    }
  }, [ports.jobs]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  return (
    <div className="discovery-result">
      <span className="field-label">
        Recent runs (persisted job records - the app&apos;s run log)
      </span>
      <div className="panel-controls">
        <button className="run-button" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {error !== "" && <pre className="result">{error}</pre>}
      {jobs !== null && jobs.length === 0 && (
        <p className="panel-desc">No runs recorded yet in this app context.</p>
      )}
      {jobs !== null &&
        jobs.map((job) => (
          <details key={job.id}>
            <summary className="panel-desc">{runLabel(job)}</summary>
            <pre className="result">{runDetail(job)}</pre>
          </details>
        ))}
    </div>
  );
}
