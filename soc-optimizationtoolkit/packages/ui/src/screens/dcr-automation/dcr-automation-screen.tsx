import { useState, type ReactNode } from "react";
import {
  initialDcrTab,
  resolveActiveDcrTab,
  type DcrTab,
} from "./dcr-automation-state";

export interface DcrAutomationScreenProps {
  /** The single-table onboard view (created by the shell). */
  single: ReactNode;
  /** The batch onboard view (created by the shell). */
  batch: ReactNode;
  /**
   * The existing-DCR inventory view (2026-07-13). Azure-only, so it is
   * never gated on Cribl. Absent = the tab is not rendered.
   */
  inventory?: ReactNode;
  /**
   * The workspace tables view (TBL-3). Azure-only for the same reason as
   * inventory - listing tables and authoring a schema need no Cribl. Absent =
   * the tab is not rendered.
   */
  tables?: ReactNode;
  /**
   * OPTIONALLY CONTROLLED tab selection (TBL-3). Absent, the screen owns its
   * own selection exactly as before - the uncontrolled path is unchanged and
   * is still what every existing caller gets. Supplied, the host owns it,
   * which is what lets the Tables tab send an operator to Single with a table
   * already filled in.
   */
  activeTab?: DcrTab;
  onTabChange?: (tab: DcrTab) => void;
  /**
   * When set, the Single tab is disabled and this reason is shown - Single
   * onboards one table live to Cribl, so it needs a Cribl connection; Batch
   * still works template-only. When undefined, Single is enabled.
   */
  singleDisabledReason?: string;
}

/**
 * DCR Automation: one surface hosting both the single-table and batch onboard
 * flows behind a Single/Batch toggle. Consolidates the two former nav items
 * ("Onboard" + batch) into one, matching the legacy app's single "DCR
 * Automation" page. The two views are the existing screens, reused unchanged -
 * this only adds the mode toggle above them.
 */
export function DcrAutomationScreen({
  single,
  batch,
  inventory,
  tables,
  activeTab,
  onTabChange,
  singleDisabledReason,
}: DcrAutomationScreenProps) {
  const singleDisabled = singleDisabledReason !== undefined;
  // Inventory first (user direction 2026-07-13): the operational view is
  // the landing tab whenever the shell provides it.
  const [ownSelected, setOwnSelected] = useState<DcrTab>(
    inventory !== undefined ? "inventory" : initialDcrTab(singleDisabled),
  );
  // Controlled when the host supplies activeTab, else the screen's own state.
  // The internal state is still UPDATED in the controlled case so that a host
  // which later stops controlling does not snap back to a stale tab.
  const selected = activeTab ?? ownSelected;
  const setSelected = (tab: DcrTab): void => {
    setOwnSelected(tab);
    onTabChange?.(tab);
  };
  const active = resolveActiveDcrTab(selected, singleDisabled);

  return (
    <>
      <div className="dcr-mode-toggle" role="tablist" aria-label="DCR Automation mode">
        <button
          type="button"
          role="tab"
          aria-selected={active === "single"}
          className={`dcr-mode-tab${active === "single" ? " dcr-mode-tab-active" : ""}`}
          disabled={singleDisabled}
          title={singleDisabledReason}
          onClick={() => setSelected("single")}
        >
          Single table
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={active === "batch"}
          className={`dcr-mode-tab${active === "batch" ? " dcr-mode-tab-active" : ""}`}
          onClick={() => setSelected("batch")}
        >
          Batch
        </button>
        {inventory !== undefined && (
          <button
            type="button"
            role="tab"
            aria-selected={active === "inventory"}
            className={`dcr-mode-tab${active === "inventory" ? " dcr-mode-tab-active" : ""}`}
            onClick={() => setSelected("inventory")}
          >
            Inventory
          </button>
        )}
        {tables !== undefined && (
          <button
            type="button"
            role="tab"
            aria-selected={active === "tables"}
            className={`dcr-mode-tab${active === "tables" ? " dcr-mode-tab-active" : ""}`}
            onClick={() => setSelected("tables")}
          >
            Tables
          </button>
        )}
      </div>
      {singleDisabled && (
        <p className="field-hint dcr-mode-note">{singleDisabledReason}</p>
      )}
      {active === "single"
        ? single
        : active === "inventory"
          ? inventory
          : active === "tables"
            ? tables
            : batch}
    </>
  );
}
