/**
 * The required vendor-identity block for one Gap Analysis card (extracted
 * from mapping-review-section in the 2026-07-12 maintainability pass; the
 * behavior and copy are unchanged and pinned via the core resolvers).
 *
 * Shows how each identity field the destination table REQUIRES
 * (DeviceVendor/DeviceProduct, or the ASim Event pair) is satisfied -
 * sample-provided, enrichment constant, or MISSING with a forced-input row -
 * and offers the curated candidate values as one-click choices. Rendered
 * OUTSIDE the collapsed field-mapping details so a missing requirement is
 * visible without expanding anything.
 */

import { useState } from "react";
import { identityValueOptions } from "@soc/core";
import type { IdentityFieldStatus, VendorIdentity } from "@soc/core";
import { InfoTip } from "../../components/info-tip";

export function IdentityBlock({
  tableName,
  statuses,
  identity,
  onAdd,
}: {
  tableName: string;
  statuses: readonly IdentityFieldStatus[];
  identity: VendorIdentity | null;
  onAdd: (field: string, value: string) => boolean;
}) {
  const missing = statuses.filter((s) => s.status === "missing");
  return (
    <div
      className={`identity-block${missing.length > 0 ? " identity-block-missing" : ""}`}
    >
      <span className="field-label">
        Vendor identity for {tableName}
        <InfoTip text="Sentinel analytics rules and workbooks filter this table on these fields, but raw vendor logs often do not carry them. When the sample provides one (CEF headers do), nothing is added. Otherwise the Cribl pipeline must add it as a constant - detected vendors are pre-filled from the selected solution (editable below); anything still missing must be entered before the pack can be built. Where a vendor emits several known products (e.g. Zscaler NSSWeblog vs NSSFWlog), the candidates are offered but never auto-picked - the wrong constant silently breaks the content filters." />
      </span>
      {statuses.map((s) =>
        s.status === "missing" ? (
          <RequiredIdentityInput
            key={s.field}
            field={s.field}
            options={identityValueOptions(s.field, identity)}
            onAdd={onAdd}
          />
        ) : (
          <div className="identity-row" key={s.field}>
            <code className="code-chip">{s.field}</code>
            <span className="enrich-row-eq">=</span>
            <span className="enrich-row-value">
              {s.value ?? "(from sample)"}
            </span>
            <span className="field-hint">
              {s.status === "sample"
                ? "provided by the sample data"
                : "enrichment constant (editable in the enrichment fields)"}
            </span>
          </div>
        ),
      )}
      {missing.length > 0 && (
        <span className="field-hint identity-missing-hint">
          Required before the pack can be built: the sample does not carry{" "}
          {missing.map((s) => s.field).join(" or ")} and no enrichment sets
          {missing.length === 1 ? " it" : " them"}. Enter the constant the
          pipeline should add.
        </span>
      )}
    </div>
  );
}

/**
 * One forced-input row for a missing required identity field. When the
 * curated identity KNOWS the candidate values (Zscaler's NSSWeblog vs
 * NSSFWlog), they render as one-click choices - offered, never auto-picked.
 */
function RequiredIdentityInput({
  field,
  options,
  onAdd,
}: {
  field: string;
  options: readonly string[];
  onAdd: (field: string, value: string) => boolean;
}) {
  const [value, setValue] = useState("");
  const placeholder =
    options.length > 0
      ? `e.g. ${options[0]}`
      : field.endsWith("Vendor")
        ? "e.g. Palo Alto Networks"
        : "e.g. PAN-OS";
  return (
    <div className="identity-required">
      <div className="enrich-add identity-required-row">
        <code className="code-chip">{field}</code>
        <span className="gap-badge gap-badge-required">Required</span>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          className="run-button"
          onClick={() => {
            if (onAdd(field, value)) {
              setValue("");
            }
          }}
          disabled={value.trim() === ""}
        >
          Add
        </button>
      </div>
      {options.length > 0 && (
        <div className="identity-suggestions">
          <span className="field-hint">
            Known {field} values for this vendor - pick the one matching your
            feed:
          </span>
          {options.map((option) => (
            <button
              key={option}
              type="button"
              className="identity-suggestion-chip"
              onClick={() => onAdd(field, option)}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
