/**
 * RecentRuns - the app's run log, rendered from the persisted JobStore
 * records. Every run (including failures) is stored with its step-by-step
 * statuses, timestamps, and outcome, so this list survives reloads and
 * answers "what did the app do, when, and where" without any external
 * logging system. Defaults render onboard-table records; other job kinds
 * (e.g. onboard-batch, porting-plan Unit 6) reuse the SAME list by passing
 * their kind plus label/detail renderers. Pure React over the ports: zero
 * direct IO.
 */

import { useCallback, useEffect, useState } from "react";
import { ONBOARD_TABLE_JOB_KIND } from "@soc/core";
import type { JobRecord, OnboardTableOutcome } from "@soc/core";
import { usePorts } from "../ports-context";
import { formatStepLine } from "./step-line";
import { summaryText } from "./summary";

/** One-line label for an onboard-table run: when, what table, status. */
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
  /** JobStore kind to list; defaults to onboard-table records. */
  kind?: string;
  /** Heading text; defaults to the onboard-table wording. */
  title?: string;
  /** One-line label per record; defaults to the onboard-table label. */
  label?: (job: JobRecord) => string;
  /** Expanded detail per record; defaults to the onboard-table detail. */
  detail?: (job: JobRecord) => string;
}

export function RecentRuns({
  refreshToken,
  kind = ONBOARD_TABLE_JOB_KIND,
  title = "Recent runs (persisted job records - the app's run log)",
  label = runLabel,
  detail = runDetail,
}: RecentRunsProps) {
  const { ports } = usePorts();
  const [jobs, setJobs] = useState<JobRecord[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setJobs(await ports.jobs.list(kind));
      setError("");
    } catch (err) {
      setError(String(err));
    }
  }, [ports.jobs, kind]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  return (
    <div className="discovery-result">
      <span className="field-label">{title}</span>
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
            <summary className="panel-desc">{label(job)}</summary>
            <pre className="result">{detail(job)}</pre>
          </details>
        ))}
    </div>
  );
}
