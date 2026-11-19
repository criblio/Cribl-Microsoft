/**
 * Azure onboarding state - the PURE decisions behind the Azure Native Source
 * Onboarding screen (AZR-18), kept out of the component so each one is
 * unit-testable without a DOM. The screen (azure-onboarding-screen.tsx) is a
 * thin composer over these:
 *
 *   - {@link loadStateFrom}: what the KV read of the saved selection means, in
 *     six states, and {@link canWriteSelection}: when a choice may be written.
 *     A read that FAILED is not a first run (claude-kit
 *     standards/cribl-kv-store.md): only an `absent` load or a readable
 *     document of ours may ever be overwritten, so `read-unknown`,
 *     `doc-foreign` and `doc-unreadable` block every write outright. An
 *     `absent` load shows the defaults and writes nothing until the operator
 *     changes a choice (ADR 0007 section 2: the choice saves at once; there
 *     is no separate Save).
 *   - {@link loadBanners}: what the load has to say out loud - ids the decode
 *     dropped, defaults in use, and the three blocked states.
 *   - {@link buildSections}: the catalog layout from core (onboarding-sections)
 *     with a label per row. The rows are STATUS ONLY: whether a source is
 *     chosen and how is the chooser's own answer (a {@link RowChoice} per id,
 *     from howto-state rowChoices over isChosen/effectiveMode), never read
 *     from the selection directly, so the two places cannot disagree. A row
 *     whose deployment state could not be READ takes the `unknown` overlay's label ahead of {@link itemState}'s, because
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
 *   - {@link criblSideReadingOf}: the "Read Cribl side" result in the lane
 *     builder's shape, keeping a bare-id route's unconfirmed flag.
 *   - {@link measuredHubsOf}: the last Validate's hub list for the lane
 *     builder, keeping a complete listing of NO hubs apart from no listing.
 *
 * VISIBLE COPY. Every string these functions return reaches the screen, so
 * none carries a card id, a date or a phase number; the test runs
 * findHistoryInCopy over all of them and over core's ITEM_AVAILABILITY reasons.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto.
 */

import {
  AUTO_HUB_SOURCE_IDS,
  DEFAULT_NAMESPACE_RULE,
  DEFENDER_EXPORT_NAME,
  onboardingSource,
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
} from "@soc/core";
import type {
  CollectionMethod,
  CriblSideReading,
  CoverageSelection,
  DecodedSelection,
  DefenderDeployOutcome,
  DefenderDeployStep,
  DefenderPlansState,
  DefenderState,
  OnboardingCriblSide,
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
  SourceMode,
  ValidationResult,
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
 *   absent          nothing of ours is stored; the defaults are shown and a
 *                   choice may write (it is a first run, measured)
 *   ready           a readable document of ours; a choice may replace it
 *   read-unknown    the read FAILED (403, 5xx, timeout). The document may
 *                   exist, so writes are blocked until a load succeeds
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
 * Whether a choice may write the selection. Only after an `absent` load or a
 * readable document of ours. Every other load state blocks it: overwriting
 * there would replace a document this release could not see.
 */
export function canWriteSelection(load: OnboardingLoadState): boolean {
  return load.status === "absent" || load.status === "ready";
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
            "Choosing a source the app deploys is turned off so a selection that may exist is not overwritten. Reload to try again.",
        },
      ];
    case "doc-foreign":
      return [
        {
          tone: "error",
          text:
            `The stored value under this key is not an onboarding selection (kind ${describeValue(load.kind)}). ` +
            "Choosing a source the app deploys is turned off so it is not overwritten.",
        },
      ];
    case "doc-unreadable":
      return [
        {
          tone: "error",
          text:
            `The saved selection was written in a format this version of the app cannot read (version ${describeValue(load.version)}). ` +
            "Choosing a source the app deploys is turned off so it is not overwritten.",
        },
      ];
    case "absent":
    case "ready": {
      const out: OnboardingBanner[] = [];
      if (load.decoded.usedDefaults) {
        out.push({
          tone: "info",
          text: "No saved selection was found, so the defaults are shown. Nothing is saved until you change a choice.",
        });
      }
      if (load.decoded.dropped.length > 0) {
        out.push({
          tone: "warning",
          text:
            "Some saved choices are no longer offered and were left out: " +
            `${load.decoded.dropped.join(", ")}. The next change saves the selection without them.`,
        });
      }
      return out;
    }
  }
}

