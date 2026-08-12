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
      {statuses.map((s) => (
        <IdentityFieldRow
          key={s.field}
          status={s}
          options={identityValueOptions(s.field, identity)}
          onAdd={onAdd}
        />
      ))}
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
 * One identity field row - ALWAYS EDITABLE, whatever its status (user request
 * 2026-08-12: "allow the user to change a value/selection after it's made").
 *
 * It used to be two different rows: a forced input while the field was missing,
 * and read-only text once it was satisfied. So the moment you picked NSSWeblog
 * you could no longer pick NSSFWlog - the enrichment row said "editable in the
 * enrichment fields", sending you to another section to undo a one-click choice
 * you had just made in this one. And a SAMPLE-provided value could not be
 * corrected at all, which is how a wrong DeviceProduct in the data became
 * unfixable in the app.
 *
 * Now every state offers the same input and the same one-click candidates; only
 * the framing changes - Required while missing, the current value otherwise.
 * Candidates are still offered and never auto-picked: the wrong constant
 * silently breaks Sentinel's content filters, so it stays a human choice.
 */
function IdentityFieldRow({
  status,
  options,
  onAdd,
}: {
  status: IdentityFieldStatus;
  options: readonly string[];
  onAdd: (field: string, value: string) => boolean;
}) {
  const { field } = status;
  const missing = status.status === "missing";
  const [value, setValue] = useState("");
  const placeholder = missing
    ? options.length > 0
      ? `e.g. ${options[0]}`
      : field.endsWith("Vendor")
        ? "e.g. Palo Alto Networks"
        : "e.g. PAN-OS"
    : `${status.value ?? "(from sample)"} - type to replace`;
  return (
    <div className={missing ? "identity-required" : "identity-row-editable"}>
      <div className="enrich-add identity-required-row">
        <code className="code-chip">{field}</code>
        {missing ? (
          <span className="gap-badge gap-badge-required">Required</span>
        ) : (
          <>
            <span className="enrich-row-eq">=</span>
            <span className="enrich-row-value">
              {status.value ?? "(from sample)"}
            </span>
          </>
        )}
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
          {missing ? "Add" : "Replace"}
        </button>
      </div>
      {!missing && (
        <span className="field-hint">
          {status.status === "sample"
            ? "provided by the sample data - replacing it adds a constant that " +
              "overwrites the per-event value for every event"
            : "enrichment constant - replace it here or in the enrichment fields"}
        </span>
      )}
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
