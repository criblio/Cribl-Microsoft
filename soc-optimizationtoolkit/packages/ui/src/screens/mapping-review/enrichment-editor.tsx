/**
 * The enrichment add/list editor (extracted from mapping-review-section in
 * the 2026-07-12 maintainability pass; behavior and copy unchanged).
 *
 * Used globally and per table: field name + constant value inputs, an Add
 * button (validated - Eval-safe names, quotes stripped from values by the
 * caller), and the current entries with Remove. `inherited` renders the
 * global entries a table already receives, read-only.
 */

import { useEffect, useRef, useState } from "react";
import { isValidEnrichmentFieldName } from "../pipeline-preview/pipeline-preview-state";
import type { EnrichmentField } from "../pipeline-preview/pipeline-preview-state";

export function EnrichmentEditor({
  entries,
  inherited,
  onAdd,
  onRemove,
  seed,
}: {
  entries: readonly EnrichmentField[];
  inherited?: readonly EnrichmentField[];
  onAdd: (field: string, value: string) => boolean;
  onRemove: (field: string) => void;
  /**
   * Start a new entry for this field (DBT-202's "Add a constant" from an
   * unmapped column): fills the field name and moves focus to the value. The
   * nonce makes a second request for the same field act again.
   */
  seed?: { field: string; nonce: number };
}) {
  const [field, setField] = useState("");
  const [value, setValue] = useState("");
  const [issue, setIssue] = useState("");
  const valueRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (seed === undefined) return;
    setField(seed.field);
    setIssue("");
    valueRef.current?.focus();
  }, [seed]);

  const submit = () => {
    if (!isValidEnrichmentFieldName(field.trim())) {
      setIssue(
        "Field names must start with a letter/underscore and use only letters, digits, and underscores.",
      );
      return;
    }
    if (value.trim() === "") {
      setIssue("Enter the constant value the pipeline should add.");
      return;
    }
    if (onAdd(field, value)) {
      setField("");
      setValue("");
      setIssue("");
    }
  };

  return (
    <div className="enrich-editor">
      {inherited !== undefined && inherited.length > 0 && (
        <div className="enrich-rows">
          {inherited.map((e) => (
            <div className="enrich-row enrich-row-inherited" key={`g:${e.field}`}>
              <code className="code-chip">{e.field}</code>
              <span className="enrich-row-eq">=</span>
              <span className="enrich-row-value">{e.value}</span>
              <span className="field-hint">(global)</span>
            </div>
          ))}
        </div>
      )}
      {entries.length > 0 && (
        <div className="enrich-rows">
          {entries.map((e) => (
            <div className="enrich-row" key={e.field}>
              <code className="code-chip">{e.field}</code>
              <span className="enrich-row-eq">=</span>
              <span className="enrich-row-value">{e.value}</span>
              <button
                className="gap-reset-button"
                onClick={() => onRemove(e.field)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="enrich-add">
        <input
          type="text"
          value={field}
          onChange={(e) => {
            setField(e.target.value);
            setIssue("");
          }}
          placeholder="Field name (e.g. DeviceVendor)"
          autoComplete="off"
          spellCheck={false}
        />
        <input
          ref={valueRef}
          type="text"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setIssue("");
          }}
          placeholder="Constant value (e.g. Palo Alto Networks)"
          autoComplete="off"
          spellCheck={false}
        />
        <button className="run-button" onClick={submit}>
          Add field
        </button>
      </div>
      {issue !== "" && <span className="field-hint enrich-issue">{issue}</span>}
    </div>
  );
}
