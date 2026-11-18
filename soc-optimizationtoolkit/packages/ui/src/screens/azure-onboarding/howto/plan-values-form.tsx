/**
 * PlanValuesForm - the names and ids every How-to step is written against
 * (AZR-31, ADR 0007 D4). One field per core PLAN_VALUE_KEYS entry, each with
 * its label and an (i) from PLAN_VALUE_LABELS.
 *
 * EDITS ARE A DRAFT UNTIL APPLY (D3). Field edits are never autosaved: the
 * draft lives here, and only Apply hands the whole set to the screen, which
 * writes the progress document. When a stored value changes (a save landed,
 * section 1 picked an Event Hub) that field of the draft takes the new value;
 * an edit in progress in any other field is kept.
 *
 * NO CREDENTIAL IS EVER A PLAN VALUE. Core's sanitizePlanValue empties a value
 * shaped like a key or connection string before it is stored; the form says so
 * beside the field instead of letting it vanish silently on Apply.
 *
 * ONE EVENT HUB (AZR-102). The Event Hub names (subscription, resource group,
 * namespace, hub, Send rule) follow the section 1 picker unless the operator
 * chose their own: while they follow, those fields are read-only here and a
 * line says where they come from. One button switches between the two, and a
 * warning names any difference between section 1 and these names, because a
 * deploy writes to section 1's hub while the steps read these.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { PLAN_VALUE_KEYS, PLAN_VALUE_LABELS, sanitizePlanValue } from "@soc/core";
import type { EventHubSource, PlanValueKey, PlanValues } from "@soc/core";
import { InfoTip } from "../../../components/info-tip";
import { PickerLine } from "../eventhub-prerequisite-section";
import { FOLLOW_SECTION1_LABEL, USE_OWN_EVENT_HUB_LABEL } from "./howto-state";
import type { EventHubLinkView } from "./howto-state";

export interface PlanValuesFormProps {
  /** The stored values. */
  readonly values: PlanValues;
  /** True when progress cannot be written: fields and Apply are disabled. */
  readonly disabled: boolean;
  readonly onApply: (values: PlanValues) => void;
  /** Where the Event Hub names come from, and what that locks; absent = nothing locked. */
  readonly eventHub?: EventHubLinkView | null;
  /** Follow section 1, or keep the operator's own Event Hub names. */
  readonly onChooseEventHubSource?: (source: EventHubSource) => void;
}

/** Shown beside a field whose value looks like a credential. */
export const CREDENTIAL_REFUSED_NOTE =
  "This looks like a key or connection string. Only names are kept, so it will not be saved.";

/** Shown while the draft differs from the stored values. */
export const UNAPPLIED_NOTE = "Changes are not saved until you choose Apply.";

function sameValues(a: PlanValues, b: PlanValues): boolean {
  return PLAN_VALUE_KEYS.every((k) => a[k] === b[k]);
}

export function PlanValuesForm({ values, disabled, onApply, eventHub = null, onChooseEventHubSource }: PlanValuesFormProps) {
  const [draft, setDraft] = useState<PlanValues>(values);
  // When the STORED values change, compared by content so a re-render with an
  // equal object does nothing, each field that changed takes its stored value
  // and every other field keeps its edit in progress.
  const previous = useRef<PlanValues>(values);
  const storedKey = useMemo(() => JSON.stringify(PLAN_VALUE_KEYS.map((k) => values[k])), [values]);
  useEffect(() => {
    const before = previous.current;
    previous.current = values;
    setDraft((d) => {
      const next = { ...d } as Record<PlanValueKey, string>;
      for (const k of PLAN_VALUE_KEYS) if (values[k] !== before[k]) next[k] = values[k];
      return next;
    });
    // values is read through storedKey on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKey]);

  const locked = new Set<PlanValueKey>(eventHub?.lockedKeys ?? []);
  // A locked field always shows the stored value: it is not the form's to edit.
  const shown: PlanValues = Object.fromEntries(
    PLAN_VALUE_KEYS.map((k) => [k, locked.has(k) ? values[k] : draft[k]]),
  ) as PlanValues;
  const dirty = !sameValues(shown, values);
  const set = (key: PlanValueKey, value: string) => setDraft((d) => ({ ...d, [key]: value }));

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
          PLAN_VALUE_KEYS.map((k) => [k, sanitizePlanValue(shown[k])]),
        ) as PlanValues;
        setDraft(sanitized);
        if (!sameValues(sanitized, values)) onApply(sanitized);
      }}
    >
      {eventHub !== null && (
        <div data-testid="azo-plan-eventhub" data-follows={eventHub.follows ? "section1" : "own"}>
          <p className="field-hint">{eventHub.note}</p>
          {eventHub.drift !== null && <PickerLine message={{ tone: "warning", text: eventHub.drift }} />}
          {onChooseEventHubSource !== undefined && (
            <div className="panel-controls">
              <button
                type="button"
                className="run-button"
                disabled={disabled}
                onClick={() => onChooseEventHubSource(eventHub.follows ? "own" : "section1")}
              >
                {eventHub.follows ? USE_OWN_EVENT_HUB_LABEL : FOLLOW_SECTION1_LABEL}
              </button>
            </div>
          )}
        </div>
      )}
      <div className="form-grid">
        {PLAN_VALUE_KEYS.map((key) => {
          const label = PLAN_VALUE_LABELS[key];
          const refused = shown[key] !== "" && sanitizePlanValue(shown[key]) === "";
          const isLocked = locked.has(key);
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
                value={shown[key]}
                disabled={disabled}
                readOnly={isLocked}
                aria-readonly={isLocked ? true : undefined}
                data-locked={isLocked ? "section1" : undefined}
                onChange={(e) => {
                  if (!isLocked) set(key, e.target.value);
                }}
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
        <button type="submit" className="run-button" disabled={disabled || !dirty}>
          Apply
        </button>
        {dirty && <span className="field-hint">{UNAPPLIED_NOTE}</span>}
      </div>
    </form>
  );
}
