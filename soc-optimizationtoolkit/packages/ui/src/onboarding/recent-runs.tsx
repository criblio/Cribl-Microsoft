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
import { InfoTip } from "../components/info-tip";
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

/**
 * How many runs show before "Show all" (DBT-125). The latest few answer "what
 * happened last time"; a page that printed every run ever recorded put thirty
 * rows under the deploy button.
 */
export const RECENT_RUNS_SHOWN = 5;

export function RecentRuns({
  refreshToken,
  kind = ONBOARD_TABLE_JOB_KIND,
  title = "Recent runs",
  label = runLabel,
  detail = runDetail,
}: RecentRunsProps) {
  const { ports } = usePorts();
  const [jobs, setJobs] = useState<JobRecord[] | null>(null);
  const [error, setError] = useState("");
  const [showAll, setShowAll] = useState(false);

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
      <span className="field-label">
        {title}{" "}
        <InfoTip text="The app's own run log - every recorded run, newest first, kept in this app's storage." />
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
        (showAll ? jobs : jobs.slice(0, RECENT_RUNS_SHOWN)).map((job) => (
          <details key={job.id}>
            <summary className="panel-desc">{label(job)}</summary>
            <pre className="result">{detail(job)}</pre>
          </details>
        ))}
      {jobs !== null && jobs.length > RECENT_RUNS_SHOWN && (
        <button className="run-button" onClick={() => setShowAll((v) => !v)}>
          {showAll
            ? `Show the latest ${RECENT_RUNS_SHOWN}`
            : `Show all ${jobs.length} runs`}
        </button>
      )}
    </div>
  );
}
