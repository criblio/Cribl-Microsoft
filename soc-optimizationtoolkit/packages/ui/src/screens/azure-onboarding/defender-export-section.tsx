/**
 * DefenderExportSection - the Defender for Cloud alert export (AZR-3, on the
 * AZR-18 Azure Native Source Onboarding screen). Rendered inside the
 * "Direct configuration" section, under the catalog row whose checkbox the
 * screen binds to the saved selection.
 *
 * WHAT IT READS. "Read Defender state" makes the readDefenderState usecase's
 * reads (pricings, and the SUBSCRIPTION-WIDE automations list) and renders:
 *   - the plans table, including Standard plans outside the known list, or a
 *     status line when the plans could not be read - only a real read may ever
 *     say no paid plan is enabled (planSummary);
 *   - the existing continuous exports, each flagged when it already sends to
 *     the chosen hub or its namespace (a deploy would duplicate every alert);
 *   - a warning naming what differs when our export exists but is broken
 *     (repairing it is a follow-up, so Repair is disabled);
 *   - the note that this app never enables a paid plan;
 *   - the Azure actions it needs, per scope, as "needed, not yet measured" -
 *     no capability measures them yet, so Azure's own refusal at each step is
 *     what the operator will see.
 *
 * WHAT IT WRITES. One automation, create-only, after a TWO-STEP arm/confirm
 * that names the subscription, resource group, hub and automation name. The
 * arm is keyed on every input it names, so changing any of them disarms it -
 * a confirm can never apply to a target the operator did not see. A stale arm
 * is cleared, not just hidden, so changing an input and changing it back does
 * not bring the confirm back. The
 * deployDefenderExport usecase re-lists and refuses on its own after the
 * confirm; this section's gate (defenderDeployDisabledReason) only keeps the
 * button honest. The outcome is shown in Azure's words with the delivery
 * caveat. The connection string never reaches this component.
 *
 * WHAT IT DOES NOT DO. Untick makes no Azure call (the checkbox only edits the
 * selection). Remove and the extra Defender sources (recommendations, secure
 * score, regulatory compliance) are visible and disabled. The automation goes
 * into an EXISTING resource group the operator picks; nothing creates one.
 */

import { useEffect, useState } from "react";
import {
  DEFENDER_ACTIONS_NOT_MEASURED,
  DEFENDER_EXPORT_NAME,
  DEFENDER_NAMESPACE_ACTIONS,
  DEFENDER_SUBSCRIPTION_ACTIONS,
  deployDefenderExport,
  eventHubResourceId,
  findSameTargetExports,
  listResourceGroups,
  readDefenderState,
} from "@soc/core";
import type {
  AzureResourceGroup,
  CoverageSelection,
  DefenderDeployOutcome,
  DefenderState,
  Listing,
  RequiredAction,
} from "@soc/core";
import { usePorts } from "../../ports-context";
import {
  unmeasuredInventoryMessage,
  verifiedNoneInventoryMessage,
} from "../../capabilities/empty-inventory";
import {
  NEVER_ENABLES_PLAN_NOTE,
  defenderDeployDisabledReason,
  defenderStateNote,
  deployOutcomeMessage,
  planSummary,
} from "./azure-onboarding-state";
import type { PickerMessage } from "./azure-onboarding-state";
import { PickerLine } from "./eventhub-prerequisite-section";
import type { EventHubTarget } from "./eventhub-prerequisite-section";

/** The extra Defender sources, shown disabled: only alerts are exported for now. */
const EXTRA_SOURCES: readonly string[] = [
  "Recommendations",
  "Secure score",
  "Regulatory compliance",
];

const REMOVE_NOT_AVAILABLE =
  "Removing the export from here is not available yet. Unticking it does not remove it from Azure.";

