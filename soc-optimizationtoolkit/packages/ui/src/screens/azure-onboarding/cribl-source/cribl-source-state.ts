/**
 * Cribl source panel state - PURE (AZR-34, ADR 0007 D7-D10).
 *
 * The "Cribl Stream source" panel creates, behind a two-click confirm, the
 * Cribl input (type `eventhub` or `azure_blob`) that receives one onboarding
 * lane. Core's planCriblSource (read-only) and applyCriblSource (create-only
 * write, commit and deploy) do the work; this module decides what the panel
 * offers, when the Create button is disabled and why, what the confirm names,
 * and what each outcome says.
 *
 * THE CONFIRM MACHINE is the Defender export's (defender-export-section.tsx:
 * 160-176): everything the confirm names goes into one arm key, and the arm
 * holds only for that key. Any change - worker group, rule, credential kind,
 * the Listen attestation, a plan value, a newer read, or a changed paste
 * DESCRIPTOR - produces another key and disarms. Reverting the change does not
 * re-arm: a stale arm is dropped outright.
 *
 * ENTRA ID FIRST (ADR 0008). An Event Hub lane offers Entra ID - a dedicated
 * Cribl service principal holding Azure Event Hubs Data Receiver - first and
 * as the default; listKeys and a pasted connection string are the fallbacks.
 * Its client secret is handled exactly as the Blob lane's: a ref in the panel,
 * never this module.
 *
 * SECRETS. A pasted connection string never reaches this module: the panel
 * parses it (core parseEventHubConnectionString) and hands over only the
 * non-secret descriptor {host, keyName, entityPath}. Nothing here can render
 * the key, because nothing here is given it.
 *
 * No React, no IO, no clock.
 */

import { PLAN_VALUE_KEYS, isInvalidConnection, onboardingSource, ruleCanManage, ruleSafeForCriblSource } from "@soc/core";
import type {
  ApplyCriblSourceOutcome,
  ApplyFailureStage,
  ApplyRefusalReason,
  ConnectionDescriptor,
  CriblInputType,
  CriblSourceRecord,
  InvalidConnectionReason,
  LaneTopics,
  ListRead,
  NamespaceAuthRule,
  NotDeployedReason,
  OnboardingProgress,
  OnboardingSourceId,
  OnboardingTransport,
  ParsedConnection,
  PastedCredentialCheck,
  PlanCredential,
  PlanCriblSourceResult,
  PlanRefusalReason,
  PlanValues,
  ReadyCriblSource,
  SourceMode,
} from "@soc/core";

export type CredentialKind = PlanCredential["kind"];

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const INPUT_TYPE_LABEL: Readonly<Record<CriblInputType, string>> = {
  eventhub: "Azure Event Hubs source (eventhub)",
  azure_blob: "Azure Blob Storage source (azure_blob)",
};

export interface CriblSourceRow {
  readonly sourceId: OnboardingSourceId;
  readonly title: string;
  readonly transport: OnboardingTransport;
  readonly inputType: CriblInputType;
  readonly inputTypeLabel: string;
  /** This app's record of an earlier create, or null. */
  readonly record: CriblSourceRecord | null;
  /** The row's status line. */
  readonly status: string;
}