/**
 * Choose or unchoose one item, keeping the selection otherwise as it was
 * (sub-selections included). Choosing an item that is not built yet is
 * refused (the selection is returned unchanged): its Automate option is
 * locked, and a selection must not gain a deploy the screen cannot make.
 * Unchoosing is always allowed and changes nothing in Azure - that is
 * onboarding-selection's additive-only contract.
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

/**
 * Why a document a choice depends on cannot be used, one word per load state
 * so the copy says what actually happened: still loading, a read that failed,
 * a value that is not ours, ours in a format this version cannot read, or a
 * build with no storage at all.
 */
export type ChoiceUnknownCause = "loading" | "not-read" | "not-ours" | "unreadable-format" | "no-storage";

/** The document a choice depends on: the selection (Automate) or the How-to progress (mode, How-to choice). */
export type ChoiceDocument = "selection" | "progress";

/**
 * Whether one source is chosen, and how, as the chooser answers it (howto-state
 * rowChoices). `unknown` when the answer depends on a document that cannot be
 * used yet, with which one and why: never shown as "not chosen".
 */
export type RowChoice =
  | { readonly kind: "chosen"; readonly mode: SourceMode }
  | { readonly kind: "not-chosen" }
  | { readonly kind: "unknown"; readonly doc: ChoiceDocument; readonly cause: ChoiceUnknownCause };

/** The words a method-section row shows for a known {@link RowChoice}. */
export const CHOICE_LABELS = {
  automate: "Chosen - Automate",
  manual: "Chosen - How-to",
  notChosen: "Not chosen",
} as const;

const DOC_NOUN: Readonly<Record<ChoiceDocument, string>> = {
  selection: "selection",
  progress: "How-to progress",
};

/** Why `doc` cannot be used, as a clause ("the saved selection could not be read"). */
export function unknownReason(doc: ChoiceDocument, cause: ChoiceUnknownCause): string {
  const noun = DOC_NOUN[doc];
  switch (cause) {
    case "loading":
      return `the saved ${noun} is still loading`;
    case "not-read":
      return `the saved ${noun} could not be read`;
    case "not-ours":
      return `the stored ${noun} was not written by this app`;
    case "unreadable-format":
      return `the saved ${noun} is in a format this version cannot read`;
    case "no-storage":
      return `this build of the app has no storage for the ${noun}`;
  }
}

/**
 * The visible words for one {@link RowChoice}. The chooser shows the same
 * words for an unknown choice, so the two places agree.
 */
export function choiceLabel(choice: RowChoice): string {
  switch (choice.kind) {
    case "chosen":
      return choice.mode === "automate" ? CHOICE_LABELS.automate : CHOICE_LABELS.manual;
    case "not-chosen":
      return CHOICE_LABELS.notChosen;
    case "unknown":
      return `${choice.cause === "loading" ? "Choice not loaded yet" : "Choice not known"} - ${unknownReason(choice.doc, choice.cause)}.`;
  }
}

/**
 * Why the selection cannot be used, or null when it is loaded (`absent` or
 * ours). `hasStore` false means the shell wired no store: no storage, not a
 * failed read.
 */
export function selectionUnknownCause(load: OnboardingLoadState, hasStore: boolean): ChoiceUnknownCause | null {
  if (!hasStore) return "no-storage";
  switch (load.status) {
    case "absent":
    case "ready":
      return null;
    case "loading":
      return "loading";
    case "read-unknown":
      return "not-read";
    case "doc-foreign":
      return "not-ours";
    case "doc-unreadable":
      return "unreadable-format";
  }
}

/**
 * Why Deploy is off for a source with this choice, or null when the source is
 * chosen in Automate mode. Both deploy sections gate on this (and never on the
 * selection directly), so a stale selection entry for a How-to source, or a
 * choice the screen cannot read, never deploys.
 */
export function choiceDeployBlock(choice: RowChoice, noun: string): string | null {
  switch (choice.kind) {
    case "unknown":
      return `${choiceLabel(choice)} Deploy is off until it is known.`;
    case "not-chosen":
      return `Choose the ${noun} under Choose what to onboard to deploy it.`;
    case "chosen":
      return choice.mode === "automate" ? null : `The ${noun} is set to How-to, so the app does not deploy it.`;
  }
}

/**
 * The note shown in place of a deployable source's controls while it is
 * chosen in How-to mode. It names the source (AZR-109): Direct configuration
 * holds two deployable sources, and an unattributed note under each read as
 * one note shown twice.
 */
