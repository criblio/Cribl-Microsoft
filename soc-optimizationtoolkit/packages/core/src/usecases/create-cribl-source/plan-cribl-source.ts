/**
 * create-cribl-source, PLAN half (AZR-34, ADR 0007 D7-D10).
 *
 * READ-ONLY. planCriblSource makes GETs and nothing else - on Azure (the
 * namespace, its authorization rules) and on Cribl (the inputs list, the
 * secret by id, the pending-change status). Its answer is what the confirm
 * dialog names; nothing it read is reused for the write, because
 * applyCriblSource re-reads everything that could have moved
 * (config-plane-writes.md rule 6, cribl-config-writes skill).
 *
 * CREATE-ONLY. The onboarding source never PATCHes or DELETEs. An existing
 * input that is ours and matches is "already applied" (zero writes); one that
 * differs, or that this app cannot prove it created, is REFUSED with the
 * fields named. A secret that already exists is refused rather than
 * overwritten: another admin's secret of the same name must never be replaced.
 * Even one this app provably owns is refused here, where ensureTextSecret
 * (usecases/ensure-secret, DBT-152) PATCHes its own stamped secret on a 409.
 *
 * LISTEN, NOT SEND, NEVER MANAGE. A Cribl Event Hub SOURCE reads, so the rule
 * behind its credential needs Listen. The AZR-18 picker chooses a Send rule for
 * the Defender export to WRITE with; that rule is not reused here unless it
 * also listens (ruleCanListen). A Manage-capable rule is refused (AZR-58,
 * backlog.md 6h-i): its key in a Cribl secret is control of the namespace.
 *
 * ENTRA ID FIRST (ADR 0008). The default Event Hub credential is a DEDICATED
 * Cribl service principal holding Azure Event Hubs Data Receiver on the hub.
 * The plan reads that principal's role assignments (assignedTo, the same
 * request the logging map uses) and refuses when no qualifying grant is in a
 * complete read, or when the read is refused - never assuming either way. It
 * never reads the SAS rules in this mode, and the apply never calls listKeys.
 * The app's own registration is refused as the principal: its secret in a
 * Cribl secret would hand its ARM write rights to the worker group.
 *
 * NO SECRET IN THE PLAN. The plan sees a pasted connection string only as its
 * non-secret descriptor (host, key name, entity path). The key itself is read
 * once, inside applyCriblSource, through a closure the caller holds.
 *
 * No clock, no timers: core is pure against its ports.
 */

import type { AzureManagement } from "../../ports/azure-management";
import type { CriblClient } from "../../ports/cribl-client";
import type { GraphDirectory, ServicePrincipalRef } from "../../ports/graph-directory";
import type { Logger } from "../../ports/logger";
import {
  EVENT_HUB_RECEIVER_ROLES,
  buildNamespaceAuthRulesListRequest,
  buildNamespaceGetRequest,
  buildHubConsumerGroupGetRequest,
  eventHubNamespacePath,
  eventHubResourceId,
  namespaceSupportsKafka,
  overprivilegedRoleCovering,
  receiverRoleCovering,
  parseNamespaceAuthRules,
  ruleCanListen,
  ruleCanManage,
  type NamespaceAuthRule,
  type NamespaceRef,
} from "../../domain/eventhub-arm";
import { mapListRead, type ListRead } from "../../domain/logging-map/list-read";
import { roleAssignmentsForPrincipalRequest } from "../../domain/logging-map/logging-map-requests";
import { listingRows } from "../../domain/inventory-listing";
import type { OnboardingSource } from "../../domain/onboarding-howto/sources";
import type { PlanValues } from "../../domain/onboarding-howto/plan-values";
import type { CriblSourceRecord } from "../../domain/onboarding-howto/progress-document";
import type { CriblInputType } from "../../domain/onboarding-howto/sources";
import {
  COMMIT_MARKERS,
  buildBlobInputBody,
  buildEventHubInputBody,
  checkPastedCredential,
  classifyExistingInput,
  classifyExistingSecret,
  laneTopics,
  manageRefusalDetail,
  onboardingInputId,
  onboardingSecretId,
  type ConnectionDescriptor,
  type EventHubAuth,
  type ExistingRead,
  type LaneTopicsRefusal,
  type OtherLane,
  type PastedCredentialRefusal,
} from "../../domain/cribl-onboarding-source";
import { commitScope, pendingFiles, type CommitScope } from "../../kit/config-writes/commitDeploy";
import { isOk, type ApiResponse, type Request } from "../../kit/config-writes/transport";
import { commitDeployTimeouts, criblRequestFor } from "../../kit/cribl-request";
import { readAllPages, readSingle } from "../read-logging-map";