/** One row per chosen source, in the order given (the screen passes catalog order). */
export function sourceRows(
  chosen: readonly OnboardingSourceId[],
  progress: Pick<OnboardingProgress, "criblSources">,
): CriblSourceRow[] {
  const rows: CriblSourceRow[] = [];
  for (const id of chosen) {
    const source = onboardingSource(id);
    if (source === undefined) continue;
    const record = progress.criblSources[id] ?? null;
    rows.push({
      sourceId: id,
      title: source.title,
      transport: source.transport,
      inputType: source.criblInputType,
      inputTypeLabel: INPUT_TYPE_LABEL[source.criblInputType],
      record,
      status:
        record === null
          ? "No Cribl source created by this app yet."
          : `Created by this app: input ${record.inputId} (${record.inputType}) in worker group ${record.groupId}.`,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Listen rules
// ---------------------------------------------------------------------------

/**
 * The rules a Cribl Event Hub SOURCE may read with: Listen, and NOT Manage
 * (AZR-58 - a Manage key in a Cribl secret is control of the namespace). This
 * is deliberately separate from the Defender picker's sendableRules
 * (azure-onboarding-state.ts) - a Send-only rule lets the export write but
 * cannot be read from. Nothing is preselected.
 */
export function listenRules<T extends { readonly rights: readonly string[] }>(rules: readonly T[]): T[] {
  return rules.filter((r) => ruleSafeForCriblSource(r.rights));
}

/** The rule picker's message, or null when there are Listen rules to pick. */
export function listenRuleMessage(read: ListRead<NamespaceAuthRule> | null): string | null {
  if (read === null) return "The namespace's authorization rules have not been read yet.";
  if (read.state === "refused") {
    return "The namespace's authorization rules could not be read, so which keys can listen is unknown.";
  }
  if (read.rows.length === 0) return "This namespace has no authorization rules.";
  if (listenRules(read.rows).length === 0) {
    const names = read.rows.map((r) => `${r.name} (${r.rights.join(", ") || "no rights"})`);
    const manage = read.rows.filter((r) => ruleCanManage(r.rights)).map((r) => r.name);
    if (manage.length > 0) {
      return (
        `None of this namespace's authorization rules can be used: ${names.join("; ")}. ` +
        `${manage.join(", ")} can Manage the namespace, so its key is not put in a Cribl secret. ` +
        "Create a Listen-only rule in the portal and read the rules again."
      );
    }
    return `None of this namespace's authorization rules can listen: ${names.join("; ")}. Create a Listen-only rule in the portal.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Credential choices
// ---------------------------------------------------------------------------

export interface CredentialChoice {
  readonly kind: CredentialKind;
  readonly label: string;
  readonly isDefault: boolean;
}

const ENTRA_LABEL = "Entra ID - a Cribl service principal (recommended)";
const LIST_KEYS_LABEL = "Let the app read the key of the chosen Listen rule when you confirm";
const PASTE_LABEL = "Paste a connection string for a Listen rule";
const CLIENT_SECRET_LABEL = "Paste the service principal's client secret";

/**
 * The credential sources a lane offers (D7, ADR 0008). An Event Hub lane
 * offers Entra ID first and as the default whatever its mode, then the two
 * SAS fallbacks: the app reading a Listen rule's key, or a pasted connection
 * string. Blob always uses a service principal secret; an account-key
 * connection string is never offered. `mode` no longer changes the Event Hub
 * default; it stays in the signature for the callers.
 */
export function credentialChoices(_mode: SourceMode, transport: OnboardingTransport): CredentialChoice[] {
  if (transport === "blob") return [{ kind: "client-secret", label: CLIENT_SECRET_LABEL, isDefault: true }];
  return [
    { kind: "entra-id", label: ENTRA_LABEL, isDefault: true },
    { kind: "listKeys", label: LIST_KEYS_LABEL, isDefault: false },
    { kind: "paste", label: PASTE_LABEL, isDefault: false },
  ];
}

// ---------------------------------------------------------------------------
// Paste descriptor
// ---------------------------------------------------------------------------

const INVALID_PASTE: Readonly<Record<InvalidConnectionReason, string>> = {
  empty: "Paste the connection string of a Listen rule.",
  malformed: "This is not an Event Hub connection string.",
  "no-endpoint": "The connection string has no Endpoint.",
  "no-key-name": "The connection string has no SharedAccessKeyName.",
  "no-key": "The connection string has no key.",
};

export type PasteDescriptorView =
  | { readonly ok: true; readonly rows: readonly { readonly label: string; readonly value: string }[] }
  | { readonly ok: false; readonly text: string };

/**
 * What the panel shows under the paste field: the descriptor's host, key name
 * and hub. It is given the parsed descriptor only, so the key cannot appear.
 */
export function pasteDescriptorView(parsed: ParsedConnection | null): PasteDescriptorView | null {
  if (parsed === null) return null;
  if (isInvalidConnection(parsed)) return { ok: false, text: INVALID_PASTE[parsed.invalid] };
  return {
    ok: true,
    rows: [
      { label: "Namespace host", value: parsed.host },
      { label: "Key name", value: parsed.keyName },
      { label: "Hub", value: parsed.entityPath ?? "not scoped to one hub" },
    ],
  };
}

// ---------------------------------------------------------------------------
// Refusal copy
// ---------------------------------------------------------------------------

/** Every plan refusal, in words. A Record so a new reason fails the typecheck. */
export const PLAN_REFUSAL_COPY: Readonly<Record<PlanRefusalReason, string>> = {
  "no-group": "Choose a worker group first.",
  "missing-value": "A plan value this source needs is not filled in.",
  "credential-mismatch": "The credential does not fit this source's transport.",
  "app-principal":
    "That client ID is this app's own registration. Use a service principal dedicated to Cribl: anyone who can read the worker group's secrets could use its secret.",
  "principal-mismatch":
    "The client ID belongs to a different service principal than the object ID in the plan values, so the role would be checked for one principal while the source signs in as another. Make the object ID match the client ID.",
  "receiver-role-overprivileged":
    "The Cribl service principal holds Azure Event Hubs Data Owner, which includes listKeys on every access rule. Its secret in a Cribl secret would control the namespace. Grant only Azure Event Hubs Data Receiver on the hub.",
  "receiver-role-missing":
    "The Cribl service principal does not hold Azure Event Hubs Data Receiver on the hub or the namespace, so the source could not read. Assign it, then create the source.",
  "receiver-role-unreadable":
    "The Cribl service principal's role assignments could not be read, so whether it can read the hub is unknown.",
  "blob-source": "A blob source reads no hub.",
  "no-hub-named": "The plan names no hub for this source.",
  "hubs-not-measured": "No hub has appeared yet in a complete hub list: run Validate (read only) first.",
  "no-hub-measured": "No hub has appeared yet: Azure creates it when the first logs are sent.",
  "hub-claimed": "Another chosen source already reads this hub.",
  "namespace-unreadable": "The Event Hub namespace could not be read, so its tier is unknown.",
  "basic-sku": "The namespace is on the Basic tier, which Cribl's Kafka-protocol source cannot read.",
  "sku-unknown": "The namespace's tier could not be determined, so Kafka support is unknown.",
  "rules-unreadable": "The namespace's authorization rules could not be read.",
  "unknown-rule": "That key name is not one of the namespace's authorization rules.",
  "rule-cannot-listen": "This key cannot listen: its rule has no Listen rights.",
  "rule-can-manage": "This key can Manage the namespace, so it is not stored in Cribl. Use a Listen-only rule.",
  "consumer-group-missing": "The consumer group does not exist on the hub yet, so the source could not read. Create it, run Validate, then create the source.",
  "consumer-group-unreadable": "The consumer group could not be read, so whether the source could read is unknown.",
  "wrong-namespace": "Wrong namespace: the connection string is for another Event Hub namespace.",
  "entity-mismatch": "The connection string is scoped to a different hub than this source reads.",
  "rule-rights-unknown": "The rules could not be read, so whether this key can listen is unknown.",
  "inputs-unreadable": "Cribl's existing sources could not be read.",
  "input-differs": "A Cribl source with this id already exists and differs.",
  "input-foreign": "A Cribl source with this id exists and was not created by this app.",
  "secret-exists": "A Cribl secret with this id already exists.",
  "secret-foreign": "A Cribl secret with this id exists and was not created by this app.",
  "secret-unreadable": "Cribl's secrets could not be read.",
  "status-unknown": "Cribl's pending-change status could not be read.",
  "scope-unplaced": "A pending change could not be placed in a worker group, so what a commit would carry is unknown.",
};

// ---------------------------------------------------------------------------
// Create gating
// ---------------------------------------------------------------------------

export interface CreateGateInput {
  readonly groupId: string;
  /** A plan or apply is in flight. */
  readonly busy: boolean;
  readonly transport: OnboardingTransport;
  readonly credentialKind: CredentialKind | null;
  /** The chosen Listen rule name, '' when none (listKeys only). */
  readonly rule: string;
  /** The parsed paste (paste only); null when nothing is pasted. */
  readonly paste: ParsedConnection | null;
  /** checkPastedCredential's answer for the paste, when it has been checked. */
  readonly pasteCheck: PastedCredentialCheck | null;
  /** laneTopics for the lane (Event Hub only); null when not computed. */
  readonly topics: LaneTopics | null;
  /** The pasted client secret is present (blob and Entra ID). */
  readonly hasClientSecret?: boolean;
  /** The Cribl principal's ids (Entra ID and blob); objectId is the plan value. */
  readonly entra?: { readonly tenantId: string; readonly clientId: string; readonly objectId: string };
  /** This app's own registration client id, refused as the Cribl principal. */
  readonly appClientId?: string;
  /**
   * The pasted client secret (blob and Entra ID) looks like a key-bearing
   * connection string (core looksLikeConnectionString). A flag, never the value.
   */
  readonly secretIsConnectionString?: boolean;
}

/** Why Create is disabled when a connection string was pasted as a client secret. */
export const CLIENT_SECRET_IS_CONNECTION_STRING =
  "That is a connection string, not a client secret. A connection string's key is never stored as the service principal's secret; paste the client secret.";

const ENTRA_SECRET_NEEDED = "Paste the Cribl service principal's client secret.";

/**
 * Why the Cribl principal's ids cannot be used yet, or null: a missing id, or
 * this app's own client id (ADR 0008 section 2, AZR-66). ONE check for the
 * Entra ID and blob lanes; only Entra ID reads the role, so only it needs the
 * object id.
 */
function principalIdsReason(g: CreateGateInput, needObjectId: boolean): string | null {
  const ids = g.entra;
  const missing: string[] = [];
  if (ids === undefined || ids.tenantId.trim() === "") missing.push("tenant ID");
  if (ids === undefined || ids.clientId.trim() === "") missing.push("client ID");
  if (needObjectId && (ids === undefined || ids.objectId.trim() === "")) missing.push("object ID");
  if (missing.length > 0) return `Enter the Cribl service principal's ${missing.join(", ")}.`;
  const app = g.appClientId?.trim().toLowerCase() ?? "";
  if (ids !== undefined && app !== "" && ids.clientId.trim().toLowerCase() === app) return PLAN_REFUSAL_COPY["app-principal"];
  return null;
}

/** Why an Entra ID lane cannot plan yet, or null. */
function entraDisabledReason(g: CreateGateInput): string | null {
  const idsReason = principalIdsReason(g, true);
  if (idsReason !== null) return idsReason;
  if (g.hasClientSecret !== true) return ENTRA_SECRET_NEEDED;
  return g.secretIsConnectionString === true ? CLIENT_SECRET_IS_CONNECTION_STRING : null;
}

/** Why Create is disabled, or null when it can be armed. */
export function createDisabledReason(g: CreateGateInput): string | null {
  if (g.busy) return "Working...";
  if (g.groupId.trim() === "") return PLAN_REFUSAL_COPY["no-group"];
  if (g.credentialKind === null) return "Choose where the credential comes from.";
  if (g.transport === "blob") {
    if (g.credentialKind !== "client-secret") return PLAN_REFUSAL_COPY["credential-mismatch"];
    // AZR-66: the blob lane signs in as the Cribl principal too, never as
    // this app's own registration. Its role is not read here, so no object id.
    const idsReason = principalIdsReason(g, false);
    if (idsReason !== null) return idsReason;
    if (g.hasClientSecret !== true) return "Paste the service principal's client secret.";
    return g.secretIsConnectionString === true ? CLIENT_SECRET_IS_CONNECTION_STRING : null;
  }
  if (g.credentialKind === "client-secret") return PLAN_REFUSAL_COPY["credential-mismatch"];
  if (g.topics !== null && g.topics.kind === "refused") return PLAN_REFUSAL_COPY[g.topics.reason];
  if (g.credentialKind === "entra-id") return entraDisabledReason(g);
  if (g.credentialKind === "listKeys") {
    return g.rule.trim() === "" ? "Choose a rule with Listen rights." : null;
  }
  const view = pasteDescriptorView(g.paste);
  if (view === null) return INVALID_PASTE.empty;
  if (!view.ok) return view.text;
  if (needsAttestation(g)) return ATTESTATION_NEEDED_COPY;
  if (g.pasteCheck !== null && !g.pasteCheck.ok) return PLAN_REFUSAL_COPY[g.pasteCheck.reason];
  return null;
}

/** The label of the D7 attestation checkbox the panel shows when it is needed. */
export const ATTESTATION_LABEL = "This key has Listen rights";

/**
 * Why Create is disabled while the namespace's rules could not be read: the
 * paste may still be usable, but only once the operator vouches for it. The
 * copy names the checkbox, so the way forward is on screen.
 */
export const ATTESTATION_NEEDED_COPY = `${PLAN_REFUSAL_COPY["rule-rights-unknown"]} If you know it can, tick "${ATTESTATION_LABEL}" to continue.`;

/**
 * Whether the panel must offer the "This key has Listen rights" attestation
 * (D7): the paste check, or a plan, refused because the namespace's rules
 * could not be read. Ticking it re-checks the paste with attested=true, which
 * answers {ok:true, attested:true} and enables Create.
 */
export function needsAttestation(g: {
  readonly pasteCheck: PastedCredentialCheck | null;
  readonly planResult?: PlanCriblSourceResult | null;
}): boolean {
  if (g.pasteCheck !== null && !g.pasteCheck.ok && g.pasteCheck.reason === "rule-rights-unknown") return true;
  const plan = g.planResult;
  return plan !== undefined && plan !== null && plan.kind === "refused" && plan.reason === "rule-rights-unknown";
}

// ---------------------------------------------------------------------------
// The confirm machine
// ---------------------------------------------------------------------------

/** Everything the confirm names, plus the read it was armed against. */
export interface ArmInputs {
  readonly groupId: string;
  readonly sourceId: OnboardingSourceId;
  readonly credentialKind: CredentialKind | null;
  readonly rule: string;
  readonly attested: boolean;
  readonly values: PlanValues;
  /** Bumped on every Azure or Cribl read the plan depends on. */
  readonly readSeq: number;
  readonly descriptor: ConnectionDescriptor | null;
  /** Entra ID only: [tenantId, clientId] as entered, both named by the confirm. */
  readonly entra?: readonly [string, string] | null;
}

/** The arm key: any change to what the confirm names produces a different one. */
export function armKey(a: ArmInputs): string {
  return JSON.stringify([
    a.groupId,
    a.sourceId,
    a.credentialKind,
    a.rule,
    a.attested,
    PLAN_VALUE_KEYS.map((k) => a.values[k]),
    a.readSeq,
    a.descriptor === null ? null : [a.descriptor.host, a.descriptor.keyName, a.descriptor.entityPath ?? null],
    a.entra ?? null,
  ]);
}

export type ConfirmState =
  | { readonly phase: "idle" }
  | { readonly phase: "planning"; readonly key: string }
  | { readonly phase: "armed"; readonly key: string; readonly ready: ReadyCriblSource }
  | {
      readonly phase: "planned";
      readonly key: string;
      readonly result: Exclude<PlanCriblSourceResult, { kind: "ready" }>;
    }
  | { readonly phase: "applying"; readonly key: string }
  | { readonly phase: "done"; readonly outcome: ApplyCriblSourceOutcome };

export type ConfirmAction =
  /** What the confirm would name changed; a state for another key is dropped. */
  | { readonly type: "inputs"; readonly key: string }
  | { readonly type: "plan-start"; readonly key: string }
  | { readonly type: "plan-result"; readonly key: string; readonly result: PlanCriblSourceResult }
  | { readonly type: "apply-start"; readonly key: string }
  | { readonly type: "apply-result"; readonly outcome: ApplyCriblSourceOutcome };

export const CONFIRM_IDLE: ConfirmState = { phase: "idle" };

export function confirmReducer(state: ConfirmState, action: ConfirmAction): ConfirmState {
  switch (action.type) {
    case "inputs":
      // An apply in flight runs to its outcome; everything else keyed to an
      // older key is stale and goes back to idle (never re-armed by a revert).
      if (state.phase === "idle" || state.phase === "done" || state.phase === "applying") return state;
      return state.key === action.key ? state : CONFIRM_IDLE;
    case "plan-start":
      return { phase: "planning", key: action.key };
    case "plan-result":
      if (state.phase !== "planning" || state.key !== action.key) return state;
      return action.result.kind === "ready"
        ? { phase: "armed", key: action.key, ready: action.result.ready }
        : { phase: "planned", key: action.key, result: action.result };
    case "apply-start":
      if (state.phase !== "armed" || state.key !== action.key) return state;
      return { phase: "applying", key: action.key };
    case "apply-result":
      if (state.phase !== "applying") return state;
      return { phase: "done", outcome: action.outcome };
  }
}

/**
 * What a Create click does: the FIRST click plans (read-only) and, when the
 * plan is ready, arms; only a click while armed for the CURRENT key applies.
 */
export function createClick(state: ConfirmState, key: string): "plan" | "apply" | "none" {
  if (state.phase === "planning" || state.phase === "applying") return "none";
  if (state.phase === "armed" && state.key === key) return "apply";
  return "plan";
}

/** Whether the confirm is showing for this key. */
export function isArmed(state: ConfirmState, key: string): state is Extract<ConfirmState, { phase: "armed" }> {
  return state.phase === "armed" && state.key === key;
}

// ---------------------------------------------------------------------------
// Confirm text
// ---------------------------------------------------------------------------

/**
 * The confirm, line by line: the worker group, the input id and type, the
 * secret id, the key name ACTUALLY used (or the principal), the attestation
 * when one was given, the files the commit can include AT MOST (and anybody
 * else's pending work in them), and that the deploy restarts the group's
 * workers. The file list is an upper bound, not a promise: the kit's
 * commitAndDeploy commits only the files still pending after the create
 * (DBT-164).
 */
export function confirmText(ready: ReadyCriblSource): string[] {
  const entra = ready.entraPrincipal;
  const who =
    ready.credentialKind === "entra-id" && entra !== null
      ? `Authenticates with Entra ID as the Cribl service principal ${entra.clientId} (object ID ${entra.objectId}, tenant ${entra.tenantId}). ` +
        `Object ID ${entra.objectId} holds ${entra.role} at ${entra.roleScope}. No SAS key is used.`
      : ready.credentialKind === "client-secret"
      ? `Authenticates as service principal ${ready.keyNameOrPrincipal}.`
      : ready.credentialKind === "listKeys"
        ? `Reads with the key of rule ${ready.keyNameOrPrincipal}, fetched from Azure when you confirm.`
        : `Reads with the pasted key of rule ${ready.keyNameOrPrincipal}.`;
  // AZR-57: both type labels start with "Azure", so "an" is right for each;
  // the pin holds every label to that.
  const lines = [
    `New Cribl source ${ready.inputId}, an ${INPUT_TYPE_LABEL[ready.inputType]}, in worker group ${ready.groupId}.`,
    ready.credentialKind === "entra-id"
      ? `Store the principal's client secret in a new Cribl secret ${ready.secretId}; the source names the secret and never holds it.`
      : `Store its credential in a new Cribl secret ${ready.secretId}; the source names the secret and never holds the key.`,
    who,
  ];
  // AZR-59 review: the role is read for the object id; the input signs in as
  // the client id. Say whether the directory tied them, never imply it.
  if (ready.credentialKind === "entra-id" && entra !== null) {
    lines.push(
      entra.principalCheck === "matched"
        ? `The directory confirms client ID ${entra.clientId} is object ID ${entra.objectId}.`
        : `The role was read for object ID ${entra.objectId} as entered; the app could not confirm that client ID ${entra.clientId} is that principal. Check they belong together before you confirm.`,
    );
  }
  // AZR-56: the consumer group is part of what is being agreed to.
  if (ready.readsFrom !== null) {
    const { hubs, consumerGroup } = ready.readsFrom;
    lines.push(`Reads ${hubs.length === 1 ? "hub" : "hubs"} ${hubs.join(", ")} with consumer group ${consumerGroup}.`);
  }
  if (ready.attested) {
    lines.push(
      `You confirmed that ${ready.keyNameOrPrincipal} has Listen rights; the app could not read the rules to check.`,
    );
  }
  lines.push(
    `The commit can include at most these files, and only those still uncommitted after the create: ${ready.commitFiles.join(", ")}.`,
  );
  if (ready.dirtyAlready.length > 0) {
    lines.push(
      `These files already have someone else's uncommitted changes, which the commit will carry too: ${ready.dirtyAlready.join(", ")}.`,
    );
  }
  lines.push(`Then deploy worker group ${ready.groupId}, which restarts its workers.`);
  return lines;
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export type OutcomeTone = "ok" | "warning" | "error";

export interface OutcomeView {
  readonly tone: OutcomeTone;
  /** Distinct for every outcome and sub-reason. */
  readonly headline: string;
  /** Core's detail, verbatim ('' when none). */
  readonly detail: string;
  /** What to do in Cribl next, for the outcomes that leave work there. */
  readonly inCribl: string | null;
}

const NOT_DEPLOYED_COPY: Readonly<Record<NotDeployedReason, string>> = {
  "nothing-to-commit": "Created, but Cribl showed nothing to commit for it.",
  "status-unknown": "Created, but Cribl's pending-change status could not be read, so nothing was committed.",
  "scope-unknown": "Created, but a pending change could not be placed in a worker group, so nothing was committed.",
  "newer-commit": "Created and committed, but a newer commit exists, so it was not deployed.",
  "head-unknown": "Created and committed, but the latest commit could not be read, so it was not deployed.",
  "committed-unknown-hash": "Created; the commit answered without a commit id, so it was not deployed.",
  "commit-failed": "Created, but the commit was refused.",
  incomplete: "Created and committed, but some of its changes are still pending, so it was not deployed.",
  unverified: "Created and committed, but completeness could not be checked, so it was not deployed.",
  "deploy-failed": "Created and committed, but the deploy was refused.",
  "stored-mismatch": "Created, but what Cribl stored differs from what was sent, so it was not committed.",
  "stored-unreadable": "Created, but it could not be read back, so it was not committed.",
  "commit-sequence-failed": "Created, but the commit sequence broke off; what Cribl did is unknown.",
};

const NOT_DEPLOYED_IN_CRIBL: Readonly<Record<NotDeployedReason, string>> = {
  "nothing-to-commit": "In Cribl, open the worker group's pending changes and check the source is there.",
  "status-unknown": "In Cribl, commit and deploy the worker group yourself once you have checked its pending changes.",
  "scope-unknown": "In Cribl, review the pending changes, then commit and deploy the worker group yourself.",
  "newer-commit": "In Cribl, check the newer commit, then deploy the worker group yourself.",
  "head-unknown": "In Cribl, check the latest commit, then deploy the worker group yourself.",
  "committed-unknown-hash": "In Cribl, find the commit in the version history, then deploy the worker group yourself.",
  "commit-failed": "In Cribl, commit and deploy the worker group yourself.",
  incomplete: "In Cribl, commit the remaining pending changes, then deploy the worker group yourself.",
  unverified: "In Cribl, check the pending changes are empty, then deploy the worker group yourself.",
  "deploy-failed": "In Cribl, deploy the worker group yourself.",
  "stored-mismatch": "In Cribl, open the source and compare it with the plan before committing.",
  "stored-unreadable": "In Cribl, open the source and check it before committing and deploying.",
  "commit-sequence-failed": "In Cribl, check the version history and pending changes, then commit and deploy as needed.",
};

const APPLY_REFUSAL_COPY: Readonly<Record<ApplyRefusalReason, string>> = {
  "credential-changed": "Not created: the credential changed after the confirm.",
  "status-unknown": "Not created: Cribl's pending-change status could not be read again.",
  "scope-unplaced": "Not created: a pending change could not be placed in a worker group.",
  "scope-grew": "Not created: other changes appeared since the confirm, so it no longer describes the commit.",
  "secret-appeared": "Not created: a secret with this id appeared since the confirm.",
  "input-appeared": "Not created: a source with this id appeared since the confirm.",
  "inputs-unreadable": "Not created: Cribl's sources could not be read again.",
  "secret-unreadable": "Not created: Cribl's secrets could not be read again.",
  "paste-invalid": "Not created: the pasted connection string is no longer valid.",
  "paste-is-connection-string": "Not created: a connection string was pasted where the client secret goes, so nothing was stored.",
  "pasted-changed": "Not created: the pasted connection string changed after the confirm.",
  "secret-exists": "Not created: Cribl refused the secret because one with this id already exists.",
};

const FAILURE_COPY: Readonly<Record<ApplyFailureStage, string>> = {
  "list-keys": "Failed: the rule's key could not be read from Azure. Nothing was written to Cribl.",
  "secret-create": "Failed: Cribl did not accept the secret.",
  "input-create": "Failed: Cribl did not accept the source.",
};

/** One outcome of applyCriblSource, in words. */
export function outcomeView(outcome: ApplyCriblSourceOutcome): OutcomeView {
  switch (outcome.kind) {
    case "created-running":
      return {
        tone: "ok",
        headline: `Created and running: worker group ${outcome.record.groupId} runs commit ${outcome.configVersion}.`,
        detail: "",
        inCribl: null,
      };
    case "created-deployed-unconfirmed":
      return {
        tone: "warning",
        headline:
          outcome.configVersion === null
            ? "Created and deployed, but the running version could not be read."
            : `Created and deployed, but the group reports version ${outcome.configVersion}, not this commit.`,
        detail: `Commit ${outcome.hash}.`,
        inCribl: "In Cribl, check the worker group's deployed version.",
      };
    case "created-not-deployed": {
      const route =
        outcome.reason === "deploy-failed" && outcome.route !== undefined
          ? ` (via the ${outcome.route} deploy path)`
          : "";
      return {
        tone: "warning",
        headline: `${NOT_DEPLOYED_COPY[outcome.reason]}${route}`,
        detail: outcome.detail,
        inCribl: NOT_DEPLOYED_IN_CRIBL[outcome.reason],
      };
    }
    case "refused":
      return {
        tone: "error",
        headline: APPLY_REFUSAL_COPY[outcome.reason],
        detail: leftBehind(outcome.detail, outcome.leftBehind),
        inCribl: outcome.leftBehind === undefined ? null : `In Cribl, remove secret ${outcome.leftBehind.secretId} if you do not retry.`,
      };
    case "failed":
      return {
        tone: "error",
        headline: FAILURE_COPY[outcome.stage],
        detail: leftBehind(outcome.detail, outcome.leftBehind),
        inCribl: outcome.leftBehind === undefined ? null : `In Cribl, remove secret ${outcome.leftBehind.secretId} if you do not retry.`,
      };
  }
}

function leftBehind(detail: string, left: { readonly secretId: string } | undefined): string {
  return left === undefined ? detail : `${detail} Secret ${left.secretId} was already created.`.trim();
}

/** A plan that did not reach the confirm: already applied, or refused. */
export function planResultView(result: Exclude<PlanCriblSourceResult, { kind: "ready" }>): OutcomeView {
  if (result.kind === "already-applied") {
    return {
      tone: "ok",
      headline: `Already created: input ${result.record.inputId} in worker group ${result.record.groupId} matches the plan.`,
      detail: "",
      inCribl: null,
    };
  }
  const fields = result.fields !== undefined && result.fields.length > 0 ? ` Differs in: ${result.fields.join(", ")}.` : "";
  return {
    tone: "error",
    headline: PLAN_REFUSAL_COPY[result.reason],
    detail: `${result.detail}${fields}`.trim(),
    inCribl: null,
  };
}
