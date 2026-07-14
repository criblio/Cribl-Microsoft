/**
 * OptionsScreen - deployment and naming options as typed forms (porting-plan
 * Unit 4, ENG-43). Renders the two @soc/core option forms (operation, cribl)
 * from their FormField descriptors through ONE generic field renderer -
 * {@link OptionFieldRow} - which is the pattern later units (5-7, 20) reuse
 * for their own descriptor-driven panels.
 *
 * Persistence is shell-owned: the screen receives load/save callbacks over
 * ONE stored blob (cloud: the plain 'appOptions' KV entry; local: the same
 * key in the host secrets store) and keeps the RAW stored string so saves
 * flow through @soc/core applyOptionsPatch - unmanaged keys in the blob
 * survive every save (the merge-preserving contract pinned in core).
 *
 * Validation happens ON SAVE with per-field errors from the @soc/core
 * validateOptions contract: non-numeric number input REJECTS with a named
 * error instead of the legacy silent `Number(val) || 0` coercion. A dirty
 * indicator marks unsaved edits; Reset to defaults stages the defaults and
 * still requires Save (staged, never auto-persisted).
 *
 * No direct IO in this module: the only side effects go through the two
 * callbacks the hosting shell provides.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { applyOptionsPatch, parseAppOptions } from "@soc/core";
import type { OptionFormField, OptionFormValue } from "@soc/core";
import { OPTION_FORMS } from "@soc/core";
import { InfoTip } from "../../components/info-tip";
import {
  defaultOptionsState,
  isOptionsStateDirty,
  patchFromState,
  stateFromOptions,
  validateOptionsState,
} from "./options-state";
import type { OptionsFormState } from "./options-state";

export interface OptionsScreenProps {
  /**
   * Read the raw persisted options blob (null when nothing is stored yet).
   * The screen parses it tolerantly and keeps the raw string so saves can
   * merge into it rather than replace it.
   */
  loadOptions: () => Promise<string | null>;
  /** Persist the serialized merged blob. The shell owns storage semantics. */
  saveOptions: (serialized: string) => Promise<void>;
}

type LoadPhase = "loading" | "error" | "ready";

/**
 * The generic descriptor-driven field renderer: label + InfoTip carrying the
 * descriptor's operational description, a control by field kind, and the
 * field's validation error (if any) inline underneath.
 */
export interface OptionFieldRowProps {
  field: OptionFormField;
  value: OptionFormValue;
  /** The validation message for this field, or undefined when clean. */
  error: string | undefined;
  onChange: (value: OptionFormValue) => void;
}

export function OptionFieldRow({
  field,
  value,
  error,
  onChange,
}: OptionFieldRowProps) {
  const labelWithTip = (
    <span className="field-label">
      {field.label}
      <InfoTip text={field.description} />
    </span>
  );
  if (field.kind === "boolean") {
    return (
      <label className="field">
        {labelWithTip}
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        {error !== undefined && (
          <span className="config-editor-error">{error}</span>
        )}
      </label>
    );
  }
  if (field.kind === "choice") {
    return (
      <label className="field">
        {labelWithTip}
        <select
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        >
          {(field.choices ?? []).map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
        {error !== undefined && (
          <span className="config-editor-error">{error}</span>
        )}
      </label>
    );
  }
  // kind 'number' and 'text' both edit as text; validation on save decides
  // whether the number parses (the explicit-rejection contract).
  return (
    <label className="field">
      {labelWithTip}
      <input
        type="text"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      {error !== undefined && (
        <span className="config-editor-error">{error}</span>
      )}
    </label>
  );
}

export function OptionsScreen({ loadOptions, saveOptions }: OptionsScreenProps) {
  const [phase, setPhase] = useState<LoadPhase>("loading");
  const [loadError, setLoadError] = useState("");
  const [state, setState] = useState<OptionsFormState>(defaultOptionsState);
  const [savedState, setSavedState] = useState<OptionsFormState>(
    defaultOptionsState,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  // The raw stored blob the next save merges into (applyOptionsPatch keeps
  // its unmanaged keys). Updated after every successful save.
  const storedRawRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    setPhase("loading");
    setLoadError("");
    try {
      const raw = await loadOptions();
      storedRawRef.current = raw;
      const loaded = stateFromOptions(parseAppOptions(raw));
      setState(loaded);
      setSavedState(loaded);
      setErrors({});
      setFeedback("");
      setPhase("ready");
    } catch (err) {
      setLoadError(String(err));
      setPhase("error");
    }
  }, [loadOptions]);

  useEffect(() => {
    void load();
  }, [load]);

  const setFieldValue = (
    formId: "operation" | "cribl",
    key: string,
    value: OptionFormValue,
  ) => {
    setState((current) => ({
      ...current,
      [formId]: { ...current[formId], [key]: value },
    }));
    setFeedback("");
  };

  const save = async () => {
    const validation = validateOptionsState(state);
    setErrors(validation);
    setFeedback("");
    if (Object.keys(validation).length > 0) {
      return;
    }
    setSaving(true);
    try {
      const merged = applyOptionsPatch(storedRawRef.current, patchFromState(state));
      const serialized = JSON.stringify(merged, null, 2);
      await saveOptions(serialized);
      storedRawRef.current = serialized;
      setSavedState(state);
      setFeedback("Options saved.");
    } catch (err) {
      setFeedback(`Save failed: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const resetToDefaults = () => {
    setState(defaultOptionsState());
    setErrors({});
    setFeedback("");
  };

  if (phase === "loading") {
    return (
      <section className="panel">
        <h2 className="panel-title">Options</h2>
        <p className="panel-desc">Loading saved options...</p>
      </section>
    );
  }
  if (phase === "error") {
    return (
      <section className="panel">
        <h2 className="panel-title">Options</h2>
        <p className="panel-desc">Could not load saved options: {loadError}</p>
        <div className="panel-controls">
          <button className="run-button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      </section>
    );
  }

  const dirty = isOptionsStateDirty(state, savedState);

  return (
    <section className="panel">
      <h2 className="panel-title">
        Options
        {dirty && (
          <span className="config-editor-modified"> Modified - not saved</span>
        )}
      </h2>
      <p className="panel-desc">
        Deployment and naming defaults used by onboarding and deployment jobs.
        Changes apply after Save; Reset to defaults stages the defaults and
        also requires Save.
      </p>
      {OPTION_FORMS.map((form) => (
        <div className="settings-section" key={form.id}>
          <div className="settings-section-title">{form.name}</div>
          <p className="panel-desc">{form.description}</p>
          <div className="form-grid">
            {form.fields.map((field) => (
              <OptionFieldRow
                key={field.key}
                field={field}
                value={state[form.id][field.key]}
                error={errors[`${form.id}.${field.key}`]}
                onChange={(value) => setFieldValue(form.id, field.key, value)}
              />
            ))}
          </div>
        </div>
      ))}
      {Object.keys(errors).length > 0 && (
        <p className="config-editor-error">
          Not saved - fix the highlighted fields above. Nothing is coerced
          silently: a number field must hold a whole number.
        </p>
      )}
      {feedback !== "" && (
        <p
          className={
            feedback.startsWith("Save failed")
              ? "config-editor-error"
              : "config-editor-saved"
          }
        >
          {feedback}
        </p>
      )}
      <div className="panel-controls">
        <button
          className="next-action-button"
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          Save
        </button>
        <button className="run-button" disabled={saving} onClick={resetToDefaults}>
          Reset to defaults
        </button>
      </div>
    </section>
  );
}