/** Every log line this usecase writes starts with this; context carries ids only. */
export const CRIBL_SOURCE_LOG_PREFIX = "azure-onboarding:";

/**
 * How long the kit's commit and deploy calls may take. Inferred, not measured
 * (ADR 0007 live-verification list): a deploy restarts workers and can outlast
 * the CriblClient adapter's short default, which would turn a deploy that
 * happened into a rejection read as "failed".
 */
export const CRIBL_SOURCE_COMMIT_TIMEOUT_MS = 60_000;

export interface CriblSourcePorts {
  readonly cribl: CriblClient;
  readonly azure: AzureManagement;
  readonly logger?: Logger;
  /**
   * The Entra directory, when the shell binds it. An entra-id plan uses it to
   * tie the client id the input signs in as to the object id whose role it
   * reads; without it (or when the read is refused) the plan says the two were
   * not cross-checked, never that they match.
   */
  readonly graph?: GraphDirectory;
}

/** The lane being given a Cribl source: the source, its sub-selection, the other chosen lanes. */
export interface CriblSourceLane {
  readonly source: OnboardingSource;
  readonly subSelection: readonly string[];
  /** The other chosen lanes, so two inputs never read one hub (laneTopics). */
  readonly otherLanes?: readonly OtherLane[];
}

/**
 * Where the credential comes from, as the PLAN sees it (D7). None of these
 * carries a key.
 *
 *   listKeys       Event Hub: the app calls listKeys on `rule` inside the
 *                  confirmed apply. Default for an Automated source.
 *   paste          Event Hub: the operator pasted a connection string; the
 *                  plan sees its descriptor. `attested` is the explicit "This
 *                  key has Listen rights" tick, honoured only when the rules
 *                  list could not be read.
 *   client-secret  Blob: a service principal; the operator pastes its secret.
 *   entra-id       Event Hub (ADR 0008, the default): a DEDICATED Cribl
 *                  service principal signs in with OAUTHBEARER. Its object id
 *                  is the plan value criblPrincipalObjectId; its client secret
 *                  is pasted and supplied only at apply time, as for Blob.
 */
export type PlanCredential =
  | { readonly kind: "listKeys"; readonly rule: string }
  | { readonly kind: "paste"; readonly descriptor: ConnectionDescriptor; readonly attested: boolean }
  | { readonly kind: "client-secret"; readonly tenantId: string; readonly clientId: string }
  | { readonly kind: "entra-id"; readonly tenantId: string; readonly clientId: string };

export interface PlanCriblSourceInput {
  readonly groupId: string;
  readonly lane: CriblSourceLane;
  readonly values: PlanValues;
  /** Hubs the last Validate MEASURED in a complete hub list; null when none was read. */
  readonly measuredHubs: readonly string[] | null;
  /** This app's KV record of an earlier create for the lane, or null. */
  readonly kvRecord: CriblSourceRecord | null;
  readonly credential: PlanCredential;
  /**
   * This app's own registration client id. An entra-id credential naming it is
   * refused (ADR 0008 section 2). Absent when the caller does not know it.
   */
  readonly appClientId?: string;
}

export type PlanRefusalReason =
  | "no-group"
  | "missing-value"
  | "credential-mismatch"
  | "app-principal"
  | "principal-mismatch"
  | "receiver-role-overprivileged"
  | "receiver-role-missing"
  | "receiver-role-unreadable"
  | LaneTopicsRefusal
  | "namespace-unreadable"
  | "basic-sku"
  | "sku-unknown"
  | "rules-unreadable"
  | "unknown-rule"
  | "rule-cannot-listen"
  | PastedCredentialRefusal
  | "consumer-group-missing"
  | "consumer-group-unreadable"
  | "inputs-unreadable"
  | "input-differs"
  | "input-foreign"
  | "secret-exists"
  | "secret-foreign"
  | "secret-unreadable"
  | "status-unknown"
  | "scope-unplaced";

