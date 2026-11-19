/**
 * ActivityLogRemovePanel - Remove the subscription Activity Log diagnostic
 * setting this app created (AZR-105), shown inside "Remove or pause what this
 * app created" beside the Entra ID one (AZR-121).
 *
 * WHY HERE AND NOT IN THE ACTIVITY LOG SECTION. That section renders only
 * while the Activity Log is chosen in Automate mode; once it is switched to
 * How-to (or unchosen in How-to mode) the section is gone, and a Remove inside
 * it went with it although the record and the setting remained. This panel is
 * shown from the app's RECORD for the configured subscription, whatever the
 * choice or mode: unchoosing the Activity Log never removes anything, and
 * never hides the way to remove what the app wrote.
 *
 * Remove is TWO CLICKS: the first arms a confirm quoting the setting, the
 * subscription and the rule it is checked against; the second runs core
 * removeActivityLogExport, which re-reads the setting by name and deletes it
 * only when it is provably the app's (name, this subscription's record, the
 * recorded rule), then confirms the 404. There is no Pause: a diagnostic
 * setting has no switch of its own.
 */

import { useEffect, useState } from "react";
import { ACTIVITY_LOG_SETTING_NAME, removeActivityLogExport } from "@soc/core";
import type { ActivityLogRemoveOutcome, ActivityLogSettingRecord } from "@soc/core";
import { usePorts } from "../../ports-context";
import { useReportBusy } from "./operation-busy";
import { PickerLine } from "./eventhub-prerequisite-section";
import { activityLogRemoveConfirmText, activityLogRemoveDisabledReason, activityLogRemoveMessage } from "./activity-log-state";

export interface ActivityLogRemovePanelProps {
  /** This app's record of writing the setting on the configured subscription, or null. */
  readonly record: ActivityLogSettingRecord | null;
  /** Called with every outcome, so the screen can forget a removed setting's record and re-read. */
  readonly onRemoved: (outcome: ActivityLogRemoveOutcome) => void;
  /**
   * The Activity Log section's Deploy is running. Remove is off meanwhile, as
   * it was when both lived in that section: a Remove under an in-flight PUT
   * either deletes the setting the deploy is reading back, or answers
   * already-gone after the deploy recorded it and forgets the record.
   */
  readonly deploying: boolean;
  /** Told when a Remove starts and finishes, so the screen keeps Deploy off meanwhile. */
  readonly onRunningChange: (running: boolean) => void;
}

export function ActivityLogRemovePanel({ record, onRemoved, deploying, onRunningChange }: ActivityLogRemovePanelProps) {
  const { ports, config } = usePorts();
  const subscriptionId = config.subscriptionId;
  const [armedFor, setArmedFor] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  useReportBusy("an Activity Log diagnostic setting removal", removing);
  const [outcome, setOutcome] = useState<ActivityLogRemoveOutcome | null>(null);

  const reason = activityLogRemoveDisabledReason({ running: removing || deploying, subscriptionId, record });
  // `deploying` is in the key so a Deploy drops an armed Remove outright:
  // otherwise the arm, only masked while the Deploy ran, came back after it.
  const key = JSON.stringify([subscriptionId, record?.ruleId ?? null, deploying]);
  const armed = reason === null && armedFor === key;
  // Drop a stale arm outright: otherwise reverting the change would re-arm it.
  useEffect(() => {
    setArmedFor((current) => (current !== null && current !== key ? null : current));
  }, [key]);

  // Nothing recorded and nothing just done: no row at all, like a Cribl source without a record.
  if (record === null && outcome === null) return null;

  async function confirmRemove(): Promise<void> {
    if (reason !== null) return;
    setArmedFor(null);
    setRemoving(true);
    onRunningChange(true);
    setOutcome(null);
    ports.logger?.info("azure-onboarding: activity log remove confirmed", {});
    const result = await removeActivityLogExport(ports.azure, { subscriptionId, record }, ports.logger);
    setOutcome(result);
    setRemoving(false);
    onRunningChange(false);
    onRemoved(result);
  }

  return (
    <div className="azure-onboarding-subblock" aria-label="Activity Log diagnostic setting">
      <span className="field-label">{`Activity Log diagnostic setting ${ACTIVITY_LOG_SETTING_NAME} (Azure)`}</span>
      <div className="panel-controls">
        <button type="button" className="run-button" disabled={reason !== null || armed} onClick={() => setArmedFor(key)}>
          {removing ? "Removing..." : "Remove Activity Log setting"}
        </button>
        {reason !== null && record !== null && <span className="field-hint">{reason}</span>}
      </div>
      {armed && record !== null && (
        <div className="azure-onboarding-confirm" role="group" aria-label="Confirm Activity Log removal">
          <p className="panel-desc">{activityLogRemoveConfirmText(subscriptionId, record)}</p>
          <div className="panel-controls">
            <button type="button" className="next-action-button" onClick={() => void confirmRemove()}>
              Confirm remove
            </button>
            <button type="button" className="run-button" onClick={() => setArmedFor(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {outcome !== null && <PickerLine message={activityLogRemoveMessage(outcome)} />}
    </div>
  );
}
