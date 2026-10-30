/**
 * EventHubPrerequisiteSection - the Event Hub every Azure Native Source
 * Onboarding item delivers to (AZR-11, on the AZR-18 screen). It sits OUTSIDE
 * the coverage catalog: the hub is chosen, not ticked, so it is a prerequisite
 * (core ITEM_PREREQUISITES), not a row.
 *
 * USE EXISTING ONLY. The operator finds the subscription's namespaces (one
 * Resource Graph read, no per-namespace GETs) or pastes a namespace or hub
 * resource id, then picks an existing hub and an existing NAMESPACE-level
 * authorization rule. Creating a namespace, a hub or a rule is out of scope for
 * this slice, so those controls render visible and disabled.
 *
 * RULES. Only a rule that can Send (Send or Manage) is offered: a Listen-only
 * rule lets the Defender export be created and read back while nothing is ever
 * delivered. Nothing is preselected - the namespace's built-in Manage rule is
 * allowed, but the operator picks it knowingly, and a note says a dedicated
 * Send-only rule is safer. Each option shows the rule's rights.
 *
 * A PASTED HUB MUST EXIST. A hub id pasted in is checked against the
 * namespace's hub listing once it lands. When that listing is COMPLETE (2xx,
 * no nextLink, measured rows or measured none) and the hub is not in it, the
 * hub is dropped from the choice and a warning names it, so the deploy gate
 * asks for a hub instead of writing an export to one that does not exist. Only
 * a truncated, unmeasured or failed listing keeps the pasted name selectable:
 * those cannot prove it absent.
 *
 * NO KEY HERE. Listing the rules never returns a key; the connection string is
 * fetched only inside the Defender deploy, after the confirm. The choice lives
 * in the screen's React state and is not persisted.
 *
 * Controlled: the screen owns {@link EventHubTarget} because the Defender
 * section's deploy gate reads it. Every list and empty state is worded by
 * azure-onboarding-state.ts; this component only renders and drives IO through
 * the ports, logging with the `azure-onboarding:` prefix.
 */

import { useRef, useState } from "react";
import {
  discoverEventHubNamespaces,
  listNamespaceAuthRules,
  listNamespaceHubs,
  parseEventHubResourceId,
  parseNamespaceResourceId,
} from "@soc/core";
import type {
  EventHubInfo,
  EventHubNamespaceInfo,
  EventHubTargetRead,
  EventHubTargetRule,
  Listing,
  NamespaceRef,
} from "@soc/core";
import { usePorts } from "../../ports-context";
import { NumberedSection } from "../../components/numbered-section";
import {
  hubListMessage,
  namespaceListMessage,
  ruleListMessage,
  ruleNote,
  sendableRules,
} from "./azure-onboarding-state";
import type { PickerMessage } from "./azure-onboarding-state";

/** The chosen delivery target. Lives in React state only. */
export interface EventHubTarget {
  readonly namespace: NamespaceRef | null;
  readonly hubName: string;
  readonly rule: EventHubTargetRule | null;
}

/** A stable key for one namespace, for the select's values. */
function namespaceKey(ns: NamespaceRef): string {
  return `${ns.subscriptionId}/${ns.resourceGroup}/${ns.name}`;
}

const SECTION_TIP =
  "Every source on this page sends to an Event Hub that Cribl Stream reads. Choose an existing namespace, hub and authorization rule here; the rule's connection string is read only when you deploy, and is never shown or stored.";

const CREATE_NOT_AVAILABLE =
  "Creating a namespace, an Event Hub or an authorization rule from here is not available yet. Use existing ones.";

export interface EventHubPrerequisiteSectionProps {
  /** The section's badge number. */
  number: number;
  value: EventHubTarget;
  onChange: (next: EventHubTarget) => void;
}

