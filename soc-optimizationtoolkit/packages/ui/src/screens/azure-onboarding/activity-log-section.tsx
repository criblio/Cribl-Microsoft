/**
 * ActivityLogSection - the subscription Activity Log export (AZR-98, on the
 * AZR-18 Azure Native Source Onboarding screen). Rendered under the Activity
 * Log catalog row while that source is in Automate mode, beside the
 * Defender export section it mirrors.
 *
 * WHAT IT READS. "Read diagnostic settings" makes the readActivityLogState
 * usecase's one read (the subscription's diagnostic settings) and renders
 * them, flagging any that already send to the chosen namespace (a deploy would
 * duplicate every event) and saying when ours exists but differs (repairing it
 * is not built, so Repair is disabled). An empty list says it was not
 * confirmed, never "none".
 *
 * WHAT IT SAYS ABOUT PERMISSIONS. The banner from core's
 * automationPermissionView over this source's declaration: nothing about it is
 * measured by the permission check yet, and the banner says so instead of
 * staying silent. The needed actions are listed per scope as not measured.
 *
 * WHAT IT WRITES. One diagnostic setting, create-only, after a TWO-STEP
 * arm/confirm that quotes the setting name, the subscription, the namespace
 * and rule, and every category. The arm is keyed on every input it names and
 * on the read, so changing any of them disarms it. The deployActivityLogExport
 * usecase re-lists and refuses on its own after the confirm; the gate
 * (activityLogDeployDisabledReason) only keeps the button honest. No key is
 * read anywhere: a diagnostic setting names the rule by id.
 *
 * AFTER A WRITE it calls `onDeployed`, so a Validate result read before the
 * deploy is brought up to date (applyOnboardingDeploy), and re-reads.
 *
 * WHAT IT DOES NOT DO. Untick makes no Azure call. Remove is visible and
 * disabled. The hub chosen in the Event Hub section is not used: Azure writes
 * the Activity Log to the hub it creates, insights-activity-logs.
 */

import { useEffect, useId, useState } from "react";
import {
  ACTIVITY_LOG_AUTO_HUB,
  ACTIVITY_LOG_CATEGORIES,
  ACTIVITY_LOG_ITEM_ID,
  ACTIVITY_LOG_SETTING_NAME,
  ACTIVITY_LOG_ACTIONS_NOT_MEASURED,
  LAKE_ROUTE_SOURCES,
  automationPermissionView,
  automationPermissionsFor,
  deployActivityLogExport,
  describeSettingDiff,
  findSameNamespaceSettings,
  readActivityLogState,
} from "@soc/core";
import type {
  ActivityLogDeployForValidation,
  ActivityLogDeployOutcome,
  ActivityLogState,
  CoverageSelection,
  RequiredAction,
} from "@soc/core";
import { usePorts } from "../../ports-context";
import { verifiedNoneInventoryMessage } from "../../capabilities/empty-inventory";
import { PickerLine } from "./eventhub-prerequisite-section";
import type { EventHubTarget } from "./eventhub-prerequisite-section";
import { AutomationPermissionBanner } from "./automation-permission-banner";
import {
  activityLogDeployDisabledReason,
  activityLogOutcomeMessage,
  activityLogStateNote,
  categoriesText,
  oursForTarget,
} from "./activity-log-state";

const REMOVE_NOT_AVAILABLE =
  "Removing the setting from here is not available yet. Unticking the Activity Log does not remove it from Azure.";

export interface ActivityLogSectionProps {
  /** The loaded selection, or null when none was loaded. */
  selection: CoverageSelection | null;
  /** The chosen delivery target, from the Event Hub section. Its hub is not used. */
  target: EventHubTarget;
  /** The last read, owned by the screen (its row label reads it too). */
  state: ActivityLogState | null;
  onState: (state: ActivityLogState) => void;
  /** Called after a deploy that WROTE the setting, so an earlier Validate result can be amended. */
  onDeployed?: (deploy: ActivityLogDeployForValidation) => void;
  /** The How-to section's number on the screen, so the banner can name it. */
  howtoSection: number;
  /** Scroll to and focus this source's How-to row. */
  onShowHowto: () => void;
}

