/**
 * RecentRuns - the app's run log, rendered from the persisted JobStore
 * records. Every run (including failures) is stored with its step-by-step
 * statuses, timestamps, and outcome, so the log survives reloads and
 * answers "what did the app do, when, and where" without any external
 * logging system. It renders as ONE collapsed line - how many runs, and the
 * latest - opening to a dropdown of every run and the chosen run's detail
 * (DBT-125: a list of every run grew under the deploy button forever). Defaults render onboard-table records; other job kinds
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
  // The run whose detail is shown; null means the latest.
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  // COLLAPSED BY DEFAULT, one run at a time (operator direction 2026-10-05,
  // DBT-125). Every run used to render as its own row, so the log grew under
  // the deploy button with every deploy. The closed line keeps the count and
  // the latest run, which is what a glance needs; a dropdown reaches the rest.
  const latest = jobs !== null && jobs.length > 0 ? jobs[0] : undefined;
  const selected =
    jobs?.find((job) => job.id === selectedId) ?? latest;
  return (
    <details className="discovery-result recent-runs">
      <summary className="field-label">
        {title}
        {jobs === null
          ? ""
          : latest === undefined
            ? " - none recorded yet"
            : ` (${jobs.length}) - latest: ${label(latest)}`}{" "}
        <InfoTip text="The app's own run log - every recorded run, newest first, kept in this app's storage." />
      </summary>
      <div className="panel-controls">
        {jobs !== null && jobs.length > 0 && (
          <select
            aria-label="Choose a run"
            value={selected?.id ?? ""}
            onChange={(e) => setSelectedId(e.target.value)}
          >
            {jobs.map((job) => (
              <option key={job.id} value={job.id}>
                {label(job)}
              </option>
            ))}
          </select>
        )}
        <button className="run-button" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {error !== "" && <pre className="result">{error}</pre>}
      {selected !== undefined && <pre className="result">{detail(selected)}</pre>}
    </details>
  );
}