export function EventHubPrerequisiteSection({
  number,
  value,
  onChange,
}: EventHubPrerequisiteSectionProps) {
  const { ports, config } = usePorts();
  const subscriptionId = config.subscriptionId;

  const [finding, setFinding] = useState(false);
  const [namespaces, setNamespaces] = useState<Listing<EventHubNamespaceInfo> | null>(null);
  const [namespaceError, setNamespaceError] = useState("");
  const [pasted, setPasted] = useState("");
  const [pasteError, setPasteError] = useState("");
  const [loadingTarget, setLoadingTarget] = useState(false);
  const [hubs, setHubs] = useState<EventHubTargetRead<EventHubInfo> | null>(null);
  const [rules, setRules] = useState<EventHubTargetRead<EventHubTargetRule> | null>(null);
  // A pasted hub a complete listing proved absent; named in a warning.
  const [missingHub, setMissingHub] = useState("");
  // A later namespace choice wins over an earlier read still in flight.
  const targetRead = useRef(0);

  async function findNamespaces(): Promise<void> {
    setFinding(true);
    setNamespaceError("");
    try {
      const listing = await discoverEventHubNamespaces(ports.azure, subscriptionId, ports.logger);
      setNamespaces(listing);
      ports.logger?.info("azure-onboarding: namespaces listed", { listing: listing.kind });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNamespaces(null);
      setNamespaceError(message);
      ports.logger?.warn("azure-onboarding: namespace list failed", { error: message });
    } finally {
      setFinding(false);
    }
  }

  async function chooseNamespace(ns: NamespaceRef, hubName = ""): Promise<void> {
    const ref: NamespaceRef = {
      subscriptionId: ns.subscriptionId,
      resourceGroup: ns.resourceGroup,
      name: ns.name,
    };
    onChange({ namespace: ref, hubName, rule: null });
    const seq = ++targetRead.current;
    setHubs(null);
    setRules(null);
    setMissingHub("");
    setLoadingTarget(true);
    const [hubRead, ruleRead] = await Promise.all([
      listNamespaceHubs(ports.azure, ref),
      listNamespaceAuthRules(ports.azure, ref),
    ]);
    if (seq !== targetRead.current) return;
    setHubs(hubRead);
    setRules(ruleRead);
    setLoadingTarget(false);
    if (hubName !== "" && hubProvedAbsent(hubRead, hubName)) {
      // Rules were still loading, so no rule can have been chosen yet.
      setMissingHub(hubName);
      onChange({ namespace: ref, hubName: "", rule: null });
      ports.logger?.warn("azure-onboarding: pasted hub not in namespace", {
        namespace: ref.name,
        hub: hubName,
      });
    }
    ports.logger?.info("azure-onboarding: namespace target read", {
      namespace: ref.name,
      hubs: hubRead.ok ? hubRead.listing.kind : hubRead.failure.kind,
      rules: ruleRead.ok ? ruleRead.listing.kind : ruleRead.failure.kind,
    });
  }

  function applyPastedId(): void {
    const text = pasted.trim();
    const hub = parseEventHubResourceId(text);
    const ns = hub === null ? parseNamespaceResourceId(text) : hub.namespace;
    if (ns === null) {
      setPasteError(
        "That is not an Event Hub namespace or Event Hub resource id. It should look like /subscriptions/.../resourceGroups/.../providers/Microsoft.EventHub/namespaces/name.",
      );
      return;
    }
    setPasteError("");
    void chooseNamespace(ns, hub?.hubName ?? "");
  }

  const namespaceRows = namespaces !== null && namespaces.kind === "rows" ? namespaces.rows : [];
  const namespaceMessage: PickerMessage | null =
    namespaceError !== ""
      ? { tone: "error", text: namespaceError }
      : namespaces === null
        ? null
        : namespaceListMessage(namespaces);
  const hubRows = hubs !== null && hubs.ok && hubs.listing.kind === "rows" ? hubs.listing.rows : [];
  const ruleChoices = rules === null ? [] : sendableRules(rules);
  const chosenKey = value.namespace === null ? "" : namespaceKey(value.namespace);
  // A pasted hub may not be in the first page of hubs; keep it selectable.
  // One a complete listing proved absent was already cleared from the value.
  const hubOptions =
    value.hubName !== "" && !hubRows.some((h) => h.name === value.hubName)
      ? [value.hubName, ...hubRows.map((h) => h.name)]
      : hubRows.map((h) => h.name);
  const chosenRuleNote = value.rule === null ? null : ruleNote(value.rule);

  return (
    <NumberedSection
      number={number}
      title="Event Hub the sources send to"
      status="available"
      infoTip={SECTION_TIP}
      summary={value.namespace === null ? "" : `${value.namespace.name}/${value.hubName}`}
    >
      <div className="azure-onboarding-block">
        <div className="panel-controls">
          <button
            type="button"
            className="run-button"
            onClick={() => void findNamespaces()}
            disabled={finding || subscriptionId === ""}
          >
            {finding ? "Finding namespaces..." : "Find namespaces"}
          </button>
          {subscriptionId === "" && (
            <span className="field-hint">Configure a subscription in Settings first.</span>
          )}
        </div>
        {namespaceMessage !== null && <PickerLine message={namespaceMessage} />}

        <div className="form-grid">
          <label className="field">
            <span className="field-label">Namespace</span>
            <select
              aria-label="Event Hub namespace"
              value={namespaceRows.some((n) => namespaceKey(n) === chosenKey) ? chosenKey : ""}
              disabled={namespaceRows.length === 0}
              onChange={(e) => {
                const ns = namespaceRows.find((n) => namespaceKey(n) === e.target.value);
                if (ns !== undefined) void chooseNamespace(ns);
              }}
            >
              <option value="">Choose a namespace</option>
              {namespaceRows.map((ns) => (
                <option key={namespaceKey(ns)} value={namespaceKey(ns)}>
                  {`${ns.name} (${ns.resourceGroup}${ns.skuName !== "" ? `, ${ns.skuName}` : ""})`}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field-label">Or paste a namespace or Event Hub resource id</span>
            <input
              aria-label="Namespace or Event Hub resource id"
              value={pasted}
              placeholder="/subscriptions/.../providers/Microsoft.EventHub/namespaces/name"
              onChange={(e) => setPasted(e.target.value)}
            />
          </label>
          <div className="panel-controls">
            <button
              type="button"
              className="run-button"
              onClick={applyPastedId}
              disabled={pasted.trim() === ""}
            >
              Use this id
            </button>
          </div>
          {pasteError !== "" && <PickerLine message={{ tone: "error", text: pasteError }} />}

          {value.namespace !== null && (
            <p className="field-hint">
              {`Namespace ${value.namespace.name} in resource group ${value.namespace.resourceGroup}, subscription ${value.namespace.subscriptionId}.`}
            </p>
          )}
          {loadingTarget && <p className="field-hint">Reading hubs and authorization rules...</p>}

          <label className="field">
            <span className="field-label">Event Hub</span>
            <select
              aria-label="Event Hub"
              value={value.hubName}
              disabled={value.namespace === null || hubOptions.length === 0}
              onChange={(e) => {
                setMissingHub("");
                onChange({ ...value, hubName: e.target.value });
              }}
            >
              <option value="">Choose an Event Hub</option>
              {hubOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          {missingHub !== "" && value.namespace !== null && (
            <PickerLine
              message={{
                tone: "warning",
                text: `Event Hub ${missingHub} was not found in namespace ${value.namespace.name}. Choose an existing Event Hub.`,
              }}
            />
          )}
          {hubs !== null && hubListMessage(hubs) !== null && (
            <PickerLine message={hubListMessage(hubs) as PickerMessage} />
          )}

          <label className="field">
            <span className="field-label">Namespace authorization rule</span>
            <select
              aria-label="Authorization rule"
              value={value.rule?.name ?? ""}
              disabled={ruleChoices.length === 0}
              onChange={(e) =>
                onChange({
                  ...value,
                  rule: ruleChoices.find((r) => r.name === e.target.value) ?? null,
                })
              }
            >
              <option value="">Choose a rule that can send</option>
              {ruleChoices.map((rule) => (
                <option key={rule.name} value={rule.name}>
                  {`${rule.name} (${rule.rights.join(", ")})`}
                </option>
              ))}
            </select>
          </label>
          {rules !== null && ruleListMessage(rules) !== null && (
            <PickerLine message={ruleListMessage(rules) as PickerMessage} />
          )}
          {value.rule !== null && (
            <p className="field-hint">{`Rights: ${value.rule.rights.join(", ")}`}</p>
          )}
          {chosenRuleNote !== null && (
            <PickerLine message={{ tone: "warning", text: chosenRuleNote }} />
          )}
        </div>

        <div className="panel-controls">
          <button type="button" className="run-button" disabled>
            Create namespace
          </button>
          <button type="button" className="run-button" disabled>
            Create Event Hub
          </button>
          <button type="button" className="run-button" disabled>
            Create Send-only rule
          </button>
        </div>
        <p className="field-hint">{CREATE_NOT_AVAILABLE}</p>
      </div>
    </NumberedSection>
  );
}

/**
 * True only when a COMPLETE hub listing (2xx, no nextLink, measured) lacks
 * `hubName`. A truncated, unmeasured (`empty`) or failed read proves nothing.
 */
function hubProvedAbsent(read: EventHubTargetRead<EventHubInfo>, hubName: string): boolean {
  if (!read.ok || read.truncated) return false;
  if (read.listing.kind === "none") return true;
  if (read.listing.kind === "rows") return !read.listing.rows.some((h) => h.name === hubName);
  return false;
}

/** One worded state line, toned. Shared with the other azure-onboarding sections. */
export function PickerLine({ message }: { message: PickerMessage }) {
  return (
    <p
      className={`azure-onboarding-banner azure-onboarding-banner-${message.tone}`}
      role={message.tone === "error" ? "alert" : undefined}
    >
      {message.text}
    </p>
  );
}
