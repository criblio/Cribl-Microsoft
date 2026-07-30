/**
 * LabsScreen - roadmap Phase 5: provision disposable Azure lab environments
 * from the app. A THIN composer over the per-feature panels:
 *
 *   - subscription selection (owned here - every panel targets it)
 *   - {@link LabInventoryPanel}: running labs, extend TTL, destroy
 *   - {@link LabProvisionerPanels}: profile / target+TTL / plan review +
 *     permission check / deploy (all ten legacy phases via provisionLab)
 *   - {@link FlowLogPackPanel}: assemble + install the AzureFlowLogs pack
 *
 * The FORM and the derived plan are owned here too: the provisioner edits
 * them and the pack panel needs the planned (or deployed) storage-account
 * name - one source, no cross-panel duplication. All lab knowledge is
 * @soc/core (domain/labs + the provisionLab usecase); decisions live in the
 * pure labs-state module; components only render and drive IO through the
 * ports (ZERO direct fetch here).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listSubscriptions,
  type AzureSubscription,
  type ProvisionLabResult,
} from "@soc/core";
import { usePorts } from "../../ports-context";
import {
  defaultLabFormState,
  labPlanFromForm,
  packStorageAccountName,
  type LabFormState,
} from "./labs-state";
import { LabInventoryPanel } from "./lab-inventory-panel";
import { LabProvisionerPanels } from "./lab-provisioner-panels";
import { FlowLogPackPanel } from "./flowlog-pack-panel";

export function LabsScreen() {
  const { ports, config } = usePorts();

  const [form, setForm] = useState<LabFormState>(defaultLabFormState);
  // Subscription selection: defaults to the active connection's target and
  // feeds the plan, the permission check, the deploy, and the inventory.
  const [subscriptionId, setSubscriptionId] = useState(config.subscriptionId);
  const [subscriptions, setSubscriptions] = useState<AzureSubscription[] | null>(null);
  const [subError, setSubError] = useState("");
  // The last deploy outcome; the pack panel reads its storage account.
  const [deployResult, setDeployResult] = useState<ProvisionLabResult | null>(null);

  const onFormChange = useCallback(
    <K extends keyof LabFormState>(key: K, value: LabFormState[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const plan = useMemo(
    () => labPlanFromForm(form, subscriptionId),
    [form, subscriptionId],
  );

  // Load the subscription list once (one cheap ARM GET; the selector falls
  // back to the connection's target when the list is unavailable).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const subs = await listSubscriptions(ports.azure, ports.logger);
        if (!cancelled) {
          setSubscriptions(subs);
        }
      } catch (err) {
        if (!cancelled) {
          setSubError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ports.azure, ports.logger]);

  return (
    <>
      <div className="panel">
        <h2 className="panel-title">Subscription and running labs</h2>
        <p className="panel-desc">
          Everything below operates in the selected subscription. The
          inventory lists resource groups tagged as labs (this app or the
          legacy UnifiedLab), soonest self-destruct first.
        </p>
        <label className="field">
          <span className="field-label">Subscription</span>
          {subscriptions !== null && subscriptions.length > 0 ? (
            <select
              value={subscriptionId}
              onChange={(e) => setSubscriptionId(e.target.value)}
            >
              {subscriptions.map((sub) => (
                <option key={sub.subscriptionId} value={sub.subscriptionId}>
                  {sub.displayName} ({sub.subscriptionId})
                </option>
              ))}
              {!subscriptions.some((s) => s.subscriptionId === subscriptionId) &&
                subscriptionId !== "" && (
                  <option value={subscriptionId}>{subscriptionId}</option>
                )}
            </select>
          ) : (
            <input
              type="text"
              value={subscriptionId}
              onChange={(e) => setSubscriptionId(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          )}
          {subError !== "" && (
            <span className="field-hint eh-warning">
              Subscription list unavailable ({subError}) - enter an id directly.
            </span>
          )}
        </label>
        <LabInventoryPanel subscriptionId={subscriptionId} />
      </div>

      <LabProvisionerPanels
        form={form}
        onFormChange={onFormChange}
        plan={plan}
        subscriptionId={subscriptionId}
        deployResult={deployResult}
        onDeployResult={setDeployResult}
      />

      <FlowLogPackPanel
        defaultStorageAccount={packStorageAccountName(
          "",
          deployResult,
          plan.names.storageAccount,
        )}
      />
    </>
  );
}
