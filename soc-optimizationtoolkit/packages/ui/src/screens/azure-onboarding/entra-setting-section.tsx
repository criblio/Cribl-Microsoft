/**
 * EntraSettingSection - the Entra ID tenant diagnostic setting (AZR-99, on the
 * AZR-18 Azure Native Source Onboarding screen). Rendered under the Entra ID
 * catalog row while that source is chosen in Automate mode, beside the
 * Activity Log section it mirrors.
 *
 * WHAT IT READS. "Read Entra ID diagnostic settings" makes the
 * readEntraSettingState usecase's one read (the TENANT's list) and renders it,
 * flagging any setting that already sends a chosen category to the plan's
 * namespace, and saying when ours is already applied or differs. An empty list
 * says it was not confirmed, never "none".
 *
 * WHAT IT WRITES. One tenant setting, CriblEntraIDLogs, create-only, after a
 * TWO-STEP arm/confirm quoting the setting name, the tenant, the namespace and
 * rule, the hub behaviour and every category. The target is the PLAN's -
 * namespace located by its own Event Hub keys (core entraDeployTarget), the
 * plan's Send rule and the chosen profile - so Deploy writes exactly what the
 * How-to step shows and Validate checks. The arm is keyed on every input it
 * names and on the read, so changing any of them disarms it. The usecase
 * re-lists and refuses on its own after the confirm.
 *
 * PERMISSIONS. An Entra directory role the app cannot measure: the banner
 * says so, and the needed actions are listed as not measurable.
 *
 * REMOVE is not here: it sits in "Remove or pause what this app created", so
 * it stays offered after Entra ID is unchosen.
 */

import { useEffect, useId, useState } from "react";
import {
  ENTRA_ACTIONS_NOT_MEASURABLE,
  ENTRA_AUTO_HUB_TEXT,
  ENTRA_ITEM_ID,
  ENTRA_SETTING_NAME,
  ENTRA_WARNING,
  automationPermissionView,
  automationPermissionsFor,
  deployEntraSetting,
  describeSettingDiff,
  findOverlappingEntraSettings,
  licenceNotes,
  readEntraSettingState,
} from "@soc/core";
import type {
  EntraDeployForValidation,
  EntraDeployOutcome,
  EntraSettingRecord,
  EntraSettingState,
  RequiredAction,
} from "@soc/core";
import { usePorts } from "../../ports-context";
import { verifiedNoneInventoryMessage } from "../../capabilities/empty-inventory";
import { PickerLine } from "./eventhub-prerequisite-section";
import type { EventHubTarget } from "./eventhub-prerequisite-section";
import { AutomationPermissionBanner } from "./automation-permission-banner";
import type { RowChoice } from "./azure-onboarding-state";
import {
  entraDeployConfirmText,
  entraDeployDisabledReason,
  entraOursForTarget,
  entraOutcomeMessage,
  entraStateNote,
  planRuleRights,
} from "./entra-setting-state";
import type { EntraTarget } from "./entra-setting-state";

export interface EntraSettingSectionProps {
  /** The source's choice as the chooser answers it; Deploy runs only when it is chosen in Automate mode. */
  choice: RowChoice;
  /** The Deploy's target from the plan (core entraDeployTarget), or null while progress is loading. */
  entraTarget: EntraTarget;
  /** The chosen Entra profile's name, for the copy. */
  profile: string;
  /** Section 1's pick: used only to know the plan rule's rights when it is the same rule. */
  picked: EventHubTarget;
  /** This app's record of writing the setting in this tenant, or null: chooses the advice for a differing setting. */
  record: EntraSettingRecord | null;
  /** The last read, owned by the screen (its row label reads it too). */
  state: EntraSettingState | null;
  onState: (state: EntraSettingState) => void;
  /** Called after a deploy that WROTE the setting, so the screen records it and amends Validate. */
  onDeployed?: (deploy: EntraDeployForValidation) => void;
  /** The chooser section's number, so the banner can name it. */
  howtoSection: number;
  /** Scroll to and focus this source's How-to row. */
  onShowHowto: () => void;
}

