/**
 * ListenAccessPanel - create the Listen rule and the dedicated consumer group
 * the Cribl Event Hubs source reads with (AZR-36), above the Cribl source
 * lanes.
 *
 * ZERO CALLS ON MOUNT. Nothing is read until "Check what to create".
 *
 * TWO CLICKS. The check is read-only (core planListenAccess: a GET per name)
 * and lists every object with its verdict - create, reuse as it is, refused,
 * or unknown. When something can be created, the confirm quotes each PUT
 * exactly as it will be sent; only "Confirm: create in Azure" sends them, and
 * only while nothing the confirm names has changed (the arm key: namespace,
 * hubs, names, the two choices, and the screen's read counter). An existing
 * rule or group is never written: it is offered for reuse, or refused.
 *
 * PERMISSIONS INFORM, NEVER FORBID. The banner says the creates are needed and
 * not measured; nothing here is disabled because of it, and Azure's own
 * refusal is shown at the step.
 *
 * The objects the app created are handed to the screen (onCreated), which
 * records them so Remove (in "Remove or pause what this app created") can
 * prove them the app's.
 */

import { useEffect, useRef, useState } from "react";
import { applyListenAccess, planListenAccess, plannedWrites } from "@soc/core";
import type { ListenAccessApplyResult, ListenAccessPlan, ListenAccessTarget, NamespaceRef } from "@soc/core";
import { InfoTip } from "../../../components/info-tip";
import { usePorts } from "../../../ports-context";
import { PickerLine } from "../eventhub-prerequisite-section";
import {
  applyOutcomeMessage,
  listenAccessArmKey,
  listenAccessConfirmLines,
  listenAccessPermissionMessage,
  nothingToCreateText,
  planItemLine,
  STALE_CHECK_TEXT,
} from "./listen-access-state";

export interface ListenAccessPanelProps {
  /** The plan values' namespace, or null when incomplete. */
  readonly namespace: NamespaceRef | null;
  /** Every hub a chosen Event Hub lane reads. */
  readonly hubs: readonly string[];
  /** The plan values' consumer group. */
  readonly consumerGroup: string;
  /** The Listen rule name (the plan value, or the default). */
  readonly ruleName: string;
  /** Bumped by the screen on every Azure or Cribl read; a newer read disarms. */
  readonly readSeq: number;
  /** Told what the apply did, so the screen records what the app created and re-reads the rules. */
  readonly onCreated: (result: ListenAccessApplyResult) => void;
}