/** Everything the confirm names and the apply needs. Holds no secret. */
export interface ReadyCriblSource {
  readonly groupId: string;
  readonly sourceId: OnboardingSource["id"];
  readonly inputId: string;
  readonly inputType: CriblInputType;
  readonly secretId: string;
  /** The key name ACTUALLY used (listKeys rule or the pasted SharedAccessKeyName), or the client id. */
  readonly keyNameOrPrincipal: string;
  readonly credentialKind: PlanCredential["kind"];
  /** True when the rules could not be read and the operator attested Listen rights. */
  readonly attested: boolean;
  /** The pasted connection string's descriptor (paste only). */
  readonly descriptor: ConnectionDescriptor | null;
  /**
   * The files the commit CAN carry, as `groups/<g>/<marker>`: an upper bound.
   * The kit's commitAndDeploy commits only those pending after the write, so
   * the confirm must not word this list as what the commit will carry.
   */
  readonly commitFiles: readonly string[];
  /** Somebody else's uncommitted work in those files, which the commit will carry too. */
  readonly dirtyAlready: readonly string[];
  /** The scope the confirm describes; apply refuses if it grew. */
  readonly scope: CommitScope;
  /** The input body to POST. Names the secret; never carries it. */
  readonly inputBody: Record<string, unknown>;
  /** The namespace listKeys addresses (Event Hub only). */
  readonly namespace: NamespaceRef | null;
  /** The KV record the plan classified against, for the apply's re-check. */
  readonly kvRecord: CriblSourceRecord | null;
  /** The secret's human description (stamped when the body is built). */
  readonly secretDescription: string;
  /**
   * What an Event Hub source reads: its hubs and consumer group, each group
   * confirmed present on each hub by the plan (AZR-56). Null for Blob.
   */
  readonly readsFrom: { readonly hubs: readonly string[]; readonly consumerGroup: string } | null;
  /**
   * The Cribl principal an entra-id source signs in as, and the qualifying
   * role the plan READ for its object id (the first found) at `roleScope`.
   * `principalCheck` says whether the directory tied the client id to that
   * object id ("matched") or could not ("not-cross-checked": the role was read
   * for the object id as entered, and the client id is the operator's word).
   * Null in every other mode.
   */
  readonly entraPrincipal: {
    readonly tenantId: string;
    readonly clientId: string;
    readonly objectId: string;
    readonly role: string;
    readonly roleScope: string;
    readonly principalCheck: PrincipalCheck;
  } | null;
}

/** Whether the directory tied an entra-id client id to the object id whose role was read. */
export type PrincipalCheck = "matched" | "not-cross-checked";

export type PlanCriblSourceResult =
  | { readonly kind: "ready"; readonly ready: ReadyCriblSource }
  | { readonly kind: "already-applied"; readonly record: CriblSourceRecord }
  | {
      readonly kind: "refused";
      readonly reason: PlanRefusalReason;
      readonly detail: string;
      /** For input-differs: the identity fields that differ. */
      readonly fields?: readonly string[];
    };