export function EntraSettingSection({
  choice,
  entraTarget,
  profile,
  picked,
  record,
  state,
  onState,
  onDeployed,
  howtoSection,
  onShowHowto,
}: EntraSettingSectionProps) {
  const { ports, config, capabilities, capabilityContext } = usePorts();
  const tenantId = config.tenantId;
  const permissions = automationPermissionsFor(ENTRA_ITEM_ID);
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
  const [outcome, setOutcome] = useState<EntraDeployOutcome | null>(null);

  async function readState(): Promise<void> {
    setReading(true);
    setReadError("");
    try {
      const next = await readEntraSettingState(ports.azure, ports.logger);
      onState(next);
      setReadSeq((n) => n + 1);
      ports.logger?.info("azure-onboarding: entra setting state read", { ours: next.ours.kind });
    } catch (error) {
      // The usecase never throws; this is a wiring fault, said out loud.
      const message = error instanceof Error ? error.message : String(error);
      setReadError(message);
      ports.logger?.error("azure-onboarding: entra setting state read threw", { error: message });
    } finally {
      setReading(false);
    }
  }

  const input = entraTarget?.input ?? null;
  const ruleRights = planRuleRights(picked, input);
  const reason = entraDeployDisabledReason({ running, choice, state, tenantId, target: entraTarget, ruleRights, record });
  const armKey = JSON.stringify([
    tenantId,
    input === null
      ? null
      : [input.namespace.subscriptionId, input.namespace.resourceGroup, input.namespace.name, input.ruleName, input.categories],
    choice,
    readSeq,
  ]);
  const armed = reason === null && armedFor === armKey;
  // Drop a stale arm outright: otherwise reverting the change would re-arm it.
  useEffect(() => {
    setArmedFor((current) => (current !== null && current !== armKey ? null : current));
  }, [armKey]);

  async function confirmDeploy(): Promise<void> {
    if (reason !== null || input === null) return;
    setArmedFor(null);
    setRunning(true);
    setOutcome(null);
    ports.logger?.info("azure-onboarding: entra deploy confirmed", {
      namespace: input.namespace.name,
      rule: input.ruleName,
      categories: input.categories.length,
    });
    const result = await deployEntraSetting(ports.azure, input, ports.logger);
    setOutcome(result);
    setRunning(false);
    if (result.kind === "written-and-read-back" || result.kind === "accepted-not-verified") {
      onDeployed?.({ source: "entraId", outcome: result.kind, input });
      await readState();
    }
  }

  const listed = state !== null && state.settings.kind === "listed" ? state.settings.listing : null;
  const duplicates =
    listed !== null && input !== null
      ? new Set(findOverlappingEntraSettings(listed, input.namespace, input.categories).map((s) => s.id || s.name))
      : new Set<string>();
  const stateNote = entraStateNote(state);
  const ours = entraOursForTarget(state, input);
  const licences = input === null ? [] : licenceNotes(input.categories);

  return (
    <div className="azure-onboarding-block">
      <h3 className="discovery-title">Entra ID diagnostic setting</h3>
      <p className="panel-desc">
        {`Creates one tenant-wide Entra ID diagnostic setting, ${ENTRA_SETTING_NAME}, that streams the chosen sign-in and audit ` +
          "categories to the Event Hub namespace your plan names. With no hub name set, Azure creates one hub per category in that namespace."}
      </p>
      <p className="field-hint">{ENTRA_WARNING}</p>
      {permissions !== null && permissionView !== null && (
        <AutomationPermissionBanner view={permissionView} sourceTitle={permissions.sourceTitle} onShowHowto={onShowHowto} />
      )}

      <div className="panel-controls">
        <button type="button" className="run-button" onClick={() => void readState()} disabled={reading}>
          {reading ? "Reading Entra ID diagnostic settings..." : "Read Entra ID diagnostic settings"}
        </button>
      </div>
      {readError !== "" && <PickerLine message={{ tone: "error", text: readError }} />}

      {state !== null && (
        <div className="azure-onboarding-subblock">
          <span className="field-label">Existing Entra ID diagnostic settings in this tenant</span>
          {state.settings.kind === "unread" && <PickerLine message={{ tone: "error", text: state.settings.failure.message }} />}
          {stateNote !== null && <PickerLine message={stateNote} />}
          {listed !== null && listed.kind === "none" && (
            <p className="field-hint">{verifiedNoneInventoryMessage("Entra ID diagnostic settings").text}</p>
          )}
          {listed !== null && listed.kind === "rows" && (
            <table className="azure-onboarding-table" aria-label="Existing Entra ID diagnostic settings">
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
                    <td>{s.hub || (s.ruleId !== "" ? ENTRA_AUTO_HUB_TEXT : "none")}</td>
                    <td>{s.enabled.length + s.enabledGroups.length === 0 ? "none" : [...s.enabled, ...s.enabledGroups].join(", ")}</td>
                    <td>{duplicates.has(s.id || s.name) ? "Possible duplicate - already sends a chosen category to this namespace" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {ours?.kind === "present-matching" && (
            <PickerLine message={{ tone: "info", text: `${ENTRA_SETTING_NAME} is already applied in this tenant.` }} />
          )}
          {ours?.kind === "present-differs" && (
            <PickerLine
              message={{
                tone: "warning",
                text: `${ENTRA_SETTING_NAME} exists but differs from what this app writes: ${ours.diffs.map(describeSettingDiff).join(" ")}`,
              }}
            />
          )}
        </div>
      )}

      <div className="azure-onboarding-subblock">
        <span className="field-label">What will be created</span>
        <ul className="perm-list">
          <li>{`Setting: ${ENTRA_SETTING_NAME}, in tenant ${tenantId || "(none configured)"}`}</li>
          <li>
            {input === null
              ? "Sends with: (the plan's Event Hub namespace and Send rule, once named)"
              : `Sends with: namespace ${input.namespace.name} (resource group ${input.namespace.resourceGroup}, subscription ${input.namespace.subscriptionId}), rule ${input.ruleName}`}
          </li>
          <li>{`Hub: ${ENTRA_AUTO_HUB_TEXT}`}</li>
          <li>{`Categories (${profile}): ${input === null ? "" : input.categories.join(", ")}`}</li>
        </ul>
        <span className="field-hint">
          A diagnostic setting needs a namespace rule with Manage rights, because Azure creates the hubs itself.
          {ruleRights === null && input !== null ? " This rule's rights were not read here; Azure decides at the write." : ""}
        </span>
        {licences.length > 0 && (
          <>
            <span className="field-label">Licences these categories need (not checked by the app)</span>
            <ul className="perm-list">
              {licences.map((n) => (
                <li key={n.category}>{`${n.category}: ${n.licence}`}</li>
              ))}
            </ul>
          </>
        )}
      </div>

      {permissions !== null && permissions.notMeasured.length > 0 && (
        <div className="azure-onboarding-subblock">
          <span className="field-label">Permissions this needs</span>
          {permissions.notMeasured.map((group) => (
            <ActionList key={group.scope} title={group.scope} actions={group.actions} />
          ))}
          <p className="field-hint">{ENTRA_ACTIONS_NOT_MEASURABLE}</p>
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
          {running ? "Deploying..." : "Deploy Entra ID setting"}
        </button>
        {reason !== null && (
          <span className="field-hint" id={reasonId}>
            {reason}
          </span>
        )}
      </div>

      {armed && input !== null && (
        <div className="azure-onboarding-confirm" role="group" aria-label="Confirm Entra ID deploy">
          <p className="panel-desc">{entraDeployConfirmText(tenantId, input, profile)}</p>
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

      {outcome !== null && <PickerLine message={entraOutcomeMessage(outcome, record)} />}
      <p className="field-hint">
        {`To remove ${ENTRA_SETTING_NAME} later, use Remove or pause what this app created, below; unchoosing Entra ID does not remove it.`}
      </p>
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
