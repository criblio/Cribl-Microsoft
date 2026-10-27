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
 * overwritten: another admin's secret of the same name must never be replaced
 * (contrast the older ensure-secret writers, a filed bug card).
 *
 * LISTEN, NOT SEND. A Cribl Event Hub SOURCE reads, so the rule behind its
 * credential needs Listen or Manage. The AZR-18 picker chooses a Send rule for
 * the Defender export to WRITE with; that rule is not reused here unless it
 * also listens (ruleCanListen).
 *
 * NO SECRET IN THE PLAN. The plan sees a pasted connection string only as its
 * non-secret descriptor (host, key name, entity path). The key itself is read
 * once, inside applyCriblSource, through a closure the caller holds.
 *
 * No clock, no timers: core is pure against its ports.
 */

import type { AzureManagement } from "../../ports/azure-management";
import type { CriblClient } from "../../ports/cribl-client";
import type { Logger } from "../../ports/logger";
import {
  buildNamespaceAuthRulesListRequest,
  buildNamespaceGetRequest,
  namespaceSupportsKafka,
  parseNamespaceAuthRules,
  ruleCanListen,
  type NamespaceAuthRule,
  type NamespaceRef,
} from "../../domain/eventhub-arm";
import { mapListRead, type ListRead } from "../../domain/logging-map/list-read";
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
  onboardingInputId,
  onboardingSecretId,
  type ConnectionDescriptor,
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
 */
export type PlanCredential =
  | { readonly kind: "listKeys"; readonly rule: string }
  | { readonly kind: "paste"; readonly descriptor: ConnectionDescriptor; readonly attested: boolean }
  | { readonly kind: "client-secret"; readonly tenantId: string; readonly clientId: string };

export interface PlanCriblSourceInput {
  readonly groupId: string;
  readonly lane: CriblSourceLane;
  readonly values: PlanValues;
  /** Hubs the last Validate MEASURED in a complete hub list; null when none was read. */
  readonly measuredHubs: readonly string[] | null;
  /** This app's KV record of an earlier create for the lane, or null. */
  readonly kvRecord: CriblSourceRecord | null;
  readonly credential: PlanCredential;
}

export type PlanRefusalReason =
  | "no-group"
  | "missing-value"
  | "credential-mismatch"
  | LaneTopicsRefusal
  | "namespace-unreadable"
  | "basic-sku"
  | "sku-unknown"
  | "rules-unreadable"
  | "unknown-rule"
  | "rule-cannot-listen"
  | PastedCredentialRefusal
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
  /** The files the commit will carry, as `groups/<g>/<marker>`. */
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
}

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

/** The commit files a create would carry, named in the group's tree. */
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
        : `${source.title} is read from an Event Hub with a connection string.`,
    );
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

    const rules = await readRules(ports.azure, namespace);
    if (credential.kind === "listKeys") {
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
          `Rule ${rule.name} has ${rule.rights.join(", ") || "no"} rights; a Cribl source needs Listen or Manage.`,
        );
      }
      keyNameOrPrincipal = rule.name;
    } else {
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

    inputBody = buildEventHubInputBody({
      id: inputId,
      namespace: namespace.name,
      topics: topics.topics,
      consumerGroup,
      secretId,
      sourceId: source.id,
      sourceTitle: source.title,
    });
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
    },
  };
}
