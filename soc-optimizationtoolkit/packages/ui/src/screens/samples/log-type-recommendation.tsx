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

export interface LogTypeRecommendationProps {
  /** The derived recommendation (pure; see sample-coverage-state). */
  recommendation: Recommendation;
}

export function LogTypeRecommendation({
  recommendation,
}: LogTypeRecommendationProps) {
  const { status, headline, entries, unreferenced } = recommendation;

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
                entry.provided
                  ? "log-type-recommendation-have"
                  : "log-type-recommendation-need"
              }
            >
              <span className="log-type-recommendation-name">{entry.value}</span>
              <span className="log-type-recommendation-state">
                {entry.provided ? "provided" : "not provided"}
              </span>
              {/* The provenance, so the operator can judge the suggestion
                  rather than take it on faith: which field the content compares
                  against, and how many detections depend on it. */}
              <span className="field-hint">
                {entry.field}, referenced by {entry.referenceCount} detection
                {entry.referenceCount === 1 ? "" : "s"}
              </span>
            </li>
          ))}
        </ul>
      )}

      {unreferenced.length > 0 && (
        <p className="field-hint">
          Also provided, referenced by no detection (fine - a vendor emits more
          than any one solution detects on): {unreferenced.join(", ")}.
        </p>
      )}

      {/* The limit, stated where the claim is made rather than in a doc nobody
          opens. Only shown once there is a claim to qualify. */}
      {entries.length > 0 && (
        <p className="field-hint">
          Derived from this solution's detections, so it is a minimum, not a
          catalog - rules that filter a whole table, and ASIM-normalized rules,
          name no log type. Provide anything else your environment sends.
        </p>
      )}
    </div>
  );
}
