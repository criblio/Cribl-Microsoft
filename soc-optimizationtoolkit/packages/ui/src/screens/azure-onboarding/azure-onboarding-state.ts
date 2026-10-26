/**
 * Azure onboarding state - the PURE decisions behind the Azure Native Source
 * Onboarding screen (AZR-18), kept out of the component so each one is
 * unit-testable without a DOM. The screen (azure-onboarding-screen.tsx) is a
 * thin composer over these:
 *
 *   - {@link loadStateFrom}: what the KV read of the saved selection means, in
 *     six states, and {@link canSave}: when Save may write. A read that FAILED
 *     is not a first run (claude-kit standards/cribl-kv-store.md): only an
 *     `absent` load or a readable document of ours may ever be overwritten, so
 *     `read-unknown`, `doc-foreign` and `doc-unreadable` block Save outright.
 *     Save is explicit - an `absent` load shows the defaults but is not dirty,
 *     so nothing is written until the operator asks.
 *   - {@link loadBanners}: what the load has to say out loud - ids the decode
 *     dropped, defaults in use, and the three blocked states.
 *   - {@link buildSections}: the catalog layout from core (onboarding-sections)
 *     with a label per row. A row whose deployment state could not be READ
 *     takes the `unknown` overlay's label ahead of {@link itemState}'s, because
 *     itemState has only four states and with `deployed: []` it would turn a
 *     failed measurement into "will be deployed" or "Not selected" - the
 *     confident negative this screen exists not to show. A `deployed` of null
 *     means no read has been attempted yet and gets its own label for the same
 *     reason.
 *   - {@link defenderDeployDisabledReason}: why Deploy is disabled, as ONE
 *     reason in a fixed priority. Every reason is a missing input or a refusal
 *     the deploy usecase would also make; a capability verdict never appears,
 *     because no capability measures these actions yet (the required actions
 *     render as "needed, not yet measured" instead).
 *   - {@link defenderStateNote}: the one Defender read that is deployable but
 *     NOT a measured negative - an automations list that came back empty. A
 *     fresh subscription returns exactly that, so Deploy stays enabled, but an
 *     empty raw ARM list cannot be told apart from one filtered by access
 *     (inventory-listing), so the screen says the absence is unconfirmed.
 *   - {@link planSummary}: the Defender plans read. Only a `read` with no
 *     Standard pricing at all - known OR unrecognised ({@link anyStandard}) -
 *     may say that no paid plan is enabled; denied, unregistered and failed say
 *     the plans are unknown. With zero plans the deploy stays ALLOWED with a
 *     warning carrying legacy's portal steps: a recorded departure from legacy,
 *     which refused (Deploy-DefenderExport.ps1:371-380). The default is the one
 *     constant {@link ZERO_PLANS_DEPLOY_ALLOWED}.
 *   - {@link namespaceListMessage} / {@link hubListMessage} /
 *     {@link ruleListMessage}: the Event Hub pickers' empty and failed states.
 *     The wording comes from capabilities/empty-inventory.ts and is never
 *     written here - those lists have no capability, so an empty answer is
 *     unmeasuredInventoryMessage, and a structurally verified `none` (no
 *     reader mints one today) is verifiedNoneInventoryMessage.
 *   - {@link deployOutcomeMessage}: the deploy's outcome in Azure's words. A
 *     success says delivery is not verified until an alert arrives, because the
 *     read-back proves the export's shape, not that anything flows through it.
 *
 * VISIBLE COPY. Every string these functions return reaches the screen, so
 * none carries a card id, a date or a phase number; the test runs
 * findHistoryInCopy over all of them and over core's ITEM_AVAILABILITY reasons.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto.
 */

