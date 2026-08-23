/**
 * LogTypeRecommendation - what the Browse Samples button was standing in front
 * of (ADR 0003, sample-acquisition plan Phase 2).
 *
 * The browser answered "which sample file should I use?" by scoring FILENAMES
 * against vendor keywords, never opening one. This answers the question the
 * operator actually has - "which log types does this solution need from me?" -
 * from the solution's own detections, and then leaves the fetching to them.
 *
 * ADVISORY. It renders no button, sets no state, and gates nothing. The
 * derivation behind it is explicitly a lower bound: rules that filter table-wide
 * contribute nothing, ASIM-normalized rules hide the discriminator behind a
 * parser, and a solution with no shipped detections yields an empty result -
 * which reads as "nothing to compare against", never as "you have everything".
 * Every decision is the pure deriveLogTypeRecommendation; this only renders.
 */

import type { LogTypeRecommendation as Recommendation } from "./sample-coverage-state";
import { evidenceLabel } from "./sample-coverage-state";

export interface LogTypeRecommendationProps {
  /** The derived recommendation (pure; see sample-coverage-state). */
  recommendation: Recommendation;
}

/**
 * The measured volume, or nothing at all.
 *
 * UNMEASURED RENDERS NOTHING - not "0", not "unknown", not a dash. Before a
 * Lake query runs, every entry is unmeasured, and a zero there would be the app
 * inventing a fact about the operator's data. Same refusal the core makes by
 * leaving `eventCount` undefined rather than defaulting it.
 */
function volumeText(eventCount: number | undefined): string | null {
  if (eventCount === undefined) return null;
  return `${eventCount.toLocaleString()} event${eventCount === 1 ? "" : "s"}`;
}

export function LogTypeRecommendation({
  recommendation,
}: LogTypeRecommendationProps) {
  const { status, headline, entries, unreferenced, volumeWindow } =
    recommendation;
  // Whether anything on this panel actually carries a number, which decides
  // whether the window note has something to qualify.
  const hasVolume =
    entries.some((e) => e.eventCount !== undefined) ||
    unreferenced.some((u) => u.eventCount !== undefined);

  return (
    <div className="log-type-recommendation" data-status={status}>
      <span className="field-label">Log types this solution needs</span>
      <p className="panel-desc">{headline}</p>

      {entries.length > 0 && (
        <ul className="log-type-recommendation-list">
          {entries.map((entry) => (
            <li
              key={entry.value}
              className={
                (entry.provided
                  ? "log-type-recommendation-have"
                  : "log-type-recommendation-need") +
                ` log-type-evidence-${entry.evidence}`
              }
            >
              <span className="log-type-recommendation-name">{entry.value}</span>
              <span className="log-type-recommendation-state">
                {entry.provided ? "provided" : "not provided"}
              </span>
              {/* The provenance, so the operator can judge the suggestion
                  rather than take it on faith. WHICH TIER matters most: a
                  shipped detection filtering on a value and a vendor merely
                  documenting a feed are different claims, and the second must
                  never wear the first's authority. */}
              <span className="field-hint">
                {entry.evidence === "vendor" ? (
                  <>
                    {evidenceLabel(entry.evidence)}
                    {entry.vendor !== undefined ? ` (${entry.vendor})` : ""}
                    {entry.doc !== undefined ? ` - ${entry.doc}` : ""}
                    {entry.docUrl !== undefined && (
                      <>
                        {" "}
                        <a
                          href={entry.docUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          docs
                        </a>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    {entry.field}, {evidenceLabel(entry.evidence)} -{" "}
                    {entry.referenceCount} item
                    {entry.referenceCount === 1 ? "" : "s"}
                  </>
                )}
                {/* The measured volume, stated beside the evidence rather than
                    in a column of its own: "a rule needs it" and "there is this
                    much of it" are two halves of one decision. It is a NUMBER
                    and nothing else - no threshold, no flag, no verdict. */}
                {volumeText(entry.eventCount) !== null && (
                  <span className="log-type-recommendation-volume">
                    {" - "}
                    {volumeText(entry.eventCount)}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {unreferenced.length > 0 && (
        <div className="log-type-unreferenced">
          <p className="field-hint">
            Also provided, referenced by no detection (fine - a vendor emits
            more than any one solution detects on):
          </p>
          {/* A LIST, not prose, because these now carry volumes and rank by
              them - the busiest log type nothing consumes sits at the top on
              its own. Still a note and never a gap: no warning styling, no
              count in any headline, nothing to fix. */}
          <ul className="log-type-unreferenced-list">
            {unreferenced.map((entry) => (
              <li key={entry.value}>
                <span className="log-type-recommendation-name">
                  {entry.value}
                </span>
                {volumeText(entry.eventCount) !== null && (
                  <span className="log-type-recommendation-volume">
                    {volumeText(entry.eventCount)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* A count without its window is not a fact. Rendered only when a number
          is actually on screen, so nothing is qualified into existence. */}
      {hasVolume && volumeWindow !== undefined && (
        <p className="field-hint">
          Volumes counted in the Lake dataset over {volumeWindow.earliest} to{" "}
          {volumeWindow.latest}, and describe what your environment sends - not
          what this solution needs.
        </p>
      )}

      {/* The limit, stated where the claim is made rather than in a doc nobody
          opens. Only shown once there is a claim to qualify. */}
      {entries.length > 0 && (
        <p className="field-hint">
          A minimum, not a catalog. Content-derived entries miss rules that
          filter a whole table and ASIM-normalized rules, which name no log
          type; vendor-derived entries say what the vendor emits, not what this
          solution needs. Provide anything else your environment sends.
        </p>
      )}
    </div>
  );
}
