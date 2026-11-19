/**
 * ReceiverGrantSection - grant the Cribl service principal Azure Event Hubs
 * Data Receiver on the plan's hub (or, by choice, its namespace), from the
 * Cribl source section of the Azure onboarding screen (AZR-103).
 *
 * WHAT IT READS. "Check the grant" runs core's planReceiverGrant: it resolves
 * the principal's object id (the plan value, cross-checked against the client
 * id; or looked up from the client id - never guessed) and reads the
 * principal's role assignments at the scope. A Data Receiver grant covering
 * the scope reads as already granted, and nothing is offered.
 *
 * WHAT IT WRITES. One role assignment, after a TWO-STEP arm/confirm quoting
 * the scope, the role and the principal. The plan and the arm are keyed on
 * the scope choice and every plan value the grant reads
 * (receiverGrantArmKey), so changing any of them drops both.
 *
 * WHAT IT RECORDS. Only an assignment Azure accepted from this PUT: the
 * screen writes it to the progress document (onGranted), which is what lets a
 * later removal prove it the app's. A grant found in place is never recorded,
 * with one exception: one at exactly this scope whose name and stamp prove it
 * this app's, when the record was lost (the save behind it failed and the page
 * reloaded). That is offered as "Record it", which writes no Azure state.
 *
 * REMOVAL (AZR-141) is in "Remove or pause what this app created"
 * (receiver-grant-remove-panel.tsx), from the records. The two never run at
 * once: `removing` turns Check and Grant off, and `onRunningChange` reports a
 * running Check or grant so the screen turns Remove off. A Check counts too
 * (review round 1): a plan read before a DELETE and landing after it would
 * otherwise show the removed assignment as still in place, and offer to
 * record it again.
 *
 * PERMISSIONS. roleAssignments/write at the scope is not measured: a banner
 * says so and lists the actions. Never a block - Azure's answer decides.
 */

import { useEffect, useId, useState } from "react";
import {
  DEFAULT_RECEIVER_GRANT_SCOPE,
  RECEIVER_GRANT_ACTIONS_NOT_MEASURED,
  RECEIVER_GRANT_PERMISSIONS,
  applyReceiverGrant,
  automationPermissionView,
  planReceiverGrant,
} from "@soc/core";
import type {
  ApplyReceiverGrantOutcome,
  PlanReceiverGrantResult,
  PlanValues,
  ReceiverGrantRecord,
  ReceiverGrantScopeChoice,
} from "@soc/core";
import { usePorts } from "../../ports-context";
import { useReportBusy } from "./operation-busy";
import { PickerLine } from "./eventhub-prerequisite-section";
import { AutomationPermissionBanner } from "./automation-permission-banner";
import {
  principalSourceText,
  receiverGrantArmKey,
  receiverGrantConfirmText,
  receiverGrantOutcomeMessage,
  receiverGrantPlanMessages,
  receiverGrantScopeOptions,
  receiverGrantToRerecord,
  RECEIVER_GRANT_RERECORD_TEXT,
} from "./receiver-grant-state";

export interface ReceiverGrantSectionProps {
  /** The saved plan values (the progress document's). */
  values: PlanValues;
  /** The screen's read counter: a new read drops a plan and an armed confirm. */
  readSeq: number;
  /** The grants this app recorded creating, from the progress document. */
  records: readonly ReceiverGrantRecord[];
  /**
   * Called with the record of an assignment Azure accepted from this app's
   * PUT. Returns whether the progress document took it.
   */
  onGranted: (record: ReceiverGrantRecord) => boolean;
  /** The chooser section's number, for the permission banner. */
  howtoSection: number;
  /** Scroll to the How-to steps (the manual path for this grant). */
  onShowHowto: () => void;
  /**
   * AZR-141: the teardown panel's Remove of a recorded grant is running.
   * Check and Grant are off meanwhile, and a plan or armed confirm made
   * before it is dropped: it described the assignments as they were.
   */
  removing?: boolean;
  /**
   * Told when a Check's reads or a grant's PUT start and finish, so the
   * screen keeps the teardown panel's Remove off meanwhile.
   */
  onRunningChange?: (running: boolean) => void;
}

