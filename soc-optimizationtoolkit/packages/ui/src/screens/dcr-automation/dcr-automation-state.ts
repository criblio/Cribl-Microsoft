/**
 * Pure tab-state helpers for the DCR Automation screen - the single surface
 * that hosts BOTH the single-table onboard and the batch onboard flows behind a
 * Single/Batch toggle (consolidating the two former nav items into one, matching
 * the legacy app's single "DCR Automation" sidebar page).
 *
 * The Single tab requires a live Cribl connection (it creates a Cribl
 * destination); Batch works template-only without Cribl. So when Cribl is
 * absent the Single tab is disabled and Batch is the only usable mode.
 *
 * Pure: no IO, no React, no Date.
 */

export type DcrTab = "single" | "batch";

/**
 * The tab to show on first render: Batch when the Single tab is disabled
 * (no Cribl), otherwise Single (the default, matching the old single-onboard
 * landing).
 */
export function initialDcrTab(singleDisabled: boolean): DcrTab {
  return singleDisabled ? "batch" : "single";
}

/**
 * The tab actually rendered given the user's selection and whether Single is
 * disabled. A disabled Single selection always resolves to Batch, so a mode
 * change that disables Single can never leave an unusable Single view showing.
 */
export function resolveActiveDcrTab(selected: DcrTab, singleDisabled: boolean): DcrTab {
  return selected === "single" && singleDisabled ? "batch" : selected;
}