const PANEL_TIP =
  "A Cribl Event Hubs source reads with a consumer group of its own, so no other reader takes part of the stream, " +
  "and - only when it signs in with a connection string instead of Entra ID - a rule that can Listen and nothing else. " +
  "The app can create both. It reads each name first and never replaces anything that is already there: " +
  "an existing rule that can Listen, or an existing consumer group, is used as it is.";

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "planning" }
  | { readonly kind: "planned"; readonly key: string; readonly plan: ListenAccessPlan }
  | { readonly kind: "applying" }
  | { readonly kind: "done"; readonly result: ListenAccessApplyResult };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ListenAccessPanel({ namespace, hubs, consumerGroup, ruleName, readSeq, onCreated }: ListenAccessPanelProps) {
  const { ports } = usePorts();
  const [createGroups, setCreateGroups] = useState(true);
  const [createRule, setCreateRule] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [wiringError, setWiringError] = useState("");

  const target: ListenAccessTarget = {
    namespace: namespace ?? { subscriptionId: "", resourceGroup: "", name: "" },
    hubs,
    consumerGroup,
    ruleName,
    createRule,
    createGroups,
  };
  const key = listenAccessArmKey(target, readSeq);
  // The key as of the latest render, so a check that lands after the inputs
  // changed under it (hubs resolving, a newer read) is dropped, not armed.
  const latestKey = useRef(key);
  latestKey.current = key;
  // A change to anything the confirm names drops the plan outright: reverting
  // the change does not bring the old confirm back.
  useEffect(() => {
    setPhase((p) => (p.kind === "planned" && p.key !== key ? { kind: "idle" } : p));
  }, [key]);

  const busy = phase.kind === "planning" || phase.kind === "applying";
  const plan = phase.kind === "planned" ? phase.plan : null;
  // Armed only for the plan made from the inputs on screen now.
  const armed = phase.kind === "planned" && phase.key === key && plan !== null && plannedWrites(plan).length > 0;

  async function onCheck(): Promise<void> {
    setWiringError("");
    setPhase({ kind: "planning" });
    const checkedKey = key;
    try {
      const next = await planListenAccess(ports.azure, target, ports.logger);
      if (latestKey.current !== checkedKey) {
        setWiringError(STALE_CHECK_TEXT);
        setPhase({ kind: "idle" });
        return;
      }
      setPhase({ kind: "planned", key: checkedKey, plan: next });
    } catch (error) {
      setWiringError(`The check did not finish: ${errorText(error)}`);
      setPhase({ kind: "idle" });
    }
  }

  async function onConfirm(): Promise<void> {
    if (phase.kind !== "planned" || phase.key !== key) return;
    const confirmed = phase.plan;
    setPhase({ kind: "applying" });
    ports.logger?.info("azure-onboarding: listen access create confirmed", { writes: plannedWrites(confirmed).length });
    try {
      const result = await applyListenAccess(ports.azure, confirmed, ports.logger);
      setPhase({ kind: "done", result });
      onCreated(result);
    } catch (error) {
      setWiringError(`The create stopped before it reported an outcome: ${errorText(error)}. Check the namespace in Azure before retrying.`);
      setPhase({ kind: "idle" });
    }
  }

  const headline = plan !== null ? nothingToCreateText(plan) : null;

  return (
    <div className="azure-onboarding-subblock" aria-label="Listen rule and consumer group">
      <span className="field-label">
        Listen rule and consumer group (Azure) <InfoTip text={PANEL_TIP} />
      </span>
      <PickerLine message={listenAccessPermissionMessage()} announce={false} />
      <div className="form-grid">
        <label className="integrate-check">
          <input type="checkbox" checked={createGroups} onChange={(e) => setCreateGroups(e.target.checked)} />
          <span className="integrate-check-text">
            {`Consumer group ${consumerGroup.trim() === "" ? "(not set)" : consumerGroup.trim()} on ${hubs.length === 0 ? "no hub yet" : hubs.join(", ")}`}
          </span>
        </label>
        <label className="integrate-check">
          <input type="checkbox" checked={createRule} onChange={(e) => setCreateRule(e.target.checked)} />
          <span className="integrate-check-text">
            {`Listen rule ${ruleName} on ${namespace === null ? "the namespace" : namespace.name} (only for the connection-string credentials; Entra ID needs none)`}
          </span>
        </label>
      </div>
      <div className="panel-controls">
        <button type="button" className="run-button" disabled={busy} onClick={() => void onCheck()}>
          {phase.kind === "planning" ? "Checking..." : "Check what to create"}
        </button>
      </div>
      {wiringError !== "" && <p className="field-hint" role="alert">{wiringError}</p>}
      {plan !== null && plan.kind === "planned" && (
        <ul className="azure-onboarding-rows" aria-label="What the check found">
          {plan.items.map((item) => (
            <li key={item.resourceId}>
              <PickerLine message={planItemLine(item)} announce={false} />
            </li>
          ))}
        </ul>
      )}
      {headline !== null && <p className="field-hint">{headline}</p>}
      {armed && plan !== null && (
        <div className="azo-confirm" role="group" aria-label="Confirm the Azure creates">
          {listenAccessConfirmLines(plan).map((line) => (
            <p key={line} className="panel-desc">
              {line}
            </p>
          ))}
          <div className="panel-controls">
            <button type="button" className="next-action-button" onClick={() => void onConfirm()}>
              Confirm: create in Azure
            </button>
            <button type="button" className="run-button" onClick={() => setPhase({ kind: "idle" })}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {phase.kind === "applying" && <p className="field-hint">Creating...</p>}
      {phase.kind === "done" && (
        <div role="status">
          {phase.result.outcomes.map((o) => (
            <PickerLine key={o.item.resourceId} message={applyOutcomeMessage(o)} />
          ))}
          {phase.result.records.some((r) => r.kind === "listen-rule") && (
            <p className="field-hint">The namespace's rules are read again, so the new rule can be chosen for a connection-string source.</p>
          )}
        </div>
      )}
    </div>
  );
}