export function ReceiverGrantSection({
  values,
  readSeq,
  records,
  onGranted,
  howtoSection,
  onShowHowto,
  removing = false,
  onRunningChange,
}: ReceiverGrantSectionProps) {
  const { ports, config, capabilities, capabilityContext } = usePorts();
  const permissionView = automationPermissionView({
    permissions: RECEIVER_GRANT_PERMISSIONS,
    capabilities,
    context: capabilityContext,
    howtoSection,
  });
  const reasonId = useId();
  const scopeName = useId();

  const [scope, setScope] = useState<ReceiverGrantScopeChoice>(DEFAULT_RECEIVER_GRANT_SCOPE);
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<{ key: string; result: PlanReceiverGrantResult } | null>(null);
  const [planError, setPlanError] = useState("");
  const [armedFor, setArmedFor] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  useReportBusy("a Data Receiver role grant", running);
  const [outcome, setOutcome] = useState<{ outcome: ApplyReceiverGrantOutcome; recorded: boolean } | null>(null);
  const [rerecorded, setRerecorded] = useState<{ key: string; recorded: boolean } | null>(null);

  // `removing` is in the key so a Remove drops a plan and an armed Grant outright.
  const key = `${receiverGrantArmKey(scope, values, readSeq)}|${removing ? "removing" : ""}`;
  const current = plan !== null && plan.key === key ? plan.result : null;
  const ready = current?.kind === "ready" ? current.ready : null;
  const armed = ready !== null && armedFor === key && !running;
  // Drop a stale plan and arm outright: otherwise reverting the change would re-show them.
  useEffect(() => {
    setArmedFor((a) => (a !== null && a !== key ? null : a));
    setPlan((p) => (p !== null && p.key !== key ? null : p));
  }, [key]);

  const azure = ports.azure;
  const checkReason =
    azure === undefined
      ? "The grant cannot be checked: there is no Azure connection configured."
      : planning || running
        ? "Working..."
        : removing
          ? "A removal of a Data Receiver assignment is running. Check and Grant are off until it finishes."
          : null;

  async function check(): Promise<void> {
    if (azure === undefined || planning || running || removing) return;
    setPlanning(true);
    onRunningChange?.(true);
    setPlanError("");
    setOutcome(null);
    setArmedFor(null);
    const at = key;
    try {
      const result = await planReceiverGrant(
        { azure, ...(ports.graph === undefined ? {} : { graph: ports.graph }), ...(ports.logger === undefined ? {} : { logger: ports.logger }) },
        { values, scope, appClientId: config.clientId ?? "", connectionTenantId: config.tenantId ?? "" },
      );
      setPlan({ key: at, result });
    } catch (error) {
      // The usecase never throws; this is a wiring fault, said out loud.
      const message = error instanceof Error ? error.message : String(error);
      setPlanError(message);
      ports.logger?.error("azure-onboarding: receiver grant plan threw", { error: message });
    } finally {
      setPlanning(false);
      onRunningChange?.(false);
    }
  }

  async function confirm(): Promise<void> {
    if (azure === undefined || ready === null || running || removing) return;
    setArmedFor(null);
    setRunning(true);
    onRunningChange?.(true);
    setOutcome(null);
    try {
      const result = await applyReceiverGrant(
        { azure, ...(ports.logger === undefined ? {} : { logger: ports.logger }) },
        ready,
      );
      const recorded = "record" in result ? onGranted(result.record) : true;
      setOutcome({ outcome: result, recorded });
      // What was planned is no longer what is in Azure: check again to see it.
      setPlan(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPlanError(message);
      ports.logger?.error("azure-onboarding: receiver grant apply threw", { error: message });
    } finally {
      setRunning(false);
      onRunningChange?.(false);
    }
  }

  const options = receiverGrantScopeOptions(values);
  const messages = current === null ? [] : receiverGrantPlanMessages(current);
  const toRerecord = current === null ? null : receiverGrantToRerecord(current, records);
  const rerecordResult = rerecorded !== null && rerecorded.key === key ? rerecorded.recorded : null;

  function rerecord(): void {
    if (toRerecord === null) return;
    setRerecorded({ key, recorded: onGranted(toRerecord) });
  }

  return (
    <div className="azure-onboarding-block" data-testid="azo-receiver-grant">
      <h3 className="discovery-title">Azure Event Hubs Data Receiver for the Cribl principal</h3>
      <p className="panel-desc">
        A Cribl Event Hubs source that signs in with Entra ID needs its service principal to hold Azure Event Hubs Data
        Receiver on the hub it reads. The app can make that one role assignment for you, or you can follow the How-to
        step. A Listen-only shared access rule needs none of this.
      </p>
      <AutomationPermissionBanner view={permissionView} sourceTitle={RECEIVER_GRANT_PERMISSIONS.sourceTitle} onShowHowto={onShowHowto} />

      <fieldset>
        <legend>Grant at</legend>
        {options.map((o) => (
          <label key={o.value} className="integrate-check">
            <input
              type="radio"
              name={scopeName}
              value={o.value}
              checked={scope === o.value}
              disabled={o.disabledReason !== null || planning || running}
              onChange={() => setScope(o.value)}
            />
            <span className="integrate-check-text">
              {o.label}
              {o.disabledReason === null ? "" : ` - ${o.disabledReason}`}
            </span>
          </label>
        ))}
      </fieldset>

      <div className="panel-controls">
        <button
          type="button"
          className="run-button"
          disabled={checkReason !== null}
          aria-describedby={checkReason !== null ? reasonId : undefined}
          onClick={() => void check()}
        >
          {planning ? "Checking the grant..." : "Check the grant"}
        </button>
        {checkReason !== null && !planning && !running && (
          <span className="field-hint" id={reasonId}>
            {checkReason}
          </span>
        )}
      </div>
      {planError !== "" && <PickerLine message={{ tone: "error", text: planError }} />}
      {messages.map((m) => (
        <PickerLine key={m.text} message={m} />
      ))}

      {toRerecord !== null && (
        <div className="azure-onboarding-subblock" data-testid="azo-receiver-grant-rerecord">
          <p className="panel-desc">{RECEIVER_GRANT_RERECORD_TEXT}</p>
          <div className="panel-controls">
            <button type="button" className="run-button" onClick={rerecord}>
              Record it
            </button>
          </div>
        </div>
      )}
      {rerecordResult === false && (
        <PickerLine
          message={{
            tone: "warning",
            text: "Your saved progress could not be updated, so the assignment is still not recorded.",
          }}
        />
      )}

      {ready !== null && (
        <div className="azure-onboarding-subblock">
          <span className="field-label">What will be created</span>
          <ul className="perm-list">
            <li>{`Role: ${ready.roleName} (role definition ${ready.roleDefinitionGuid})`}</li>
            <li>{`Principal: ${principalSourceText(ready.principal)}`}</li>
            <li>{`Scope: ${ready.scopeId}`}</li>
            <li>{`Assignment name: ${ready.assignmentName}`}</li>
          </ul>
          <div className="panel-controls">
            <button type="button" className="next-action-button" disabled={armed || running || removing} onClick={() => setArmedFor(key)}>
              {running ? "Granting..." : "Grant Data Receiver"}
            </button>
          </div>
        </div>
      )}

      {armed && ready !== null && (
        <div className="azure-onboarding-confirm" role="group" aria-label="Confirm the Data Receiver grant">
          <p className="panel-desc">{receiverGrantConfirmText(ready)}</p>
          <div className="panel-controls">
            <button type="button" className="next-action-button" onClick={() => void confirm()}>
              Confirm grant
            </button>
            <button type="button" className="run-button" onClick={() => setArmedFor(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {outcome !== null && <PickerLine message={receiverGrantOutcomeMessage(outcome.outcome, outcome.recorded)} />}

      <div className="azure-onboarding-subblock">
        <span className="field-label">Permissions this needs</span>
        {RECEIVER_GRANT_PERMISSIONS.notMeasured.map((group) => (
          <div key={group.scope} className="azure-onboarding-actions">
            <span className="field-hint">{group.scope}</span>
            <ul className="perm-list">
              {group.actions.map((a) => (
                <li key={a.action}>
                  <strong>{a.label}</strong>
                  {` - ${a.action}`}
                </li>
              ))}
            </ul>
          </div>
        ))}
        <p className="field-hint">{RECEIVER_GRANT_ACTIONS_NOT_MEASURED}</p>
      </div>

      {records.length > 0 && (
        <div className="azure-onboarding-subblock">
          <span className="field-label">Data Receiver assignments this app created</span>
          <ul className="perm-list">
            {records.map((r) => (
              <li key={`${r.scopeId}|${r.principalId}`}>{`${r.assignmentName} for object ID ${r.principalId} at ${r.scopeId}`}</li>
            ))}
          </ul>
          <p className="field-hint">
            Remove one from Remove or pause what this app created, below. An assignment this app did not make is removed in
            the Azure portal (Access control (IAM) on the hub or namespace).
          </p>
        </div>
      )}
    </div>
  );
}