export interface DefenderExportSectionProps {
  /** The loaded selection, or null when none was loaded. */
  selection: CoverageSelection | null;
  /** The chosen delivery target, from the Event Hub section. */
  target: EventHubTarget;
  /** The last Defender state read, owned by the screen (its rows read it too). */
  state: DefenderState | null;
  onState: (state: DefenderState) => void;
}

/** One automation-name chip list, "none" for an empty list. */
function joined(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

export function DefenderExportSection({
  selection,
  target,
  state,
  onState,
}: DefenderExportSectionProps) {
  const { ports, config } = usePorts();
  const subscriptionId = config.subscriptionId;

  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState("");
  // Bumped on every read, so a confirm armed against an earlier read disarms.
  const [readSeq, setReadSeq] = useState(0);
  const [groups, setGroups] = useState<Listing<AzureResourceGroup> | null>(null);
  const [groupsError, setGroupsError] = useState("");
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [resourceGroup, setResourceGroup] = useState<AzureResourceGroup | null>(null);
  const [armedFor, setArmedFor] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<DefenderDeployOutcome | null>(null);

  async function readState(): Promise<void> {
    setReading(true);
    setReadError("");
    try {
      const next = await readDefenderState(ports.azure, subscriptionId, ports.logger);
      onState(next);
      setReadSeq((n) => n + 1);
      ports.logger?.info("azure-onboarding: defender state read", {
        plans: next.plans.kind,
        ours: next.ours.kind,
      });
    } catch (error) {
      // The usecase never throws; this is a wiring fault, said out loud.
      const message = error instanceof Error ? error.message : String(error);
      setReadError(message);
      ports.logger?.error("azure-onboarding: defender state read threw", { error: message });
    } finally {
      setReading(false);
    }
  }

  async function loadGroups(): Promise<void> {
    setLoadingGroups(true);
    setGroupsError("");
    try {
      const listing = await listResourceGroups(ports.azure, subscriptionId, ports.logger);
      setGroups(listing);
    } catch (error) {
      setGroups(null);
      setGroupsError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingGroups(false);
    }
  }

  const namespace = target.namespace;
  const reason = defenderDeployDisabledReason({
    running,
    selection,
    state,
    namespace,
    hubName: target.hubName,
    rule: target.rule,
    resourceGroup: resourceGroup?.name ?? "",
  });
  // Everything the confirm names, plus the read it was armed against. Any
  // change produces a different key, and the arm no longer applies.
  const armKey = JSON.stringify([
    subscriptionId,
    resourceGroup?.name ?? "",
    namespace === null ? null : [namespace.subscriptionId, namespace.resourceGroup, namespace.name],
    target.hubName,
    target.rule?.name ?? "",
    selection?.enabled ?? null,
    readSeq,
  ]);
  const armed = reason === null && armedFor === armKey;
  // Drop a stale arm outright: otherwise reverting the change would re-arm it.
  useEffect(() => {
    setArmedFor((current) => (current !== null && current !== armKey ? null : current));
  }, [armKey]);

  async function confirmDeploy(): Promise<void> {
    if (reason !== null || namespace === null || target.rule === null || resourceGroup === null) {
      return;
    }
    setArmedFor(null);
    setRunning(true);
    setOutcome(null);
    ports.logger?.info("azure-onboarding: defender deploy confirmed", {
      resourceGroup: resourceGroup.name,
      namespace: namespace.name,
      hub: target.hubName,
      rule: target.rule.name,
    });
    const result = await deployDefenderExport(
      ports.azure,
      {
        subscriptionId,
        resourceGroup: resourceGroup.name,
        location: resourceGroup.location,
        namespace,
        hubName: target.hubName,
        ruleName: target.rule.name,
      },
      ports.logger,
    );
    setOutcome(result);
    setRunning(false);
    ports.logger?.info("azure-onboarding: defender deploy finished", { outcome: result.kind });
    if (result.kind === "written-and-read-back" || result.kind === "accepted-not-verified") {
      // Re-read so the row and the gate reflect what is now in Azure.
      await readState();
    }
  }

  const summary = state === null ? null : planSummary(state.plans);
  const listed =
    state !== null && state.automations.kind === "listed" ? state.automations.listing : null;
  const duplicates =
    listed !== null && namespace !== null && target.hubName !== ""
      ? new Set(findSameTargetExports(listed, eventHubResourceId(namespace, target.hubName)).map((a) => a.id))
      : new Set<string>();
  const stateNote = defenderStateNote(state);
  const groupRows = groups !== null && groups.kind === "rows" ? groups.rows : [];
  const groupsMessage: PickerMessage | null =
    groupsError !== ""
      ? { tone: "error", text: groupsError }
      : groups !== null && groups.kind !== "rows"
        ? { tone: "warning", text: unmeasuredInventoryMessage("resource groups").text }
        : null;

  return (
    <div className="azure-onboarding-block azure-onboarding-defender">
      <h3 className="discovery-title">Defender for Cloud alert export</h3>
      <p className="panel-desc">
        Creates one continuous export that sends this subscription&apos;s Defender for Cloud
        security alerts to the chosen Event Hub. It never turns on or changes a Defender plan.
      </p>

      <div className="panel-controls">
        <button
          type="button"
          className="run-button"
          onClick={() => void readState()}
          disabled={reading || subscriptionId === ""}
        >
          {reading ? "Reading Defender state..." : "Read Defender state"}
        </button>
      </div>
      {readError !== "" && <PickerLine message={{ tone: "error", text: readError }} />}

      {summary !== null && (
        <div className="azure-onboarding-subblock">
          <PickerLine
            message={{ tone: summary.tone === "ok" ? "info" : summary.tone, text: summary.headline }}
          />
          {summary.rows.length > 0 && (
            <table className="azure-onboarding-table" aria-label="Defender plans">
              <thead>
                <tr>
                  <th>Plan</th>
                  <th>Tier</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {summary.rows.map((row) => (
                  <tr key={row.name}>
                    <td>{row.displayName}</td>
                    <td>{row.tier}</td>
                    <td>{row.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {summary.steps.length > 0 && (
            <ol className="setup-steps">
              {summary.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          )}
        </div>
      )}
      <p className="field-hint">{NEVER_ENABLES_PLAN_NOTE}</p>

      {state !== null && (
        <div className="azure-onboarding-subblock">
          <span className="field-label">Existing continuous exports</span>
          {state.automations.kind === "unread" && (
            <PickerLine message={{ tone: "error", text: state.automations.failure.message }} />
          )}
          {stateNote !== null && <PickerLine message={stateNote} />}
          {listed !== null && listed.kind === "none" && (
            <p className="field-hint">{verifiedNoneInventoryMessage("continuous exports").text}</p>
          )}
          {listed !== null && listed.kind === "rows" && (
            <table className="azure-onboarding-table" aria-label="Existing continuous exports">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Resource group</th>
                  <th>Enabled</th>
                  <th>Sources</th>
                  <th>Event Hub targets</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {listed.rows.map((a) => (
                  <tr key={a.id || a.name}>
                    <td>{a.name}</td>
                    <td>{a.resourceGroup || "unknown"}</td>
                    <td>{a.isEnabled ? "Yes" : "No"}</td>
                    <td>{joined(a.sources)}</td>
                    <td>{joined(a.eventHubTargets)}</td>
                    <td>
                      {duplicates.has(a.id)
                        ? "Possible duplicate - already sends to the chosen Event Hub or its namespace"
                        : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {state.ours.kind === "present-differs" && (
            <>
              <PickerLine
                message={{
                  tone: "warning",
                  text:
                    `${DEFENDER_EXPORT_NAME} exists in ${state.ours.automation.resourceGroup || "an unknown resource group"} ` +
                    `but differs from what this app writes: ${state.ours.diffs.join(" ")}`,
                }}
              />
              <div className="panel-controls">
                <button type="button" className="run-button" disabled>
                  Repair export
                </button>
                <span className="field-hint">Repairing the export from here is not available yet.</span>
              </div>
            </>
          )}
          {state.ours.kind === "unknown" && (
            <PickerLine
              message={{
                tone: "error",
                text: `Whether ${DEFENDER_EXPORT_NAME} exists could not be read - ${state.ours.reason}`,
              }}
            />
          )}
        </div>
      )}

      <div className="azure-onboarding-subblock">
        <span className="field-label">Sources exported</span>
        <label className="integrate-check">
          <input type="checkbox" checked disabled aria-label="Security alerts" />
          <span className="integrate-check-text">Security alerts</span>
        </label>
        {EXTRA_SOURCES.map((name) => (
          <label className="integrate-check" key={name}>
            <input type="checkbox" checked={false} disabled aria-label={name} />
            <span className="integrate-check-text">{`${name} - not available yet`}</span>
          </label>
        ))}
      </div>

      <div className="azure-onboarding-subblock">
        <span className="field-label">Azure permissions this needs</span>
        <p className="field-hint">{DEFENDER_ACTIONS_NOT_MEASURED}</p>
        <RequiredActionList title="On the subscription" actions={DEFENDER_SUBSCRIPTION_ACTIONS} />
        <RequiredActionList title="On the Event Hub namespace" actions={DEFENDER_NAMESPACE_ACTIONS} />
      </div>

      <div className="form-grid">
        <div className="panel-controls">
          <button
            type="button"
            className="run-button"
            onClick={() => void loadGroups()}
            disabled={loadingGroups || subscriptionId === ""}
          >
            {loadingGroups ? "Loading resource groups..." : "Load resource groups"}
          </button>
        </div>
        {groupsMessage !== null && <PickerLine message={groupsMessage} />}
        <label className="field">
          <span className="field-label">Existing resource group for the export</span>
          <select
            aria-label="Resource group"
            value={resourceGroup?.name ?? ""}
            disabled={groupRows.length === 0}
            onChange={(e) => setResourceGroup(groupRows.find((g) => g.name === e.target.value) ?? null)}
          >
            <option value="">Choose a resource group</option>
            {groupRows.map((g) => (
              <option key={g.name} value={g.name}>
                {g.location !== "" ? `${g.name} (${g.location})` : g.name}
              </option>
            ))}
          </select>
          <span className="field-hint">The export is created in this group, at its location.</span>
        </label>
      </div>

      <div className="panel-controls">
        <button
          type="button"
          className="next-action-button"
          disabled={reason !== null || armed}
          onClick={() => setArmedFor(armKey)}
        >
          {running ? "Deploying..." : "Deploy alert export"}
        </button>
        {reason !== null && <span className="field-hint">{reason}</span>}
      </div>

      {armed && namespace !== null && resourceGroup !== null && (
        <div className="azure-onboarding-confirm" role="group" aria-label="Confirm deploy">
          <p className="panel-desc">
            {`Create ${DEFENDER_EXPORT_NAME} in subscription ${subscriptionId}, resource group ${resourceGroup.name}` +
              `${resourceGroup.location !== "" ? ` (${resourceGroup.location})` : ""}, ` +
              `sending security alerts to Event Hub ${target.hubName} in namespace ${namespace.name}` +
              ` with rule ${target.rule?.name ?? ""}? This creates one resource in Azure.`}
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

      {outcome !== null && <PickerLine message={deployOutcomeMessage(outcome)} />}

      <div className="panel-controls">
        <button type="button" className="run-button" disabled>
          Remove export
        </button>
        <span className="field-hint">{REMOVE_NOT_AVAILABLE}</span>
      </div>
    </div>
  );
}

function RequiredActionList({
  title,
  actions,
}: {
  title: string;
  actions: readonly RequiredAction[];
}) {
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