import {
  DEFAULT_NAMESPACE_RULE,
  DEFENDER_EXPORT_NAME,
  ONBOARDING_SECTIONS,
  anyStandard,
  decodeSelection,
  eventHubResourceId,
  findSameTargetExports,
  itemAvailability,
  itemState,
  readCoverageDocument,
  ruleCanSend,
  sectionAvailability,
  selectedItemIds,
} from "@soc/core";
import type {
  CollectionMethod,
  CoverageSelection,
  DecodedSelection,
  DefenderDeployOutcome,
  DefenderDeployStep,
  DefenderPlansState,
  DefenderState,
  EventHubInfo,
  EventHubNamespaceInfo,
  EventHubTargetRead,
  EventHubTargetRule,
  ItemAvailability,
  ItemState,
  KvDocumentLoad,
  PricingsRead,
  Listing,
  NamespaceRef,
  OnboardingItemId,
  SectionAvailability,
} from "@soc/core";
import {
  unmeasuredInventoryMessage,
  verifiedNoneInventoryMessage,
} from "../../capabilities/empty-inventory";

// ---------------------------------------------------------------------------
// Load and save
// ---------------------------------------------------------------------------

/**
 * What the saved selection's KV read means. Six states, never collapsed:
 *
 *   loading         the read has not answered yet
 *   absent          nothing of ours is stored; the defaults are shown and Save
 *                   may write (it is a first run, measured)
 *   ready           a readable document of ours; Save may replace it
 *   read-unknown    the read FAILED (403, 5xx, timeout). The document may
 *                   exist, so Save is blocked until a load succeeds
 *   doc-foreign     the key holds something whose `kind` is not ours
 *   doc-unreadable  ours, but a `version` this release cannot read
 */
export type OnboardingLoadState =
  | { readonly status: "loading" }
  | { readonly status: "absent"; readonly decoded: DecodedSelection }
  | { readonly status: "ready"; readonly decoded: DecodedSelection }
  | { readonly status: "read-unknown"; readonly reason: string }
  | { readonly status: "doc-foreign"; readonly kind: unknown }
  | { readonly status: "doc-unreadable"; readonly version: unknown };

/**
 * Turn the port's three-way read into the screen's load state. An `absent`
 * load decodes to the DEFAULTS (`usedDefaults: true`), never to an empty
 * selection - empty would be a real choice the operator did not make.
 */
export function loadStateFrom(load: KvDocumentLoad): OnboardingLoadState {
  if (load.kind === "unknown") return { status: "read-unknown", reason: load.reason };
  if (load.kind === "absent") return { status: "absent", decoded: decodeSelection(undefined) };
  const doc = readCoverageDocument(load.value);
  if (doc.status === "foreign") return { status: "doc-foreign", kind: doc.kind };
  if (doc.status === "unreadable") return { status: "doc-unreadable", version: doc.version };
  return { status: "ready", decoded: doc.decoded };
}

/** The selection the screen may show and edit, or null when none was loaded. */
export function loadedSelection(load: OnboardingLoadState): CoverageSelection | null {
  return load.status === "absent" || load.status === "ready" ? load.decoded.selection : null;
}

/**
 * Whether Save may write. Only after an `absent` load or a readable document of
 * ours, only when the operator changed something, and never while a save is in
 * flight. Every other load state blocks it: overwriting there would replace a
 * document this release could not see.
 */
export function canSave(
  load: OnboardingLoadState,
  edit: { readonly dirty: boolean; readonly saving: boolean },
): boolean {
  if (load.status !== "absent" && load.status !== "ready") return false;
  return edit.dirty && !edit.saving;
}

/** A line the screen renders above the sections. */
export interface OnboardingBanner {
  readonly tone: "info" | "warning" | "error";
  readonly text: string;
}

