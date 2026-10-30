/**
 * PlanValuesForm - the names and ids every How-to step is written against
 * (AZR-31, ADR 0007 D4). One field per core PLAN_VALUE_KEYS entry, each with
 * its label and an (i) from PLAN_VALUE_LABELS.
 *
 * EDITS ARE A DRAFT UNTIL APPLY (D3). Field edits are never autosaved: the
 * draft lives here, and only Apply hands the whole set to the screen, which
 * writes the progress document. When the stored values change (a save landed,
 * another load answered) the draft is reset to them.
 *
 * NO CREDENTIAL IS EVER A PLAN VALUE. Core's sanitizePlanValue empties a value
 * shaped like a key or connection string before it is stored; the form says so
 * beside the field instead of letting it vanish silently on Apply.
 *
 * "Use the Event Hub picked above" copies the AZR-18 picker's names into the
 * DRAFT only - the operator still chooses Apply. The picker itself stays
 * React-only (its seeding is a separate card).
 */

import { useEffect, useMemo, useState } from "react";
import { PLAN_VALUE_KEYS, PLAN_VALUE_LABELS, sanitizePlanValue } from "@soc/core";
import type { PlanValueKey, PlanValues } from "@soc/core";
import { InfoTip } from "../../../components/info-tip";

export interface PlanValuesFormProps {
  /** The stored values. */
  readonly values: PlanValues;
  /** True when progress cannot be written: fields and Apply are disabled. */
  readonly disabled: boolean;
  readonly onApply: (values: PlanValues) => void;
  /** The AZR-18 picker's names, or null/absent when nothing is picked. */
  readonly pickedValues?: Partial<PlanValues> | null;
}

/** Shown beside a field whose value looks like a credential. */
export const CREDENTIAL_REFUSED_NOTE =
  "This looks like a key or connection string. Only names are kept, so it will not be saved.";

/** Shown while the draft differs from the stored values. */
export const UNAPPLIED_NOTE = "Changes are not saved until you choose Apply.";

function sameValues(a: PlanValues, b: PlanValues): boolean {
  return PLAN_VALUE_KEYS.every((k) => a[k] === b[k]);
}

export function PlanValuesForm({ values, disabled, onApply, pickedValues }: PlanValuesFormProps) {
  const [draft, setDraft] = useState<PlanValues>(values);
  // Reset the draft when the STORED values change, compared by content so a
  // re-render with an equal object does not throw away an edit in progress.
  const storedKey = useMemo(() => JSON.stringify(PLAN_VALUE_KEYS.map((k) => values[k])), [values]);
  useEffect(() => {
    setDraft(values);
    // values is read through storedKey on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKey]);

  const dirty = !sameValues(draft, values);
  const set = (key: PlanValueKey, value: string) => setDraft((d) => ({ ...d, [key]: value }));
  const picked =
    pickedValues === null || pickedValues === undefined
      ? []
      : PLAN_VALUE_KEYS.filter((k) => (pickedValues[k] ?? "") !== "");

  return (
    <form
      className="azo-plan-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled || !dirty) return;
        // Apply keeps names only: a credential-shaped value is emptied here
        // too, so it does not linger in the field (or in React state) after
        // Apply claims to have kept what is shown.
        const sanitized = Object.fromEntries(
          PLAN_VALUE_KEYS.map((k) => [k, sanitizePlanValue(draft[k])]),
        ) as PlanValues;
        setDraft(sanitized);
        if (!sameValues(sanitized, values)) onApply(sanitized);
      }}
    >
      <div className="form-grid">
        {PLAN_VALUE_KEYS.map((key) => {
          const label = PLAN_VALUE_LABELS[key];
          const refused = draft[key] !== "" && sanitizePlanValue(draft[key]) === "";
          return (
            <label key={key} className="field">
              <span className="field-label">
                {label.label}
                <InfoTip text={label.info} />
              </span>
              <input
                type="text"
                name={key}
                aria-label={label.label}
                autoComplete="off"
                spellCheck={false}
                value={draft[key]}
                disabled={disabled}
                onChange={(e) => set(key, e.target.value)}
              />
              {refused && (
                <span className="field-hint" role="alert">
                  {CREDENTIAL_REFUSED_NOTE}
                </span>
              )}
            </label>
          );
        })}
      </div>
      <div className="panel-controls">
        {picked.length > 0 && (
          <button
            type="button"
            className="run-button"
            disabled={disabled}
            onClick={() =>
              setDraft((d) => {
                const next = { ...d };
                for (const k of picked) next[k] = pickedValues?.[k] ?? "";
                return next;
              })
            }
          >
            Use the Event Hub picked above
          </button>
        )}
        <button type="submit" className="run-button" disabled={disabled || !dirty}>
          Apply
        </button>
        {dirty && <span className="field-hint">{UNAPPLIED_NOTE}</span>}
      </div>
    </form>
  );
}
