/**
 * The overflow triage block of a mapping-review card: the terse count line, the
 * pairing warning, and the two name disclosures.
 *
 * EXTRACTED SO THE VISIBILITY IS TESTABLE (2026-08-18). This shipped once with
 * the "check the sample is the right one for this table" recommendation folded
 * into the count line's InfoTip - present in the DOM, invisible without a
 * hover. Every core pin passed, because the sentence WAS in `summary`; nothing
 * could see where it was rendered. Inline in a 1,500-line section it stayed
 * untestable, so the block moved here and got its own DOM pins.
 *
 * Presentational only: it decides nothing. The threshold, the sentence, and the
 * classification all come from triageOverflow in core.
 */

import type { OverflowTriage } from "@soc/core";
import { InfoTip } from "../../components/info-tip";

export interface OverflowTriageBlockProps {
  /** Total fields routed to the catch-all column. */
  overflowCount: number;
  /** The destination table the fields were checked against. */
  tableName: string;
  triage: OverflowTriage;
  /** The standing explainer; the triage summary is appended when present. */
  coverageNote: string;
}

export function OverflowTriageBlock({
  overflowCount,
  tableName,
  triage,
  coverageNote,
}: OverflowTriageBlockProps) {
  const hasTriage = triage.summary !== "";
  return (
    <>
      {overflowCount > 0 && (
        <p className="field-hint gap-overflow-note">
          Overflow: {overflowCount} field(s) preserved in the catch-all
          {hasTriage
            ? ` - ${triage.noEquivalentCount} unmappable, ${triage.outranked.length} outranked`
            : ""}
          .
          <InfoTip text={coverageNote + (hasTriage ? ` ${triage.summary}` : "")} />
        </p>
      )}

      {/* WHEN ALMOST NOTHING FITS, SAY SO IN THE OPEN - a plain paragraph, not
          a tooltip and not behind a disclosure. Nobody hovers to discover they
          picked the wrong table. */}
      {triage.pairingWarning !== "" && (
        <p className="field-hint gap-overflow-warning">{triage.pairingWarning}</p>
      )}

      {/* The fields with NO equivalent, by name. A count cannot be acted on;
          the names are what tell the operator whether this sample carries
          vendor detail the table has no room for, or whether it does not
          belong to this table at all (user request 2026-08-18). */}
      {triage.noEquivalent.length > 0 && (
        <details className="gap-overflow-triage">
          <summary className="field-hint">
            Fields with no {tableName} equivalent ({triage.noEquivalent.length})
          </summary>
          <ul className="field-hint">
            {triage.noEquivalent.map((name) => (
              <li key={`noeq-${name}`}>
                <code>{name}</code>
              </li>
            ))}
          </ul>
        </details>
      )}

      {triage.outranked.length > 0 && (
        <details className="gap-overflow-triage">
          <summary className="field-hint">
            Overflow fields with a close-named column ({triage.outranked.length})
          </summary>
          <ul className="field-hint">
            {triage.outranked.map((e) => (
              <li key={`out-${e.sourceName}`}>
                {e.sourceName}: closest column {e.column} is already claimed by
                the better-matching field {e.claimedBy}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