function describeValue(value: unknown): string {
  if (value === undefined) return "none";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** What the load has to say. Empty while loading and for a clean, readable document. */
export function loadBanners(load: OnboardingLoadState): OnboardingBanner[] {
  switch (load.status) {
    case "loading":
      return [];
    case "read-unknown":
      return [
        {
          tone: "error",
          text:
            `The saved selection could not be read - ${load.reason}. ` +
            "Saving is turned off so a selection that may exist is not overwritten. Reload to try again.",
        },
      ];
    case "doc-foreign":
      return [
        {
          tone: "error",
          text:
            `The stored value under this key is not an onboarding selection (kind ${describeValue(load.kind)}). ` +
            "Saving is turned off so it is not overwritten.",
        },
      ];
    case "doc-unreadable":
      return [
        {
          tone: "error",
          text:
            `The saved selection was written in a format this version of the app cannot read (version ${describeValue(load.version)}). ` +
            "Saving is turned off so it is not overwritten.",
        },
      ];
    case "absent":
    case "ready": {
      const out: OnboardingBanner[] = [];
      if (load.decoded.usedDefaults) {
        out.push({
          tone: "info",
          text: "No saved selection was found, so the defaults are shown. Nothing is saved until you choose Save.",
        });
      }
      if (load.decoded.dropped.length > 0) {
        out.push({
          tone: "warning",
          text:
            "Some saved choices are no longer offered and were left out: " +
            `${load.decoded.dropped.join(", ")}. Saving will store the selection without them.`,
        });
      }
      return out;
    }
  }
}

/**
 * Tick or untick one item, keeping the selection otherwise as it was. Ticking
 * an item that is not built yet is refused (the selection is returned
 * unchanged): its checkbox is disabled, and a selection must not gain a deploy
 * the screen cannot make. Unticking is always allowed and changes nothing in
 * Azure - that is onboarding-selection's additive-only contract.
 */
export function withItem(
  selection: CoverageSelection,
  id: OnboardingItemId,
  ticked: boolean,
): CoverageSelection {
  const has = selection.enabled.includes(id);
  if (ticked === has) return selection;
  if (ticked) {
    if (itemAvailability(id).status !== "available") return selection;
    return { ...selection, enabled: [...selection.enabled, id] };
  }
  return { ...selection, enabled: selection.enabled.filter((x) => x !== id) };
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/** One row as the screen renders it. Only `item` rows have a checkbox. */
export type OnboardingRowView =
  | {
      readonly kind: "item";
      readonly id: OnboardingItemId;
      readonly title: string;
      readonly description: string;
      readonly availability: ItemAvailability;
      readonly selected: boolean;
      /** itemState's answer, `unknown` when the overlay names this row, `unread` before any read. */
      readonly state: ItemState | "unknown" | "unread";
      readonly label: string;
      /** False for a not-built item: its checkbox renders disabled. */
      readonly tickable: boolean;
    }
  | {
      readonly kind: "unsupported";
      readonly id: string;
      readonly title: string;
      readonly description: string;
      /** What to do instead (the legacy `alternative`). */
      readonly alternative: string;
    }
  | {
      readonly kind: "xdr-tables";
      readonly id: string;
      readonly title: string;
      readonly tables: readonly string[];
      readonly reason: string;
    };

export interface OnboardingSectionView {
  readonly key: CollectionMethod;
  readonly title: string;
  readonly availability: SectionAvailability;
  readonly rows: readonly OnboardingRowView[];
}

/** The four itemState labels for a BUILT item whose state was read. */
const STATE_LABELS: Readonly<Record<ItemState, string>> = {
  unselected: "Not selected",
  pending: "Selected - will be deployed",
  deployed: "Deployed",
  "deployed-unselected":
    "Not selected - still running in Azure. Unticking does not remove it; Remove is a separate action.",
};

/** The prefix of the overlay label; the reason follows it. */
export const STATE_UNREADABLE_PREFIX = "Deployment state could not be read";

/** A built item before any read: no claim either way. */
const UNREAD_LABEL = "Deployment state not read yet";

/**
 * The screen's sections, with a label per item row.
 *
 * @param selection the loaded selection, or null when none could be loaded
 *                  (every item then reads as unselected and untickable)
 * @param deployed  what a read found deployed, or null when no read has been
 *                  attempted - a null is never shown as "not deployed"
 * @param unknown   items whose read FAILED, with the reason. Takes precedence
 *                  over every other label for that row
 */
export function buildSections(
  selection: CoverageSelection | null,
  deployed: readonly OnboardingItemId[] | null,
  unknown: ReadonlyMap<OnboardingItemId, string>,
): OnboardingSectionView[] {
  const desired = selection === null ? [] : selectedItemIds(selection);
  return ONBOARDING_SECTIONS.map((section) => ({
    key: section.key,
    title: section.title,
    availability: sectionAvailability(section),
    rows: section.rows.map((row): OnboardingRowView => {
      if (row.kind === "unsupported") {
        return {
          kind: "unsupported",
          id: row.id,
          title: row.item.title,
          description: row.item.description,
          alternative: row.item.alternative,
        };
      }
      if (row.kind === "xdr-tables") {
        return { kind: "xdr-tables", id: row.id, title: row.title, tables: row.tables, reason: row.reason };
      }
      const availability = itemAvailability(row.id);
      const selected = desired.includes(row.id);
      const base = {
        kind: "item" as const,
        id: row.id,
        title: row.item.title,
        description: row.item.description,
        availability,
        selected,
        tickable: selection !== null && availability.status === "available",
      };
      const reason = unknown.get(row.id);
      if (reason !== undefined) {
        return { ...base, state: "unknown", label: `${STATE_UNREADABLE_PREFIX} - ${reason}` };
      }
      if (availability.status === "not-built") {
        // Nothing reads a not-built item's deployment, so the label says only
        // what is known: whether it is ticked, and that it cannot deploy yet.
        const state = itemState(row.id, desired, deployed ?? []);
        return {
          ...base,
          state,
          label: selected ? "Selected - not available yet" : "Not available yet",
        };
      }
      if (deployed === null) {
        return { ...base, state: "unread", label: UNREAD_LABEL };
      }
      const state = itemState(row.id, desired, deployed);
      return { ...base, state, label: STATE_LABELS[state] };
    }),
  }));
}

// ---------------------------------------------------------------------------
// Defender deploy gate
// ---------------------------------------------------------------------------

/**
 * Whether Deploy stays allowed when the plans read found NO paid plan. True is
 * the recorded departure from legacy (which refused): the free tier still
 * produces some alerts, and a plan read is a measurement, not a missing input.
 * Flipping this one value makes zero plans a disabled reason instead.
 */
export const ZERO_PLANS_DEPLOY_ALLOWED = true;

/** The Defender item's id in the coverage catalog. */
export const DEFENDER_ITEM_ID: OnboardingItemId = "defenderExport";

/** Everything the deploy gate looks at. No capability set, on purpose. */
export interface DefenderDeployGate {
  /** A deploy is in flight. */
  readonly running: boolean;
  /** The loaded selection, or null when none was loaded. */
  readonly selection: CoverageSelection | null;
  /** The last Defender state read, or null when none has been made. */
  readonly state: DefenderState | null;
  /** The chosen namespace, or null. */
  readonly namespace: NamespaceRef | null;
  /** The chosen hub's name, "" when none. */
  readonly hubName: string;
  /** The chosen namespace rule, or null. */
  readonly rule: { readonly name: string; readonly rights: readonly string[] } | null;
  /** The chosen existing resource group, "" when none. */
  readonly resourceGroup: string;
  /** Defaults to {@link ZERO_PLANS_DEPLOY_ALLOWED}; a parameter so both settings are testable. */
  readonly zeroPlansAllowed?: boolean;
}

/**
 * Why Deploy is disabled, or null when it may run. ONE reason, in this fixed
 * priority: running; selection not loaded; not ticked; already deployed; state
 * differs; possible duplicate; state unknown (or not read); no hub; no rule;
 * rule cannot send; no resource group. The deploy usecase re-checks the first
 * group itself after the confirm; this only keeps the button honest.
 */
export function defenderDeployDisabledReason(gate: DefenderDeployGate): string | null {
  if (gate.running) return "A deploy is already running.";
  if (gate.selection === null) {
    return "The saved selection has not loaded, so whether the alert export is ticked is not known.";
  }
  if (!selectedItemIds(gate.selection).includes(DEFENDER_ITEM_ID)) {
    return "Tick the Defender for Cloud alert export to deploy it.";
  }
  const state = gate.state;
  if (state !== null && state.ours.kind === "present-matching") {
    const rg = state.ours.automation.resourceGroup || "an unknown resource group";
    return `${DEFENDER_EXPORT_NAME} already exists in ${rg} - there is nothing to deploy.`;
  }
  if (state !== null && state.ours.kind === "present-differs") {
    return (
      `${DEFENDER_EXPORT_NAME} exists but differs from what this app writes: ` +
      `${state.ours.diffs.join(" ")} Repairing it from here is not available yet.`
    );
  }
  if (state !== null && state.automations.kind === "listed" && gate.namespace !== null && gate.hubName !== "") {
    const others = findSameTargetExports(
      state.automations.listing,
      eventHubResourceId(gate.namespace, gate.hubName),
    );
    if (others.length > 0) {
      return (
        "Another continuous export already sends to this Event Hub or its namespace: " +
        `${others.map((a) => a.name).join(", ")}. Deploying would deliver every alert twice.`
      );
    }
  }
  if (state === null) return "Read the Defender state first.";
  if (state.ours.kind === "unknown") {
    return `The Defender state could not be read - ${state.ours.reason}`;
  }
  if (
    !(gate.zeroPlansAllowed ?? ZERO_PLANS_DEPLOY_ALLOWED) &&
    state.plans.kind === "read" &&
    !anyStandard(state.plans.pricings)
  ) {
    return "No paid plan is enabled in Defender for Cloud on this subscription.";
  }
  if (gate.namespace === null || gate.hubName === "") return "Choose the Event Hub the alerts go to.";
  if (gate.rule === null) return "Choose the namespace authorization rule the export sends with.";
  if (!ruleCanSend(gate.rule.rights)) {
    const rights = gate.rule.rights.length > 0 ? gate.rule.rights.join(", ") : "no rights";
    return `The selected rule cannot send events - it has ${rights}.`;
  }
  if (gate.resourceGroup === "") return "Choose the existing resource group the export is created in.";
  return null;
}

/**
 * What the screen says when no existing export was found but that absence was
 * not measured: the subscription-wide automations list came back empty, which
 * an access-filtered list also does. Deploy stays enabled on purpose - an
 * empty list is the normal answer for a fresh subscription - so this is a
 * caveat beside the gate, not a reason inside it. The hedge itself is the
 * shared unmeasured wording, never phrased here.
 */
export const UNCONFIRMED_ABSENT_NOTE =
  `${unmeasuredInventoryMessage("continuous exports").text}, so the duplicate check had nothing to compare against.`;

/**
 * A caveat about the last Defender state read, or null when it has none. Only
 * an unmeasured `absent` has one; a measured absent (the list had rows, none
 * ours) and every present or unknown state already say what they mean.
 */
export function defenderStateNote(state: DefenderState | null): PickerMessage | null {
  if (state === null || state.ours.kind !== "absent" || state.ours.measured) return null;
  return { tone: "warning", text: UNCONFIRMED_ABSENT_NOTE };
}

// ---------------------------------------------------------------------------
// Defender plans
// ---------------------------------------------------------------------------

/** Shown beside the plans: the app reads plans and never changes them. */
export const NEVER_ENABLES_PLAN_NOTE =
  "This app only reads Defender plans. It never turns a plan on or changes a plan's tier.";

/** Legacy's portal steps, verbatim apart from the last (which re-ran the script). */
export const PLAN_ENABLEMENT_STEPS: readonly string[] = [
  "Go to Azure Portal > Microsoft Defender for Cloud",
  "Select Environment Settings > Your Subscription",
  "Enable desired Defender plans",
  "Read the Defender state again here",
];

/** One row of the plans table. */
export interface PlanRow {
  readonly name: string;
  readonly displayName: string;
  readonly tier: string;
  readonly status: string;
}

/** The plans read, summarised. `rows` is empty unless the plans were read. */
export interface PlanSummary {
  readonly tone: "ok" | "warning" | "error";
  readonly headline: string;
  readonly rows: readonly PlanRow[];
  /** Portal enablement steps; set only when the read found no paid plan. */
  readonly steps: readonly string[];
}

/**
 * Whether one unrecognised pricing is on the Standard tier. Asked of core's
 * {@link anyStandard} with a one-row read rather than re-implementing the tier
 * test, so the headline and every row's status come from the same decision.
 */
function unrecognizedIsStandard(p: PricingsRead["unrecognized"][number]): boolean {
  return anyStandard({ kind: "read", enabled: [], disabled: [], unrecognized: [p] });
}

/**
 * Summarise the plans. Only `read` carries plan lists, and only a read with no
 * Standard pricing anywhere (known or unrecognised) says no paid plan is on.
 */
export function planSummary(plans: DefenderPlansState): PlanSummary {
  if (plans.kind === "read") return readPlanSummary(plans.pricings);
  if (plans.kind === "denied") {
    return {
      tone: "error",
      headline:
        "Defender plans could not be read - Azure refused the request. Whether a paid plan is enabled is unknown. " +
        plans.message,
      rows: [],
      steps: [],
    };
  }
  if (plans.kind === "unregistered") {
    return {
      tone: "error",
      headline:
        "Defender plans could not be read - the Microsoft.Security resource provider is not registered on this subscription. " +
        "Whether a paid plan is enabled is unknown. " +
        plans.message,
      rows: [],
      steps: [],
    };
  }
  return {
    tone: "error",
    headline: `Defender plans could not be read. Whether a paid plan is enabled is unknown. ${plans.message}`,
    rows: [],
    steps: [],
  };
}

function readPlanSummary(read: PricingsRead): PlanSummary {
  const rows: PlanRow[] = [
    ...read.enabled.map((p) => ({ ...p, status: "Enabled" })),
    ...read.disabled.map((p) => ({ ...p, status: "Not enabled" })),
    ...read.unrecognized.map((p) => ({
      name: p.name,
      displayName: p.name,
      tier: p.tier,
      status: unrecognizedIsStandard(p) ? "Enabled, not in the known plan list" : "Not in the known plan list",
    })),
  ];
  if (anyStandard(read)) {
    const names = [
      ...read.enabled.map((p) => p.displayName),
      ...read.unrecognized.filter(unrecognizedIsStandard).map((p) => p.name),
    ];
    return { tone: "ok", headline: `Paid Defender plans enabled: ${names.join(", ")}.`, rows, steps: [] };
  }
  return {
    tone: "warning",
    headline: ZERO_PLANS_DEPLOY_ALLOWED
      ? "No paid plan is enabled in Defender for Cloud on this subscription, so few or no alerts may be exported. The export can still be created."
      : "No paid plan is enabled in Defender for Cloud on this subscription, so there are no alerts to export.",
    rows,
    steps: PLAN_ENABLEMENT_STEPS,
  };
}

// ---------------------------------------------------------------------------
// Event Hub pickers
// ---------------------------------------------------------------------------

/** A picker's state line: null when there are rows to choose from and nothing to add. */
export interface PickerMessage {
  readonly tone: "info" | "warning" | "error";
  readonly text: string;
}

/**
 * The namespace picker's line. The Resource Graph read has no capability, so
 * an empty answer is the shared unmeasured hedge, never a zero.
 */
export function namespaceListMessage(listing: Listing<EventHubNamespaceInfo>): PickerMessage | null {
  if (listing.kind === "rows") return null;
  if (listing.kind === "none") {
    return { tone: "info", text: verifiedNoneInventoryMessage("Event Hub namespaces").text };
  }
  return { tone: "warning", text: unmeasuredInventoryMessage("Event Hub namespaces").text };
}

const TRUNCATED_NOTE = "Only the first page was listed - Azure returned more.";

function targetReadMessage<T>(read: EventHubTargetRead<T>, noun: string): PickerMessage | null {
  if (!read.ok) return { tone: "error", text: read.failure.message };
  if (read.listing.kind === "empty") {
    return { tone: "warning", text: unmeasuredInventoryMessage(noun).text };
  }
  if (read.listing.kind === "none") {
    return { tone: "info", text: verifiedNoneInventoryMessage(noun).text };
  }
  return read.truncated ? { tone: "warning", text: TRUNCATED_NOTE } : null;
}

/** The hub picker's line. */
export function hubListMessage(read: EventHubTargetRead<EventHubInfo>): PickerMessage | null {
  return targetReadMessage(read, "Event Hubs");
}

/** The rules a picker may offer: only those that can Send. Empty when none were read. */
export function sendableRules(read: EventHubTargetRead<EventHubTargetRule>): EventHubTargetRule[] {
  if (!read.ok || read.listing.kind !== "rows") return [];
  return read.listing.rows.filter((r) => r.canSend);
}

/**
 * The rule picker's line. Rules exist but none can Send is its own message:
 * a Listen-only rule would let the deploy succeed while nothing is delivered.
 */
export function ruleListMessage(read: EventHubTargetRead<EventHubTargetRule>): PickerMessage | null {
  const base = targetReadMessage(read, "authorization rules");
  if (base !== null && base.text !== TRUNCATED_NOTE) return base;
  if (read.ok && read.listing.kind === "rows" && sendableRules(read).length === 0) {
    const names = read.listing.rows.map((r) => `${r.name} (${r.rights.join(", ") || "no rights"})`);
    // A truncated list was not read to the end, so a later page may hold a
    // Send rule: the claim narrows to the rules actually listed.
    const subject = read.truncated
      ? "None of the listed authorization rules"
      : "None of this namespace's authorization rules";
    const text = `${subject} can send events: ${names.join("; ")}.`;
    return { tone: "warning", text: read.truncated ? `${text} ${TRUNCATED_NOTE}` : text };
  }
  return base;
}

/**
 * A note beside a chosen rule, or null. A rule with Manage rights (including
 * the namespace's built-in rule) works, but a dedicated Send-only rule is
 * safer. It is never preselected; the operator picks it knowingly.
 */
export function ruleNote(rule: { readonly name: string; readonly rights: readonly string[] }): string | null {
  const manages = rule.rights.some((r) => r.toLowerCase() === "manage");
  if (!manages && rule.name !== DEFAULT_NAMESPACE_RULE) return null;
  return "This rule can also manage the namespace. A dedicated rule with only Send rights is safer.";
}

// ---------------------------------------------------------------------------
// Deploy outcome
// ---------------------------------------------------------------------------

/** The caveat every success carries. */
export const DELIVERY_NOT_VERIFIED =
  "Delivery is not verified until a Defender alert arrives in the Event Hub.";

/** The deploy outcome as the screen says it. */
export function deployOutcomeMessage(outcome: DefenderDeployOutcome): PickerMessage {
  switch (outcome.kind) {
    case "written-and-read-back":
      return {
        tone: "info",
        text: `${DEFENDER_EXPORT_NAME} was created and read back from Azure. ${DELIVERY_NOT_VERIFIED}`,
      };
    case "accepted-not-verified":
      return {
        tone: "warning",
        text:
          `Azure accepted ${DEFENDER_EXPORT_NAME}, but reading it back did not confirm it: ` +
          `${outcome.reasons.join(" ")} ${DELIVERY_NOT_VERIFIED}`,
      };
    case "already-exists":
      return {
        tone: "info",
        text: `Nothing was written: ${DEFENDER_EXPORT_NAME} already exists in ${outcome.resourceGroup || "an unknown resource group"}.`,
      };
    case "present-differs":
      return {
        tone: "warning",
        text: `Nothing was written: ${DEFENDER_EXPORT_NAME} exists but differs - ${outcome.diffs.join(" ")}`,
      };
    case "possible-duplicate":
      return {
        tone: "warning",
        text:
          "Nothing was written: another continuous export already sends to this Event Hub or its namespace: " +
          `${outcome.names.join(", ")}.`,
      };
    case "denied":
    case "unregistered":
    case "failed":
      return { tone: "error", text: `Deploy stopped at ${STEP_LABELS[outcome.step]}. ${outcome.message}` };
  }
}

const STEP_LABELS: Readonly<Record<DefenderDeployStep, string>> = {
  "automation-list": "listing the existing exports",
  "list-keys": "reading the rule's connection string",
  "automation-put": "creating the export",
};
