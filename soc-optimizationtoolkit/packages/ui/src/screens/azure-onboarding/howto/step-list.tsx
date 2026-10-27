/**
 * StepList - the guided steps the chosen How-to sources need (AZR-31), one
 * row per howto-state StepRow:
 *
 *   - a done checkbox. Checked only for a tick taken against the CURRENT plan
 *     values (ADR 0007 D5); a stale tick shows unchecked with a note naming
 *     the values that changed, so ticking again re-confirms against them.
 *   - the step title, the sources that need it, the provenance tag of an
 *     inferred step, and what Validate last said (a verdict word).
 *   - an (i) with why the step exists, and an Instructions button that opens
 *     the step dialog.
 *
 * When ticks cannot be written, every checkbox is disabled and the reason is
 * shown once as visible text above the list.
 *
 * Presentational: no IO, no state of its own.
 */

import { InfoTip } from "../../../components/info-tip";
import type { StepRow } from "./howto-state";

export interface StepListProps {
  readonly rows: readonly StepRow[];
  readonly onToggleTick: (stepId: string, checked: boolean) => void;
  readonly onOpen: (stepId: string) => void;
}

export function StepList({ rows, onToggleTick, onOpen }: StepListProps) {
  const blockedReason = rows.find((r) => r.tickDisabled)?.tickDisabledReason ?? null;
  return (
    <>
      {blockedReason !== null && <p className="field-hint">{blockedReason}</p>}
      <ol className="azo-step-list">
        {rows.map((row) => (
          <li
            key={row.id}
            className="azo-step-row"
            data-step={row.id}
            data-tick={row.tick.status}
          >
            <label className="integrate-check">
              <input
                type="checkbox"
                aria-label={`Done: ${row.title}`}
                checked={row.done}
                disabled={row.tickDisabled}
                onChange={(e) => onToggleTick(row.id, e.target.checked)}
              />
              <span className="integrate-check-text">{row.title}</span>
            </label>
            <InfoTip text={row.info} />
            {row.tag !== null && <span className="azo-step-tag">{row.tag}</span>}
            <span className="field-hint">{`For: ${row.sourceTitles.join(", ")}`}</span>
            <span className="field-hint">{`Check: ${row.verdictWord}`}</span>
            {row.staleNote !== null && <p className="azo-step-stale">{row.staleNote}</p>}
            <button
              type="button"
              className="run-button"
              aria-label={`Instructions: ${row.title}`}
              onClick={() => onOpen(row.id)}
            >
              Instructions
            </button>
          </li>
        ))}
      </ol>
    </>
  );
}