function refused(reason: PlanRefusalReason, detail: string, fields?: readonly string[]): PlanCriblSourceResult {
  return fields === undefined ? { kind: "refused", reason, detail } : { kind: "refused", reason, detail, fields };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A call through the kit Request that never rejects: a rejection becomes status 0. */
export async function safeCall(
  request: Request,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse> {
  try {
    return await request(method, path, body === undefined ? undefined : { body });
  } catch (error) {
    return { status: 0, body: { error: errorText(error) } };
  }
}

/** A short, secret-free description of why a Cribl response is not an answer. */
export function responseDetail(what: string, r: ApiResponse): string {
  if (r.status === 0) {
    const err = (r.body as { error?: unknown } | null)?.error;
    return `${what}: no response (${typeof err === "string" ? err : "transport failure"})`;
  }
  return `${what}: HTTP ${r.status}`;
}

/** GET /system/inputs as an ExistingRead. */
export async function readInputs(request: Request): Promise<ExistingRead> {
  const r = await safeCall(request, "GET", "/system/inputs");
  if (!isOk(r.status)) return { state: "refused", detail: responseDetail("the inputs list", r) };
  const items = (r.body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return { state: "refused", detail: "the inputs list answered without an items array" };
  return { state: "read", items };
}

/** GET /system/secrets/:id as an ExistingRead. A 404 is a read with no items: the secret is absent. */
export async function readSecret(request: Request, secretId: string): Promise<ExistingRead> {
  const r = await safeCall(request, "GET", `/system/secrets/${encodeURIComponent(secretId)}`);
  if (r.status === 404) return { state: "read", items: [] };
  if (!isOk(r.status)) return { state: "refused", detail: responseDetail("the secret read", r) };
  const items = (r.body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return { state: "refused", detail: "the secret read answered without an items array" };
  return { state: "read", items };
}

/** The kit Request this usecase uses for one group, with the longer commit and deploy wait. */
export function groupRequest(cribl: CriblClient, groupId: string): Request {
  return criblRequestFor(cribl, groupId, { timeoutMsFor: commitDeployTimeouts(CRIBL_SOURCE_COMMIT_TIMEOUT_MS) });
}

/**
 * Every file a create's commit could carry, named in the group's tree: an
 * UPPER BOUND, not the commit. The kit commits only the markers still pending
 * after the write (commitAndDeploy), and which ones a create dirties is
 * undefined until measured. The kit exports no path builder, only the
 * classifier placePath; a pin holds every name here to placing as `mine`.
 */
export function commitFilesFor(groupId: string): string[] {
  return COMMIT_MARKERS.map((m) => `groups/${groupId}/${m}`);
}

/** Pending status, as the confirm describes it; refuses while it cannot be placed. */
export async function readScope(
  request: Request,
  groupId: string,
): Promise<{ kind: "ok"; scope: CommitScope } | { kind: "refused"; reason: "status-unknown" | "scope-unplaced"; detail: string }> {
  let pending: string[] | null;
  try {
    pending = await pendingFiles(request);
  } catch {
    pending = null;
  }
  const scope = commitScope(pending, groupId, COMMIT_MARKERS);
  if (pending === null) {
    return { kind: "refused", reason: "status-unknown", detail: "Cribl's pending-change status could not be read, so what a commit would carry is unknown." };
  }
  if (scope.unplaced.length > 0) {
    return {
      kind: "refused",
      reason: "scope-unplaced",
      detail: `Pending changes could not be placed in a group: ${scope.unplaced.join(", ")}. Commit or discard them in Cribl first.`,
    };
  }
  return { kind: "ok", scope };
}

function namespaceOf(values: PlanValues): NamespaceRef | null {
  const subscriptionId = values.subscriptionId.trim();
  const resourceGroup = values.resourceGroup.trim();
  const name = values.namespace.trim();
  if (subscriptionId === "" || resourceGroup === "" || name === "") return null;
  return { subscriptionId, resourceGroup, name };
}

async function readRules(azure: AzureManagement, ns: NamespaceRef): Promise<ListRead<NamespaceAuthRule>> {
  const read = await readAllPages(azure, buildNamespaceAuthRulesListRequest(ns), `authorization rules in namespace ${ns.name}`);
  return mapListRead(read, (rows) => listingRows(parseNamespaceAuthRules({ value: rows })));
}

const RECEIVER_ROLE_NAMES = EVENT_HUB_RECEIVER_ROLES.map((r) => r.roleName).join(" or ");

/**
 * Whether the Cribl principal `objectId` can receive from every hub in `hubs`
 * (ADR 0008 section 4). One assignedTo() read at the NAMESPACE scope first:
 * a grant there (or above) covers every hub. For each hub it does not cover,
 * one read at the HUB scope, which also returns grants above the hub, so a
 * complete hub read without a qualifying grant is a real absence even when the
 * namespace read was refused. A refused hub read is unknown, never absent.
 * A grant on another hub never counts (receiverRoleCovering checks the scope).
 * Data Owner covering any hub, in any row read, refuses even beside Data
 * Receiver: it carries listKeys on every rule, so the principal's secret in a
 * Cribl secret would be a Manage key by another name.
 */
async function readReceiverRole(
  azure: AzureManagement,
  ns: NamespaceRef,
  hubs: readonly string[],
  objectId: string,
): Promise<
  | { readonly kind: "ok"; readonly role: string; readonly scope: string }
  | {
      readonly kind: "refused";
      readonly reason: "receiver-role-missing" | "receiver-role-unreadable" | "receiver-role-overprivileged";
      readonly detail: string;
    }
> {
  const nsScope = eventHubNamespacePath(ns);
  const nsRead = await readAllPages(
    azure,
    roleAssignmentsForPrincipalRequest(nsScope, objectId),
    `role assignments of the Cribl principal on namespace ${ns.name}`,
  );
  const seen: unknown[] = nsRead.state === "read" ? [...nsRead.rows] : [];
  let found: { readonly roleName: string; readonly scope: string } | null = null;
  const missing: string[] = [];
  for (const hub of hubs) {
    const hubScope = eventHubResourceId(ns, hub);
    const fromNs = nsRead.state === "read" ? receiverRoleCovering(nsRead.rows, hubScope) : null;
    if (fromNs !== null) {
      found ??= fromNs;
      continue;
    }
    const hubRead = await readAllPages(
      azure,
      roleAssignmentsForPrincipalRequest(hubScope, objectId),
      `role assignments of the Cribl principal on hub ${hub}`,
    );
    if (hubRead.state === "refused") {
      return {
        kind: "refused",
        reason: "receiver-role-unreadable",
        detail:
          `The role assignments of the Cribl principal ${objectId} on hub ${hub} could not be read (${hubRead.refusal.text}), ` +
          `so whether it holds ${RECEIVER_ROLE_NAMES} is unknown.`,
      };
    }
    seen.push(...hubRead.rows);
    const fromHub = receiverRoleCovering(hubRead.rows, hubScope);
    if (fromHub === null) missing.push(hub);
    else found ??= fromHub;
  }
  for (const hub of hubs) {
    const owner = overprivilegedRoleCovering(seen, eventHubResourceId(ns, hub));
    if (owner !== null) {
      return {
        kind: "refused",
        reason: "receiver-role-overprivileged",
        detail:
          `The Cribl principal ${objectId} holds ${owner.roleName} at ${owner.scope}, which includes listKeys on every ` +
          "access rule, RootManageSharedAccessKey included. Its secret in a Cribl secret would give the worker group control " +
          `of the namespace. Remove that assignment and grant only ${RECEIVER_ROLE_NAMES} on the hub, then create the source.`,
      };
    }
  }
  if (missing.length > 0 || found === null) {
    return {
      kind: "refused",
      reason: "receiver-role-missing",
      detail:
        `The Cribl principal ${objectId} holds ${RECEIVER_ROLE_NAMES} neither on ${missing.length === 1 ? "hub" : "hubs"} ` +
        `${missing.join(", ")} nor on the namespace ${ns.name}, so the source would be created but could not read. ` +
        "Assign Azure Event Hubs Data Receiver (the How-to step for the Cribl principal says how), then create the source.",
    };
  }
  return { kind: "ok", role: found.roleName, scope: found.scope };
}

/**
 * Tie the client id the input signs in as to the object id whose role the
 * plan reads, through the directory (AZR-59 review). A directory entry for the
 * client id with ANOTHER object id refuses; the object id being this app's own
 * service principal refuses. No directory, a refused read, or a client id the
 * listing does not hold (it may be truncated, or the principal may live in
 * another tenant) is "not-cross-checked", never a match.
 */
async function crossCheckPrincipal(
  graph: GraphDirectory | undefined,
  clientId: string,
  objectId: string,
  appClientId: string,
): Promise<
  | { readonly kind: "ok"; readonly check: PrincipalCheck }
  | { readonly kind: "refused"; readonly reason: "principal-mismatch" | "app-principal"; readonly detail: string }
> {
  if (graph === undefined) return { kind: "ok", check: "not-cross-checked" };
  let sps: readonly ServicePrincipalRef[];
  try {
    sps = await graph.listServicePrincipals();
  } catch {
    return { kind: "ok", check: "not-cross-checked" };
  }
  const lc = (v: string): string => v.trim().toLowerCase();
  const obj = lc(objectId);
  if (appClientId !== "" && sps.some((sp) => lc(sp.appId) === appClientId && lc(sp.id) === obj)) {
    return {
      kind: "refused",
      reason: "app-principal",
      detail:
        `Object ID ${objectId} is this app's own service principal. Its secret in a Cribl secret would give the worker group ` +
        "this app's Azure rights; use a service principal dedicated to Cribl.",
    };
  }
  const byClient = sps.find((sp) => lc(sp.appId) === lc(clientId));
  if (byClient === undefined) return { kind: "ok", check: "not-cross-checked" };
  if (lc(byClient.id) !== obj) {
    return {
      kind: "refused",
      reason: "principal-mismatch",
      detail:
        `Client ID ${clientId} belongs to the service principal with object ID ${byClient.id}, not ${objectId}. ` +
        "The role would be checked for one principal while the source signs in as another. " +
        "Set the Cribl principal object ID in the plan values to the one that matches the client ID.",
    };
  }
  return { kind: "ok", check: "matched" };
}

/**
 * Plan the create of one lane's Cribl source. READ-ONLY (GETs only).
 * Never throws for a refused or failed read: those are refusals.
 */
export async function planCriblSource(
  ports: CriblSourcePorts,
  input: PlanCriblSourceInput,
): Promise<PlanCriblSourceResult> {
  const groupId = input.groupId.trim();
  if (groupId === "") return refused("no-group", "Choose the worker group the source runs on.");
  const { source, subSelection } = input.lane;
  const { values, credential } = input;
  const isBlob = source.transport === "blob";
  if (isBlob !== (credential.kind === "client-secret")) {
    return refused(
      "credential-mismatch",
      isBlob
        ? `${source.title} is read from Blob storage with a service-principal secret.`
        : `${source.title} is read from an Event Hub with Entra ID or a Listen rule's connection string.`,
    );
  }
  let entra: {
    readonly tenantId: string;
    readonly clientId: string;
    readonly objectId: string;
    readonly principalCheck: PrincipalCheck;
  } | null = null;
  if (credential.kind === "entra-id") {
    const tenantId = credential.tenantId.trim();
    const clientId = credential.clientId.trim();
    const objectId = values.criblPrincipalObjectId.trim();
    if (tenantId === "" || clientId === "" || objectId === "") {
      return refused("missing-value", "Enter the Cribl service principal's tenant ID, client ID and object ID.");
    }
    const appClientId = input.appClientId?.trim().toLowerCase() ?? "";
    if (appClientId !== "" && clientId.toLowerCase() === appClientId) {
      return refused(
        "app-principal",
        `Client ID ${clientId} is this app's own registration. Its secret in a Cribl secret would give the worker group this app's Azure rights; use a service principal dedicated to Cribl.`,
      );
    }
    const tie = await crossCheckPrincipal(ports.graph, clientId, objectId, appClientId);
    if (tie.kind === "refused") return refused(tie.reason, tie.detail);
    entra = { tenantId, clientId, objectId, principalCheck: tie.check };
  }

  const inputId = onboardingInputId(source, values);
  if (inputId === null) {
    return refused(
      "missing-value",
      isBlob ? "Enter the storage account and queue first." : "Enter the namespace (and the hub, for a source that names it) first.",
    );
  }
  const secretId = onboardingSecretId(inputId);

  let inputBody: Record<string, unknown>;
  let keyNameOrPrincipal: string;
  let descriptor: ConnectionDescriptor | null = null;
  let attested = false;
  let namespace: NamespaceRef | null = null;
  let readsFrom: ReadyCriblSource["readsFrom"] = null;
  let entraPrincipal: ReadyCriblSource["entraPrincipal"] = null;
  let auth: EventHubAuth = { kind: "sas" };

  if (credential.kind === "client-secret") {
    const tenantId = credential.tenantId.trim();
    const clientId = credential.clientId.trim();
    if (tenantId === "" || clientId === "") return refused("missing-value", "Enter the service principal's tenant and client id.");
    keyNameOrPrincipal = clientId;
    inputBody = buildBlobInputBody({
      id: inputId,
      storageAccount: values.storageAccount,
      queueName: values.queueName,
      tenantId,
      clientId,
      secretId,
      sourceId: source.id,
      sourceTitle: source.title,
    });
  } else {
    namespace = namespaceOf(values);
    if (namespace === null) return refused("missing-value", "Enter the subscription, resource group and namespace first.");
    const consumerGroup = values.consumerGroup.trim();
    if (consumerGroup === "") return refused("missing-value", "Enter the consumer group the source reads with.");

    const topics = laneTopics({
      source,
      values,
      subSelection,
      measuredHubs: input.measuredHubs,
      otherLanes: input.lane.otherLanes ?? [],
    });
    if (topics.kind === "refused") return refused(topics.reason, topics.detail);

    const nsRead = await readSingle(ports.azure, buildNamespaceGetRequest(namespace), `namespace ${namespace.name}`);
    if (nsRead.state === "refused") {
      return refused("namespace-unreadable", `The namespace could not be read (${nsRead.refusal.text}), so whether it speaks Kafka is unknown.`);
    }
    const row = nsRead.rows[0] as { sku?: { name?: unknown } } | undefined;
    const sku = typeof row?.sku?.name === "string" ? row.sku.name : "";
    const kafka = namespaceSupportsKafka(sku);
    if (kafka === false) {
      return refused("basic-sku", `Namespace ${namespace.name} is Basic tier, which has no Kafka endpoint for Cribl to read; use Standard or Premium.`);
    }
    if (kafka === null) {
      return refused("sku-unknown", `Namespace ${namespace.name} reports ${sku === "" ? "no SKU" : `SKU ${sku}`}, so whether it speaks Kafka is unknown.`);
    }

    if (credential.kind === "entra-id") {
      // ADR 0008: no SAS rule is read or used in this mode. `entra` was set
      // (or the plan refused) at the top for every entra-id credential.
      if (entra === null) return refused("missing-value", "Enter the Cribl service principal's tenant ID, client ID and object ID.");
      keyNameOrPrincipal = entra.clientId;
      auth = { kind: "entra-id", tenantId: entra.tenantId, clientId: entra.clientId };
    } else if (credential.kind === "listKeys") {
      const rules = await readRules(ports.azure, namespace);
      const ruleName = credential.rule.trim();
      if (ruleName === "") return refused("missing-value", "Choose a Listen-capable access rule.");
      if (rules.state === "refused") {
        return refused("rules-unreadable", `The namespace's access rules could not be read (${rules.refusal.text}), so whether ${ruleName} can listen is unknown.`);
      }
      const rule = rules.rows.find((r) => r.name === ruleName);
      if (rule === undefined) return refused("unknown-rule", `The namespace has no access rule named ${ruleName}.`);
      if (!ruleCanListen(rule.rights)) {
        return refused(
          "rule-cannot-listen",
          `Rule ${rule.name} has ${rule.rights.join(", ") || "no"} rights; a Cribl source needs Listen.`,
        );
      }
      // AZR-58: never listKeys a Manage rule into a Cribl secret.
      if (ruleCanManage(rule.rights)) return refused("rule-can-manage", manageRefusalDetail(rule.name));
      keyNameOrPrincipal = rule.name;
    } else {
      const rules = await readRules(ports.azure, namespace);
      const check = checkPastedCredential(credential.descriptor, {
        namespace: namespace.name,
        topics: topics.topics,
        rules,
        attested: credential.attested,
      });
      if (!check.ok) return refused(check.reason, check.detail);
      attested = check.attested;
      descriptor = credential.descriptor;
      keyNameOrPrincipal = credential.descriptor.keyName;
    }

    // AZR-56: an eventhub input whose consumer group is missing is created but
    // never reads. Read the group by name on every hub the source will read; a
    // 404 is missing, any other refusal is unknown, and both refuse.
    const missing: string[] = [];
    for (const hub of topics.topics) {
      const cgRead = await readSingle(
        ports.azure,
        buildHubConsumerGroupGetRequest(namespace, hub, consumerGroup),
        `consumer group ${consumerGroup} on ${hub}`,
      );
      if (cgRead.state === "refused") {
        if (cgRead.refusal.status === 404) {
          missing.push(hub);
          continue;
        }
        return refused(
          "consumer-group-unreadable",
          `The consumer group ${consumerGroup} on hub ${hub} could not be read (${cgRead.refusal.text}), so whether the source could read is unknown.`,
        );
      }
    }
    if (missing.length > 0) {
      return refused(
        "consumer-group-missing",
        `The consumer group ${consumerGroup} does not exist on ${missing.length === 1 ? "hub" : "hubs"} ${missing.join(", ")}, so the source would be created but could not read. ` +
          "Create it (the How-to step for the consumer group says how), run Validate, then create the source.",
      );
    }
    readsFrom = { hubs: [...topics.topics], consumerGroup };

    // ADR 0008 section 4: the Cribl principal must be able to receive.
    if (entra !== null) {
      const role = await readReceiverRole(ports.azure, namespace, topics.topics, entra.objectId);
      if (role.kind === "refused") return refused(role.reason, role.detail);
      entraPrincipal = { ...entra, role: role.role, roleScope: role.scope };
    }

    inputBody = buildEventHubInputBody({
      id: inputId,
      namespace: namespace.name,
      topics: topics.topics,
      consumerGroup,
      secretId,
      sourceId: source.id,
      sourceTitle: source.title,
      auth,
    });
    // listKeys is the only apply step that addresses the namespace; an
    // entra-id plan names none, so no key can be read for it.
    if (entra !== null) namespace = null;
  }

  const request = groupRequest(ports.cribl, groupId);

  const inputs = await readInputs(request);
  const inputVerdict = classifyExistingInput({ read: inputs, expected: inputBody, recorded: input.kvRecord });
  switch (inputVerdict.kind) {
    case "unknown":
      return refused("inputs-unreadable", `Cribl's inputs could not be read (${inputVerdict.detail}), so whether ${inputId} exists is unknown.`);
    case "ours-matching":
      return { kind: "already-applied", record: { groupId, inputId, inputType: source.criblInputType, secretId } };
    case "differs":
      return refused(
        "input-differs",
        `Input ${inputId} exists but differs in ${inputVerdict.fields.join(", ")}. This app does not change an existing input; edit or remove it in Cribl.`,
        inputVerdict.fields,
      );
    case "foreign":
      return refused("input-foreign", `An input named ${inputId} exists that this app cannot prove it created (${inputVerdict.missing.join("; ")}).`);
    case "absent":
      break;
  }

  const secret = await readSecret(request, secretId);
  const secretVerdict = classifyExistingSecret({ read: secret, secretId, recorded: input.kvRecord });
  switch (secretVerdict.kind) {
    case "unknown":
      return refused("secret-unreadable", `Cribl's secret ${secretId} could not be read (${secretVerdict.detail}).`);
    case "ours":
      return refused(
        "secret-exists",
        `Secret ${secretId} already exists from an earlier attempt. This app does not overwrite a secret; remove it in Cribl, then create again.`,
      );
    case "foreign":
      return refused("secret-foreign", `A secret named ${secretId} exists that this app cannot prove it created (${secretVerdict.missing.join("; ")}).`);
    case "absent":
      break;
  }

  const scope = await readScope(request, groupId);
  if (scope.kind === "refused") return refused(scope.reason, scope.detail);

  ports.logger?.info(`${CRIBL_SOURCE_LOG_PREFIX} cribl source planned`, { groupId, inputId, secretId, sourceId: source.id });

  return {
    kind: "ready",
    ready: {
      groupId,
      sourceId: source.id,
      inputId,
      inputType: source.criblInputType,
      secretId,
      keyNameOrPrincipal,
      credentialKind: credential.kind,
      attested,
      descriptor,
      commitFiles: commitFilesFor(groupId),
      dirtyAlready: scope.scope.alreadyDirty,
      scope: scope.scope,
      inputBody,
      namespace,
      kvRecord: input.kvRecord,
      secretDescription: `Azure onboarding credential for ${inputId}`,
      readsFrom,
      entraPrincipal,
    },
  };
}