export function howtoDeployNote(title: string): string {
  return `The ${title} is set to How-to, so the app does not deploy it. Follow its steps under How to set it up yourself, or switch it back to Automate under Choose what to onboard.`;
}

/**
 * What a deployable source's block in its method section shows (AZR-109):
 *
 *   deploy      its deploy section, which gates Deploy on the choice itself
 *               (Automate, not chosen, or a choice that is unknown)
 *   howto-note  the source is CHOSEN in How-to mode: the named note instead
 *               (or in How-to mode with its choice unknown)
 *   none        the source is in How-to mode and NOT chosen: nothing. The
 *               row above already says "Not chosen"; a note telling the
 *               operator to follow steps for a source they did not choose,
 *               or deploy controls a choice in How-to mode could never enable,
 *               would both mislead.
 *
 * `howTo` is the source's effective mode as the progress document holds it;
 * false while progress is not loaded, so an unknown choice keeps its deploy
 * section and that section says why Deploy is off.
 */
export type DeployBlockView =
  | { readonly kind: "deploy" }
  | { readonly kind: "howto-note"; readonly text: string }
  | { readonly kind: "none" };

export function deployBlockView(choice: RowChoice, howTo: boolean, title: string): DeployBlockView {
  if (choice.kind === "chosen" && choice.mode === "manual") return { kind: "howto-note", text: howtoDeployNote(title) };
  if (howTo && choice.kind === "not-chosen") return { kind: "none" };
  // In How-to mode with the choice unknown: the app does not deploy it either
  // way, so the named note, never deploy controls. rowChoices does not produce
  // this pair today (a How-to choice is read from progress, which howTo needs
  // loaded); held here so a future source of "unknown" cannot reopen Deploy.
  if (howTo && choice.kind === "unknown") return { kind: "howto-note", text: howtoDeployNote(title) };
  return { kind: "deploy" };
}

/** Used for an item id the chooser has no answer for. */
const NO_CHOICE: RowChoice = { kind: "unknown", doc: "progress", cause: "not-read" };

/**
 * One row as the screen renders it. No row has a control: a source is chosen
 * in the chooser only, and its method-section row says what was chosen.
 */
