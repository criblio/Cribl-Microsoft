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
  singleDisabledReason,
}: DcrAutomationScreenProps) {
  const singleDisabled = singleDisabledReason !== undefined;
  const [selected, setSelected] = useState<DcrTab>(initialDcrTab(singleDisabled));
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
      </div>
      {singleDisabled && (
        <p className="field-hint dcr-mode-note">{singleDisabledReason}</p>
      )}
      {active === "single" ? single : active === "inventory" ? inventory : batch}
    </>
  );
}
