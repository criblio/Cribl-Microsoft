/**
 * WindowSummaryStrip (MIG-33) - the top of the Data Volume Inventory results:
 * billable over the last 30 complete days against the allowance over the same
 * days, the benefit Microsoft actually applied beside it, the net, and the
 * licence counts the allowance rests on. Follows whichever allowance result is
 * shown - this workspace, or the tenant comparison.
 *
 * Presentational only: core's window-totals.ts does the arithmetic and
 * allowance-state.ts the words. Unknowns read "not known" with the reason and
 * lower bounds "at least" (docs/inventory-standard.md).
 */

import type { DataAllowances } from "@soc/core";
import { InfoTip } from "../../components/info-tip";
import { ALLOWANCE_TIPS, windowStripText } from "./allowance-state";

export function WindowSummaryStrip({ allowances }: { allowances: DataAllowances }) {
  const text = windowStripText(allowances);
  return (
    <div className="allowance-window-strip" aria-label="Billable and allowance over the window">
      <p className="panel-desc">{text.heading}</p>
      <div className="match-stat-grid">
        <div className="match-stat match-stat-info">
          <span className="match-stat-value">{text.billable}</span>
          <span className="match-stat-label">
            billable <InfoTip text={ALLOWANCE_TIPS.windowBillable} />
          </span>
        </div>
        <div className="match-stat match-stat-info">
          <span className="match-stat-value">{text.allowance}</span>
          <span className="match-stat-label">
            allowance <InfoTip text={ALLOWANCE_TIPS.windowAllowance} />
          </span>
        </div>
        <div className="match-stat match-stat-info">
          <span className="match-stat-value">{text.applied}</span>
          <span className="match-stat-label">
            benefit Microsoft applied <InfoTip text={ALLOWANCE_TIPS.windowApplied} />
          </span>
        </div>
        <div className="match-stat match-stat-info">
          <span className="match-stat-value">{text.net}</span>
          <span className="match-stat-label">
            net, billable against allowance <InfoTip text={ALLOWANCE_TIPS.windowNet} />
          </span>
        </div>
      </div>
      {text.licences.length > 0 && (
        <p className="field-hint">
          Licences: {text.licences.join("; ")} <InfoTip text={ALLOWANCE_TIPS.licenceCount} />
        </p>
      )}
      {text.daysNote !== null && <p className="field-hint">{text.daysNote}</p>}
    </div>
  );
}