export function ActivityLogSection({
  selection,
  target,
  state,
  onState,
  onDeployed,
  howtoSection,
  onShowHowto,
}: ActivityLogSectionProps) {
  const { ports, config, capabilities, capabilityContext } = usePorts();
  const subscriptionId = config.subscriptionId;
  const permissions = automationPermissionsFor(ACTIVITY_LOG_ITEM_ID);
  const permissionView =
    permissions === null
      ? null
      : automationPermissionView({ permissions, capabilities, context: capabilityContext, howtoSection });
  const reasonId = useId();

  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState("");
  const [readSeq, setReadSeq] = useState(0);
  const [armedFor, setArmedFor] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<ActivityLogDeployOutcome | null>(null);

  async function readState(): Promise<void> {
    setReading(true);
    setReadError("");
    try {
      const next = await readActivityLogState(ports.azure, subscriptionId, ports.logger);
      onState(next);
      setReadSeq((n) => n + 1);
      ports.logger?.info("azure-onboarding: activity log state read", { ours: next.ours.kind });
    } catch (error) {
      // The usecase never throws; this is a wiring fault, said out loud.
      const message = error instanceof Error ? error.message : String(error);
      setReadError(message);
      ports.logger?.error("azure-onboarding: activity log state read threw", { error: message });
    } finally {
      setReading(false);
    }
  }

  const namespace = target.namespace;
  const rule = target.rule;
  const reason = activityLogDeployDisabledReason({ running, selection, state, subscriptionId, namespace, rule });
  const armKey = JSON.stringify([
    subscriptionId,
    namespace === null ? null : [namespace.subscriptionId, namespace.resourceGroup, namespace.name],
    rule?.name ?? "",
    selection?.enabled ?? null,
    readSeq,
  ]);
  const armed = reason === null && armedFor === armKey;
  // Drop a stale arm outright: otherwise reverting the change would re-arm it.
  useEffect(() => {
    setArmedFor((current) => (current !== null && current !== armKey ? null : current));
  }, [armKey]);

  async function confirmDeploy(): Promise<void> {
    if (reason !== null || namespace === null || rule === null) return;
    setArmedFor(null);
    setRunning(true);
    setOutcome(null);
    const input = { subscriptionId, namespace, ruleName: rule.name };
    ports.logger?.info("azure-onboarding: activity log deploy confirmed", { namespace: namespace.name, rule: rule.name });
    const result = await deployActivityLogExport(ports.azure, input, ports.logger);
    setOutcome(result);
    setRunning(false);
    ports.logger?.info("azure-onboarding: activity log deploy finished", { outcome: result.kind });
    if (result.kind === "written-and-read-back" || result.kind === "accepted-not-verified") {
      onDeployed?.({ source: "activityLog", outcome: result.kind, input });
      // Re-read so the row and the gate reflect what is now in Azure.
      await readState();
    }
  }

  const listed = state !== null && state.settings.kind === "listed" ? state.settings.listing : null;
  const duplicates =
    listed !== null && namespace !== null
      ? new Set(findSameNamespaceSettings(listed, namespace).map((s) => s.id || s.name))
      : new Set<string>();
  const stateNote = activityLogStateNote(state);
  // The same judgement the gate makes, so the warning and the reason agree.
  const ours = oursForTarget(state, { subscriptionId, namespace, rule });
  const categories = categoriesText(ACTIVITY_LOG_CATEGORIES);
  const hubIgnored = target.hubName !== "" && target.hubName.toLowerCase() !== ACTIVITY_LOG_AUTO_HUB;

  return (
    <div className="azure-onboarding-block">
      <h3 className="discovery-title">Activity Log export</h3>
      <p className="panel-desc">
        {`Creates one subscription diagnostic setting, ${ACTIVITY_LOG_SETTING_NAME}, that streams this subscription's ` +
          `Activity Log to the chosen Event Hub namespace. Azure writes it to a hub it creates, ${ACTIVITY_LOG_AUTO_HUB}.`}
      </p>
      <p className="field-hint">{LAKE_ROUTE_SOURCES.activityLog.nativeConnectorCopy}</p>
      {permissions !== null && permissionView !== null && (
        <AutomationPermissionBanner
          view={permissionView}
          sourceTitle={permissions.sourceTitle}
          onShowHowto={onShowHowto}
        />
      )}

      <div className="panel-controls">
        <button
          type="button"
          className="run-button"
          onClick={() => void readState()}
          disabled={reading || subscriptionId === ""}
        >
          {reading ? "Reading diagnostic settings..." : "Read diagnostic settings"}
        </button>
        {subscriptionId === "" && (
          <span className="field-hint">No Azure subscription is configured for this connection.</span>
        )}
      </div>
      {readError !== "" && <PickerLine message={{ tone: "error", text: readError }} />}

      {state !== null && (
        <div className="azure-onboarding-subblock">
          <span className="field-label">Existing diagnostic settings on this subscription</span>
          {state.settings.kind === "unread" && (
            <PickerLine message={{ tone: "error", text: state.settings.failure.message }} />
          )}
          {stateNote !== null && <PickerLine message={stateNote} />}
          {listed !== null && listed.kind === "none" && (
            <p className="field-hint">{verifiedNoneInventoryMessage("diagnostic settings").text}</p>
          )}
          {listed !== null && listed.kind === "rows" && (
            <table className="azure-onboarding-table" aria-label="Existing diagnostic settings">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Authorization rule</th>
                  <th>Hub</th>
                  <th>Categories enabled</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {listed.rows.map((s) => (
                  <tr key={s.id || s.name}>
                    <td>{s.name}</td>
                    <td>{s.ruleId || "none"}</td>
                    <td>{s.hub || (s.ruleId !== "" ? `${ACTIVITY_LOG_AUTO_HUB} (chosen by Azure)` : "none")}</td>
                    <td>{s.enabled.length + s.enabledGroups.length === 0 ? "none" : [...s.enabled, ...s.enabledGroups].join(", ")}</td>
                    <td>
                      {duplicates.has(s.id || s.name)
                        ? "Possible duplicate - already sends to the chosen namespace"
                        : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {ours?.kind === "present-differs" && (
            <>
              <PickerLine
                message={{
                  tone: "warning",
                  text:
                    `${ACTIVITY_LOG_SETTING_NAME} exists but differs from what this app writes: ` +
                    ours.diffs.map(describeSettingDiff).join(" "),
                }}
              />
              <div className="panel-controls">
                <button type="button" className="run-button" disabled>
                  Repair setting
                </button>
                <span className="field-hint">Repairing the setting from here is not available yet.</span>
              </div>
            </>
          )}
        </div>
      )}

      <div className="azure-onboarding-subblock">
        <span className="field-label">What will be created</span>
        <ul className="perm-list">
          <li>{`Setting: ${ACTIVITY_LOG_SETTING_NAME}, on subscription ${subscriptionId || "(none configured)"}`}</li>
          <li>
            {`Sends with: ${namespace === null ? "(choose a namespace in the Event Hub section)" : `namespace ${namespace.name}`}` +
              `${rule === null ? ", rule (choose one in the Event Hub section)" : `, rule ${rule.name}`}`}
          </li>
          <li>{`Hub: ${ACTIVITY_LOG_AUTO_HUB}, created by Azure`}</li>
          <li>{`Categories: ${categories}`}</li>
        </ul>
        <span className="field-hint">
          A diagnostic setting needs a namespace rule with Manage rights, because Azure creates the hub itself.
        </span>
        {hubIgnored && (
          <span className="field-hint">
            {`The hub chosen in the Event Hub section, ${target.hubName}, is not used for the Activity Log.`}
          </span>
        )}
      </div>

      {permissions !== null && permissions.notMeasured.length > 0 && (
        <div className="azure-onboarding-subblock">
          <span className="field-label">Azure permissions this needs</span>
          {permissions.notMeasured.map((group) => (
            <ActionList key={group.scope} title={group.scope} actions={group.actions} />
          ))}
          <p className="field-hint">{ACTIVITY_LOG_ACTIONS_NOT_MEASURED}</p>
        </div>
      )}

      <div className="panel-controls">
        <button
          type="button"
          className="next-action-button"
          disabled={reason !== null || armed}
          aria-describedby={reason !== null ? reasonId : undefined}
          onClick={() => setArmedFor(armKey)}
        >
          {running ? "Deploying..." : "Deploy Activity Log setting"}
        </button>
        {reason !== null && (
          <span className="field-hint" id={reasonId}>
            {reason}
          </span>
        )}
      </div>

      {armed && namespace !== null && rule !== null && (
        <div className="azure-onboarding-confirm" role="group" aria-label="Confirm Activity Log deploy">
          <p className="panel-desc">
            {`Create the diagnostic setting ${ACTIVITY_LOG_SETTING_NAME} on subscription ${subscriptionId}, ` +
              `sending the Activity Log to namespace ${namespace.name} with rule ${rule.name} ` +
              `(Azure writes it to ${ACTIVITY_LOG_AUTO_HUB}), with every category enabled: ${categories}? ` +
              "This creates one setting in Azure."}
          </p>
          <div className="panel-controls">
            <button type="button" className="next-action-button" onClick={() => void confirmDeploy()}>
              Confirm deploy
            </button>
            <button type="button" className="run-button" onClick={() => setArmedFor(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {outcome !== null && <PickerLine message={activityLogOutcomeMessage(outcome)} />}

      <div className="panel-controls">
        <button type="button" className="run-button" disabled>
          Remove setting
        </button>
        <span className="field-hint">{REMOVE_NOT_AVAILABLE}</span>
      </div>
    </div>
  );
}

function ActionList({ title, actions }: { title: string; actions: readonly RequiredAction[] }) {
  return (
    <div className="azure-onboarding-actions">
      <span className="field-hint">{title}</span>
      <ul className="perm-list">
        {actions.map((a) => (
          <li key={a.action}>
            <strong>{a.label}</strong>
            {` - ${a.action}`}
          </li>
        ))}
      </ul>
    </div>
  );
}
