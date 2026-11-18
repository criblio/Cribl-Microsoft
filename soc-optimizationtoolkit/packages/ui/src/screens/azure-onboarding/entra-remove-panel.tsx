/**
 * EntraRemovePanel - Remove the Entra ID tenant diagnostic setting this app
 * created (AZR-99), shown inside "Remove or pause what this app created".
 *
 * Shown only when the app holds a RECORD of writing the setting in this
 * tenant (chosen or not: unchoosing Entra ID never removes anything). Remove
 * is TWO CLICKS: the first arms a confirm quoting the setting, the tenant and
 * the rule it is checked against; the second runs core removeEntraSetting,
 * which re-reads the setting by name and deletes it only when it is provably
 * the app's (name, this tenant's record, the recorded rule), then confirms the
 * 404. There is no Pause: a diagnostic setting has no switch of its own.
 */

import { useEffect, useState } from "react";
import { ENTRA_SETTING_NAME, removeEntraSetting } from "@soc/core";
import type { EntraRemoveOutcome, EntraSettingRecord } from "@soc/core";
import { usePorts } from "../../ports-context";
import { PickerLine } from "./eventhub-prerequisite-section";
import { entraRemoveConfirmText, entraRemoveDisabledReason, entraRemoveMessage } from "./entra-setting-state";

export interface EntraRemovePanelProps {
  /** This app's record of writing the setting in this tenant, or null. */
  readonly record: EntraSettingRecord | null;
  /** Called with every outcome, so the screen can forget a removed setting's record. */
  readonly onRemoved: (outcome: EntraRemoveOutcome) => void;
}

export function EntraRemovePanel({ record, onRemoved }: EntraRemovePanelProps) {
  const { ports, config } = usePorts();
  const tenantId = config.tenantId;
  const [armedFor, setArmedFor] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [outcome, setOutcome] = useState<EntraRemoveOutcome | null>(null);

  const reason = entraRemoveDisabledReason({ running: removing, tenantId, record });
  const key = JSON.stringify([tenantId, record?.ruleId ?? null]);
  const armed = reason === null && armedFor === key;
  useEffect(() => {
    setArmedFor((current) => (current !== null && current !== key ? null : current));
  }, [key]);

  // Nothing recorded and nothing just done: no row at all, like a Cribl source without a record.
  if (record === null && outcome === null) return null;

  async function confirmRemove(): Promise<void> {
    if (reason !== null) return;
    setArmedFor(null);
    setRemoving(true);
    setOutcome(null);
    ports.logger?.info("azure-onboarding: entra setting remove confirmed", {});
    const result = await removeEntraSetting(ports.azure, { tenantId, record }, ports.logger);
    setOutcome(result);
    setRemoving(false);
    onRemoved(result);
  }

  return (
    <div className="azure-onboarding-subblock" aria-label="Entra ID diagnostic setting">
      <span className="field-label">{`Entra ID diagnostic setting ${ENTRA_SETTING_NAME} (Azure)`}</span>
      <div className="panel-controls">
        <button type="button" className="run-button" disabled={reason !== null || armed} onClick={() => setArmedFor(key)}>
          {removing ? "Removing..." : "Remove Entra ID setting"}
        </button>
        {reason !== null && record !== null && <span className="field-hint">{reason}</span>}
      </div>
      {armed && record !== null && (
        <div className="azure-onboarding-confirm" role="group" aria-label="Confirm Entra ID setting removal">
          <p className="panel-desc">{entraRemoveConfirmText(tenantId, record)}</p>
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
      {outcome !== null && <PickerLine message={entraRemoveMessage(outcome)} />}
    </div>
  );
}
