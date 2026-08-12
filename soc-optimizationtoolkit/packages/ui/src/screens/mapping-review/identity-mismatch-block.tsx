/**
 * IdentityMismatchBlock - "your vendor string does not match what this
 * solution's rules look for".
 *
 * THE FAILURE THIS EXISTS FOR IS INVISIBLE. Sentinel analytic rules filter
 * CommonSecurityLog by literal string - `DeviceVendor == "Palo Alto Networks"`,
 * `DeviceProduct =~ "NSSWeblog"`. A sample whose vendor string differs deploys
 * cleanly, ingests cleanly, and NEVER FIRES A RULE. Nothing errors anywhere,
 * because nothing is broken: the data is in the table, and every detection
 * quietly matches zero rows. The only symptom is an absence, months later.
 *
 * So this block is the opposite of a warning about something that went wrong -
 * it is the one chance to notice before deploying. It renders ONLY when the
 * solution's own rules disagree with the sample, and it names both sides.
 *
 * It is separate from IdentityBlock on purpose. That one answers "is this field
 * SET at all", gating the pack build on a missing constant. This one answers "is
 * the value the RIGHT one", which is not a gate: the operator may know something
 * the corpus does not, and a solution whose rules never mention the field has no
 * opinion to disagree with. Never blocks; only informs and offers.
 *
 * CASE IS ITS OWN OUTCOME. The rule corpus mixes `==` and `=~` against these
 * fields, so wrong casing breaks exactly the rules that use `==` and is fine for
 * the rest. Reporting it as a wrong vendor would send operators chasing a
 * difference half the corpus ignores; reporting nothing would hide a real
 * partial failure. It gets its own wording.
 */

import { actionableCefIdentity } from "@soc/core";
import type { CefIdentityFinding, CefIdentityOverride } from "@soc/core";
import { InfoTip } from "../../components/info-tip";

/** The operator-facing line for one finding. */
function explain(f: CefIdentityFinding): string {
  const expected = f.expected.join('", "');
  switch (f.status) {
    case "case-mismatch":
      return (
        `The sample sends "${f.sampleValue}" and this solution's rules compare ` +
        `against "${expected}". Rules using =~ still match; rules using == do ` +
        "not, so some detections fire and some never will."
      );
    case "mismatch":
      return (
        `The sample sends "${f.sampleValue}" and this solution's rules compare ` +
        `against "${expected}". No rule filtering on this field will ever match ` +
        "this data."
      );
    case "absent":
      return (
        "The sample carries no value for this field, and this solution's rules " +
        `compare against "${expected}". Rules filtering on it will not match.`
      );
    default:
      return "";
  }
}

export function IdentityMismatchBlock({
  findings,
  override,
  onOverrideChange,
}: {
  /** Findings for this log type, from cefIdentityFindings. */
  findings: readonly CefIdentityFinding[];
  /** The override in force for this log type ({} when none). */
  override: CefIdentityOverride;
  onOverrideChange: (next: CefIdentityOverride) => void;
}) {
  const actionable = actionableCefIdentity(findings);
  if (actionable.length === 0) {
    // Silent when the rules agree, say nothing about the field, or the operator
    // has already corrected it - an advisory that never goes away is noise, and
    // noise is what gets the real one ignored.
    return null;
  }
  return (
    <div className="identity-mismatch-block">
      <span className="field-label">
        Vendor identity does not match this solution&apos;s rules
        <InfoTip text="Sentinel analytic rules filter this table on DeviceVendor/DeviceProduct by literal string. A sample whose value differs deploys cleanly, ingests cleanly, and never fires a rule - nothing errors, so the only symptom is detections that never match. The expected values are read from the selected solution's own rule queries, never typed in. Applying one adds a pipeline step that sets the field right after CEF extraction, so the reduction rules and the destination all see the corrected value. Advisory: it never blocks a build, because you may know something the rule corpus does not." />
      </span>
      {actionable.map((f) => {
        const applied = (override[f.field] ?? "").trim();
        const suggestion = f.suggested ?? "";
        return (
          <div className="identity-mismatch-row" key={f.field}>
            <code className="code-chip">{f.field}</code>
            <span className="field-hint">{explain(f)}</span>
            {applied === "" ? (
              <button
                type="button"
                className="run-button"
                onClick={() =>
                  onOverrideChange({ ...override, [f.field]: suggestion })
                }
              >
                Send &quot;{suggestion}&quot; instead
              </button>
            ) : (
              <div className="identity-mismatch-applied">
                <span className="enrich-row-value">
                  Pipeline will send &quot;{applied}&quot;
                </span>
                <button
                  type="button"
                  className="run-button"
                  onClick={() => {
                    // Blank means "leave it" everywhere in this feature, so the
                    // field is deleted rather than set to "" - which would read
                    // as an instruction to clear the vendor and make CEF
                    // reconstruction fail.
                    const next = { ...override };
                    delete next[f.field];
                    onOverrideChange(next);
                  }}
                >
                  Undo
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