export type OnboardingRowView =
  | {
      readonly kind: "item";
      readonly id: OnboardingItemId;
      readonly title: string;
      readonly description: string;
      readonly availability: ItemAvailability;
      /** The chooser's answer for this source. */
      readonly choice: RowChoice;
      readonly choiceLabel: string;
      /** itemState's answer, `unknown` when the overlay names this row, `unread` before any read. */
      readonly state: ItemState | "unknown" | "unread";
      readonly label: string;
    }
  | {
      readonly kind: "unsupported";
      readonly id: string;
      readonly title: string;
      readonly description: string;
      /** Its status, {@link UNSUPPORTED_LABEL}: shown as a state like every other row's, never silence. */
      readonly label: string;
      /** What to do instead: the catalog's operator-facing `instead` (AZR-43), never the legacy `alternative`. */
      readonly instead: string;
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

/**
 * The four itemState labels for a BUILT item whose state was read. They say
 * only what is deployed; whether the source is chosen is the row's choice
 * label, so the two never repeat or contradict each other.
 */
export const STATE_LABELS: Readonly<Record<ItemState, string>> = {
  unselected: "Not deployed",
  pending: "Not deployed yet",
  deployed: "Deployed",
  "deployed-unselected":
    "Deployed - still running in Azure. Unchoosing does not remove it; Remove is a separate action.",
};

/** A not-built item's label: nothing reads its deployment. */
export const NOT_AVAILABLE_LABEL = "Not available yet";

/**
 * A source that cannot stream to an Event Hub at all (backlog.md#6e, AZR-8):
 * a visible unavailable row with its reason, so an operator who looks for flow
 * logs finds them and why, instead of concluding the tool missed them. True of
 * every UNSUPPORTED_SOURCES entry - that block IS "no Event Hub path".
 */
export const UNSUPPORTED_LABEL = "Unavailable through an Event Hub";

/** The prefix of the overlay label; the reason follows it. */
export const STATE_UNREADABLE_PREFIX = "Deployment state could not be read";

/** A built item before any read: no claim either way. */
const UNREAD_LABEL = "Deployment state not read yet";

/**
 * What the screen's reads found, per deployable source: which items were READ
 * (`read`, null meaning every built item) and which of those are deployed. The
 * Defender export and the Activity Log are read by separate buttons, so one
 * having been read says nothing about the other.
 */
export interface DeployedReads {
  readonly read: ReadonlySet<OnboardingItemId> | null;
  readonly deployed: readonly OnboardingItemId[];
}

function isDeployedReads(value: readonly OnboardingItemId[] | DeployedReads): value is DeployedReads {
  return !Array.isArray(value);
}

/**
 * Combine per-source reads, each `[item, what its read found deployed]` with
 * null for a source not read yet. Null when nothing was read at all.
 */
export function deployedFrom(
  entries: readonly (readonly [OnboardingItemId, readonly OnboardingItemId[] | null])[],
): DeployedReads | null {
  const read = new Set<OnboardingItemId>();
  const deployed: OnboardingItemId[] = [];
  for (const [item, found] of entries) {
    if (found === null) continue;
    read.add(item);
    deployed.push(...found);
  }
  return read.size === 0 ? null : { read, deployed };
}

/**
 * The screen's sections, with a choice label and a deploy-state label per
 * item row.
 *
 * @param choices   the chooser's answer per item id (howto-state rowChoices).
 *                  An id missing from it reads as unknown, never as not chosen
 * @param deployed  what a read found deployed, or null when no read has been
 *                  attempted - a null is never shown as "not deployed". A
 *                  {@link DeployedReads} says which items were read: a built
 *                  item outside it is labelled unread, never "not deployed"
 * @param unknown   items whose read FAILED, with the reason. Takes precedence
 *                  over every other label for that row
 */
export function buildSections(
  choices: ReadonlyMap<OnboardingItemId, RowChoice>,
  deployedOrReads: readonly OnboardingItemId[] | DeployedReads | null,
  unknown: ReadonlyMap<OnboardingItemId, string>,
): OnboardingSectionView[] {
  const desired = [...choices].filter(([, c]) => c.kind === "chosen").map(([id]) => id);
  const reads: DeployedReads | null =
    deployedOrReads === null || isDeployedReads(deployedOrReads)
      ? deployedOrReads
      : { read: null, deployed: deployedOrReads };
  const deployed = reads === null ? null : reads.deployed;
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
          label: UNSUPPORTED_LABEL,
          instead: row.item.instead,
        };
      }
      if (row.kind === "xdr-tables") {
        return { kind: "xdr-tables", id: row.id, title: row.title, tables: row.tables, reason: row.reason };
      }
      const availability = itemAvailability(row.id);
      const choice = choices.get(row.id) ?? NO_CHOICE;
      const base = {
        kind: "item" as const,
        id: row.id,
        title: row.item.title,
        description: row.item.description,
        availability,
        choice,
        choiceLabel: choiceLabel(choice),
      };
      const reason = unknown.get(row.id);
      if (reason !== undefined) {
        return { ...base, state: "unknown", label: `${STATE_UNREADABLE_PREFIX} - ${reason}` };
      }
      if (availability.status === "not-built") {
        // Nothing reads a not-built item's deployment, so the label says only
        // that it cannot deploy yet; the choice label says whether it is chosen.
        const state = itemState(row.id, desired, deployed ?? []);
        return { ...base, state, label: NOT_AVAILABLE_LABEL };
      }
      if (deployed === null || (reads !== null && reads.read !== null && !reads.read.has(row.id))) {
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

/** Everything the deploy gate looks at. No capability set, on purpose. */
export interface DefenderDeployGate {
  /** A deploy is in flight. */
  readonly running: boolean;
  /** The source's choice as the chooser answers it (rowChoices). */
  readonly choice: RowChoice;
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
  const blocked = choiceDeployBlock(gate.choice, "Defender for Cloud alert export");
  if (blocked !== null) return blocked;
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
 * The namespace picker's line. An empty Resource Graph answer is the shared
 * unmeasured hedge, never a zero: `resourcegraph.read` (CAP-1) only proves the
 * query returns rows, and Resource Graph filters them by what the identity can
 * read, so no capability establishes that every namespace was visible.
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
 * The sources whose Azure object is a DIAGNOSTIC SETTING streaming through the
 * rule picked in the Event Hub section, so the rule must have Manage rights.
 * Microsoft documents it for every diagnostic setting with an Event Hub
 * destination: "Streaming to event hubs requires Manage, Send, and Listen
 * permissions" (learn.microsoft.com/azure/azure-monitor/data-collection/
 * diagnostic-settings, Destinations table). The Activity Log and Entra ID
 * deploy gates refuse a rule without Manage for that reason
 * (activity-log-state, entra-setting-state), and the two policy initiatives
 * deploy diagnostic settings of the same kind (their How-to step
 * eh-rule-diagnostic creates a Manage rule and checks it). The Defender
 * export is a continuous export, not a diagnostic setting, and writes with
 * Send.
 *
 * Derived from the catalog, never retyped: these are exactly the Event Hub
 * sources whose hubs Azure creates itself (core's AUTO_HUB_SOURCE_IDS), the
 * same list the How-to guide's Manage-rule step is shown for, so a new
 * auto-hub source cannot get one answer from the guide and another here.
 */
export const MANAGE_RULE_SOURCE_IDS: readonly OnboardingItemId[] = AUTO_HUB_SOURCE_IDS;

/**
 * The titles of the CHOSEN sources that need a Manage rule, in
 * {@link MANAGE_RULE_SOURCE_IDS} order. Chosen in either mode: a How-to
 * operator creates the same diagnostic setting by hand, and Azure asks the
 * same of the rule.
 */
export function sourcesNeedingManageRule(chosen: readonly string[]): string[] {
  return MANAGE_RULE_SOURCE_IDS.filter((id) => chosen.includes(id)).map(
    (id) => onboardingSource(id)?.title ?? id,
  );
}

/**
 * What the rule note is told about the chosen sources, from the chooser's
 * answer per source ({@link RowChoice}, the same map the method sections
 * read): the titles of the chosen Manage sources, or NULL while any Manage
 * source's choice is unknown. Unknown covers BOTH documents: the progress
 * document (every row), and the coverage selection for a Manage source in
 * Automate mode - the Activity Log and Entra ID default to Automate, so an
 * unread selection is not "none chosen" and must not earn Send-only advice.
 * A missing row is unknown too (the screen's own fallback is unknown).
 */
export function manageRuleSourcesOf(choices: ReadonlyMap<string, RowChoice>): string[] | null {
  const chosen: string[] = [];
  for (const id of MANAGE_RULE_SOURCE_IDS) {
    const choice = choices.get(id);
    if (choice === undefined || choice.kind === "unknown") return null;
    if (choice.kind === "chosen") chosen.push(id);
  }
  return sourcesNeedingManageRule(chosen);
}

/** "a", "a and b", "a, b and c". */
function listed(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1] ?? ""}`;
}

const MANAGE_RULE_WHY =
  "a diagnostic setting streams to an Event Hub only through a rule with Manage, Send and Listen rights";

/**
 * The note while WHICH sources are chosen is not known (the progress document
 * is loading, could not be read, or there is no store): it recommends neither
 * kind of rule, because either recommendation could be the one a chosen
 * source's deploy refuses.
 */
export const RULE_NOTE_SOURCES_UNKNOWN =
  "Which sources are chosen is not known yet, so this note cannot say which rule they need. " +
  "A source that streams through a diagnostic setting needs a rule with Manage rights; " +
  "the Defender for Cloud alert export alone does not.";

/**
 * The advice for the namespace's built-in rule when a chosen source needs
 * Manage: a dedicated rule with the same rights (the How-to step
 * eh-rule-diagnostic's wording), never Send-only.
 */
function builtInRuleAdvice(name: string): string {
  return (
    `${name} is the namespace's built-in rule. Use a dedicated rule with Manage, Send and Listen rights instead, ` +
    "so it can be rotated or removed on its own."
  );
}

/**
 * A note beside a chosen rule, or null. PER SOURCE, so it never recommends a
 * rule a chosen source's own deploy refuses:
 *
 *   - a chosen source needs Manage (`manageSources` non-empty): a rule without
 *     Manage is warned about in the same terms as that source's deploy gate,
 *     and a rule with Manage is said to be what it needs - never "Send-only is
 *     safer". The namespace's built-in rule is still warned about by name,
 *     with a dedicated Manage, Send and Listen rule as the advice;
 *   - which sources are chosen is NOT KNOWN (`manageSources` null): a
 *     neutral note, RULE_NOTE_SOURCES_UNKNOWN, for any rule - never "Send-only
 *     is safer", which a chosen Manage source would refuse;
 *   - otherwise (the Defender export alone, or nothing chosen yet): a rule
 *     with Manage rights (including the namespace's built-in rule, noted by
 *     name) works, but a dedicated Send-only rule is safer.
 *
 * Never preselected; the operator picks the rule knowingly.
 */
export function ruleNote(
  rule: { readonly name: string; readonly rights: readonly string[] },
  manageSources: readonly string[] | null = [],
): PickerMessage | null {
  if (manageSources === null) return { tone: "info", text: RULE_NOTE_SOURCES_UNKNOWN };
  const manages = rule.rights.some((r) => r.toLowerCase() === "manage");
  if (manageSources.length > 0) {
    const who = listed(manageSources);
    const verb = manageSources.length === 1 ? "needs" : "need";
    if (!manages) {
      const rights = rule.rights.length > 0 ? rule.rights.join(", ") : "no rights";
      return {
        tone: "warning",
        text:
          `The rule ${rule.name} has ${rights}. ${who} ${verb} a rule with Manage rights, because ${MANAGE_RULE_WHY}. ` +
          "Choose a rule with Manage rights.",
      };
    }
    const enough = `${who} ${verb} a rule with Manage rights, as this one has, because ${MANAGE_RULE_WHY}.`;
    // The built-in rule has the rights but is still named: the How-to step
    // eh-rule-diagnostic says to use a dedicated rule, not this one.
    if (rule.name === DEFAULT_NAMESPACE_RULE) {
      return { tone: "warning", text: `${enough} ${builtInRuleAdvice(rule.name)}` };
    }
    return { tone: "info", text: enough };
  }
  if (!manages && rule.name !== DEFAULT_NAMESPACE_RULE) return null;
  return {
    tone: "warning",
    text: "This rule can also manage the namespace. A dedicated rule with only Send rights is safer.",
  };
}

/**
 * The label of the (not yet available) create-rule button: the kind of rule
 * the chosen sources need, so it never offers what a chosen source refuses.
 * Null (which sources are chosen is not known) names no kind.
 */
export function createRuleLabel(manageSources: readonly string[] | null): string {
  if (manageSources === null) return "Create authorization rule";
  return manageSources.length > 0 ? "Create Manage rule" : "Create Send-only rule";
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

/**
 * The hubs the last Validate measured, for laneTopics and planCriblSource:
 * null when no Validate ran or no COMPLETE hub listing was read (core's
 * measuredHubs is null for a denied, truncated or nameless-row listing), and
 * an empty array when the namespace was read in full and holds no hubs - a
 * measured empty, which laneTopics refuses as `no-hub-measured`, not as
 * `hubs-not-measured`.
 */
export function measuredHubsOf(result: ValidationResult | null): readonly string[] | null {
  return result === null ? null : result.measuredHubs;
}

/**
 * The Cribl-side read in the shape the lane builder takes, keyed by input id.
 * A QuickConnect input is drawn as consumed by QuickConnect, because the lane
 * vocabulary has no separate word for it. A bare-id route keeps its
 * `legacyBareMatch` flag so the lane never reads it as confirmed (DBT-162).
 */
export function criblSideReadingOf(side: OnboardingCriblSide): CriblSideReading {
  const inputs: Record<string, CriblSideReading["inputs"][string]> = {};
  const routes: Record<string, CriblSideReading["routes"][string]> = {};
  for (const entry of side.inputs) {
    const p = entry.input;
    inputs[entry.inputId] =
      p.kind === "present" ? { kind: "present" } : p.kind === "absent" ? { kind: "absent" } : { kind: "unknown", detail: p.detail };
    const r = entry.route;
    switch (r.kind) {
      case "consumes": {
        const last = r.routes[r.routes.length - 1];
        routes[entry.inputId] =
          last === undefined
            ? { kind: "unknown", detail: "the route walk returned no route" }
            : {
                kind: "consumes",
                route: last.name,
                destination: last.output ?? null,
                ...(last.legacyBareMatch === true ? { legacyBareMatch: true as const } : {}),
              };
        break;
      }
      case "quickconnect":
        routes[entry.inputId] = {
          kind: "consumes",
          route: "QuickConnect",
          destination: r.connections.map((c) => c.output).join(", ") || null,
        };
        break;
      case "not-routed":
        routes[entry.inputId] = { kind: "not-routed" };
        break;
      case "cannot-evaluate":
        routes[entry.inputId] = { kind: "cannot-evaluate", route: r.routeId, detail: r.filter };
        break;
      case "unknown":
        routes[entry.inputId] = { kind: "unknown", detail: r.detail };
        break;
    }
  }
  return { inputs, routes };
}
