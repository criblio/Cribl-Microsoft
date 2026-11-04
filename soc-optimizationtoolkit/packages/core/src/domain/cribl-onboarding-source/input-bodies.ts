/**
 * Cribl INPUT bodies for the onboarding source (AZR-34, ADR 0007 D8). The
 * SECRET body is built in domain/cribl-secrets and only re-exported here
 * (DBT-163).
 *
 * THE EVENT HUB INPUT TYPE IS `eventhub`. `azure_eventhub` is the DESTINATION
 * type (live-architecture.ts:643,652); the vendored OpenAPI InputEventhub has
 * `type: enum ["eventhub"]` (packages/core/assets/cribl-openapi.json). The
 * blob source is the queue-driven `azure_blob` (InputAzureBlob, required
 * `type` + `queueName`).
 *
 * NO SECRET IN A BODY. The Event Hub input names its connection string through
 * `sasl.textSecret` (authType 'secret') and never carries `sasl.password`; in
 * Entra ID mode (ADR 0008) it names the Cribl principal's client secret
 * through `sasl.clientTextSecret`; the blob input names its client secret
 * through `clientTextSecret`. The only body
 * that carries a credential is the secret body, built by the app-wide
 * buildSecretBody in domain/cribl-secrets (DBT-163; re-exported here), which
 * goes to POST /system/secrets and nowhere else. No body carries `_metadata` (the
 * legacy template's buildEventHubSourceConfig does, eventhub-discovery.ts).
 *
 * `secretType`, NEVER `type`, is the secret builder's rule and is documented
 * there (cribl-secrets/secret-body.ts); since DBT-163 every secret writer goes
 * through it, so no writer can drift back to `type` (DBT-151).
 *
 * Every input body is stamped with the kit's stampDescription so ownership can be
 * proven later (kit/config-writes/ownership.ts, config-plane-writes rule 11).
 *
 * Pure: no IO, no Date, no randomness, no crypto.
 */

import { stampDescription } from "../../kit/config-writes/ownership";
import { normalizeTenantId, tenantToken } from "../tenancy";
import { APP_ID } from "../cribl-secrets/secret-body";
import type { CriblInputType, OnboardingSource } from "../onboarding-howto/sources";
import type { PlanValues } from "../onboarding-howto/plan-values";

/**
 * APP_ID and buildSecretBody live in domain/cribl-secrets (DBT-163): every
 * secret the app writes is built there, not only this feature's. Re-exported
 * so this module's public API is unchanged.
 */
export { APP_ID, buildSecretBody } from "../cribl-secrets/secret-body";

/** Prefix of every input id this feature creates; the manifest of ids it may own. */
export const ONBOARDING_INPUT_ID_PREFIX = "azure_onb_";

/**
 * Upper bound on a generated id. Inferred, not measured: Cribl's own ids are
 * short, and a value well under any plausible cap keeps the id readable in
 * the Leader UI. An id over the cap is truncated (deterministically), and a
 * truncation collision is caught by classifyExistingInput as `differs`.
 */
export const ONBOARDING_ID_MAX = 64;

/** Every non-alphanumeric becomes `_`, as sanitizeEhId (eventhub-discovery.ts:512). */
function sanitize(name: string): string {
  return name.trim().replace(/[^a-zA-Z0-9]/g, "_");
}

/** FNV-1a 32-bit over UTF-16 code units, as 8 lower-case hex digits. Pure. */
function fnv1a8(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * `id` within `max` characters. An id that fits is unchanged; an over-long one
 * keeps its head and ends in `_` plus a hash of the WHOLE id, so two ids that
 * differ only past the cap stay two ids (a plain slice made them one).
 */
function cappedTo(id: string, max: number): string {
  if (id.length <= max) return id;
  return `${id.slice(0, max - 9)}_${fnv1a8(id)}`;
}

function capped(id: string): string {
  return cappedTo(id, ONBOARDING_ID_MAX);
}

/**
 * The input id for one source lane, or null when a value it needs is unset.
 *
 *   Event Hub  azure_onb_eh_{tenant}_{namespace}_{hub}. For a source whose
 *              emitter names its hub, {hub} is that hub; for one where Azure
 *              creates the hubs itself (several topics on one input), {hub} is
 *              the source id, so the id stays stable as measured hubs appear.
 *   Blob       azure_onb_blob_{tenant}_{storageAccount}_{queue}.
 *
 * {tenant} is the connection's 8-character tenant token (ADR 0009 decision 3),
 * so two tenants' sources - and their secrets - never collide in one worker
 * group, whatever their namespaces are called. Null without a tenant. Ids made
 * before multi-tenant support carry no tenant component; this function never
 * produces them again, and the lane uses its KV record's id when it has one.
 *
 * Idempotent: the same inputs always give the same id.
 */
export function onboardingInputId(
  source: OnboardingSource,
  values: PlanValues,
  tenantId: string,
): string | null {
  const tenant = tenantToken(tenantId);
  if (tenant === null) return null;
  if (source.transport === "blob") {
    const account = values.storageAccount.trim();
    const queue = values.queueName.trim();
    if (account === "" || queue === "") return null;
    return capped(`${ONBOARDING_INPUT_ID_PREFIX}blob_${tenant}_${sanitize(account)}_${sanitize(queue)}`);
  }
  const ns = values.namespace.trim();
  if (ns === "") return null;
  const hubKey = laneHubKey(source, values);
  if (hubKey === null) return null;
  return capped(`${ONBOARDING_INPUT_ID_PREFIX}eh_${tenant}_${sanitize(ns)}_${sanitize(hubKey)}`);
}

/** The {hub} component of an Event Hub lane's id; null when a named hub is unset. */
function laneHubKey(source: OnboardingSource, values: PlanValues): string | null {
  if (source.hubNaming !== "named") return source.id;
  const hub = values.hubName.trim();
  return hub === "" ? null : hub;
}

/**
 * The id {@link onboardingInputId} gave the same values BEFORE ids carried a
 * tenant (ADR 0009): no tenant component, and an over-long id plainly sliced.
 * Used only to recognise a lane's KV record as still describing these values;
 * never used to name anything new.
 */
export function legacyOnboardingInputId(source: OnboardingSource, values: PlanValues): string | null {
  const slice = (id: string): string => (id.length <= ONBOARDING_ID_MAX ? id : id.slice(0, ONBOARDING_ID_MAX));
  if (source.transport === "blob") {
    const account = values.storageAccount.trim();
    const queue = values.queueName.trim();
    if (account === "" || queue === "") return null;
    return slice(`${ONBOARDING_INPUT_ID_PREFIX}blob_${sanitize(account)}_${sanitize(queue)}`);
  }
  const ns = values.namespace.trim();
  if (ns === "") return null;
  const hubKey = laneHubKey(source, values);
  if (hubKey === null) return null;
  return slice(`${ONBOARDING_INPUT_ID_PREFIX}eh_${sanitize(ns)}_${sanitize(hubKey)}`);
}

/**
 * The streamtag naming the connection's tenant on every input this feature
 * creates (audit tenancy MEDIUM, input-bodies.ts:144). The Event Hub input
 * authenticates with a connection string, so nothing else on it - or on its
 * events - says which tenant it reads.
 */
function tenantStreamtag(tenantId: string): string {
  return `tenant:${normalizeTenantId(tenantId)}`;
}

/**
 * The manifest of input ids this feature may own: the id grammar
 * {@link onboardingInputId} produces (`azure_onb_eh_...` or
 * `azure_onb_blob_...`, within the cap). An id outside it was not made here,
 * whatever its description says, so ownership fails on this signal alone.
 */
export function isOnboardingInputId(id: string): boolean {
  return (
    id.length <= ONBOARDING_ID_MAX &&
    (id.startsWith(`${ONBOARDING_INPUT_ID_PREFIX}eh_`) || id.startsWith(`${ONBOARDING_INPUT_ID_PREFIX}blob_`))
  );
}

/** The manifest of secret ids this feature may own: an onboarding input id's {@link onboardingSecretId}. */
export function isOnboardingSecretId(id: string): boolean {
  const suffix = "_secret";
  return (
    id.length <= ONBOARDING_ID_MAX &&
    id.endsWith(suffix) &&
    isOnboardingInputId(id.slice(0, id.length - suffix.length))
  );
}

/**
 * The Cribl text secret an input references: one per input, never shared. An
 * input id too long to take the suffix is capped the same way ids are - head
 * plus a hash of the whole input id - so two inputs never share a secret.
 */
export function onboardingSecretId(inputId: string): string {
  const suffix = "_secret";
  return `${cappedTo(inputId, ONBOARDING_ID_MAX - suffix.length)}${suffix}`;
}

/**
 * How an Event Hub input authenticates (ADR 0008 section 1).
 *
 *   sas       SASL PLAIN with `$ConnectionString` and the Listen rule's
 *             connection string in the named secret (the fallback modes)
 *   entra-id  SASL OAUTHBEARER as a DEDICATED Cribl service principal holding
 *             Azure Event Hubs Data Receiver; the named secret holds its client
 *             secret. Never the app's own registration (ADR 0008 section 2).
 */
export type EventHubAuth =
  | { readonly kind: "sas" }
  | { readonly kind: "entra-id"; readonly tenantId: string; readonly clientId: string };

/**
 * The Entra ID authority Cribl's eventhub input is pointed at. The vendored
 * OpenAPI enum also offers the US Government and China clouds; only the
 * public cloud is built (Measured: schema read, ADR 0008 Context).
 */
export const EVENTHUB_OAUTH_ENDPOINT = "https://login.microsoftonline.com";

/**
 * The OAuth scope for a namespace's Kafka endpoint. Inferred, not measured
 * (ADR 0008 Unverified: the Azure Event Hubs Kafka OAuth pattern).
 */
export function eventHubOAuthScope(namespace: string): string {
  return `https://${namespace.trim()}.servicebus.windows.net/.default`;
}

export interface EventHubInputSpec {
  readonly id: string;
  readonly namespace: string;
  /** The hubs to read (laneTopics). Never empty: the caller refuses first. */
  readonly topics: readonly string[];
  /** The plan's consumer group; D4 defaults it to 'cribl', never '$Default'. */
  readonly consumerGroup: string;
  readonly secretId: string;
  readonly sourceId: string;
  readonly sourceTitle: string;
  /** The connection's tenant, tagged on the input (tenantStreamtag). */
  readonly connectionTenantId: string;
  /** SAS when absent (ADR 0007); Entra ID is the ADR 0008 default the UI offers first. */
  readonly auth?: EventHubAuth;
}

function eventHubSasl(spec: EventHubInputSpec, ns: string): Record<string, unknown> {
  const auth = spec.auth ?? { kind: "sas" };
  if (auth.kind === "entra-id") {
    return {
      disabled: false,
      mechanism: "oauthbearer",
      oauthEndpoint: EVENTHUB_OAUTH_ENDPOINT,
      tenantId: auth.tenantId.trim(),
      clientId: auth.clientId.trim(),
      clientSecretAuthType: "secret",
      clientTextSecret: spec.secretId,
      scope: eventHubOAuthScope(ns),
    };
  }
  return {
    disabled: false,
    mechanism: "plain",
    authType: "secret",
    username: "$ConnectionString",
    textSecret: spec.secretId,
  };
}

/** The Event Hub (Kafka) input body (D8, ADR 0008). Carries the secret's NAME only. */
export function buildEventHubInputBody(spec: EventHubInputSpec): Record<string, unknown> {
  const ns = spec.namespace.trim();
  return {
    id: spec.id,
    type: "eventhub" satisfies CriblInputType,
    disabled: false,
    sendToRoutes: true,
    pqEnabled: false,
    streamtags: ["azure", "azure-onboarding", spec.sourceId, tenantStreamtag(spec.connectionTenantId)],
    brokers: [`${ns}.servicebus.windows.net:9093`],
    topics: [...spec.topics],
    groupId: spec.consumerGroup,
    fromBeginning: true,
    sasl: eventHubSasl(spec, ns),
    tls: {
      disabled: false,
      rejectUnauthorized: true,
    },
    description: stampDescription(`Azure onboarding: ${spec.sourceTitle} from ${ns}`, APP_ID),
  };
}

export interface BlobInputSpec {
  readonly id: string;
  readonly storageAccount: string;
  readonly queueName: string;
  /** The Entra tenant and service-principal client the secret belongs to. */
  readonly tenantId: string;
  readonly clientId: string;
  readonly secretId: string;
  readonly sourceId: string;
  readonly sourceTitle: string;
  /** The connection's tenant, tagged on the input (tenantStreamtag). */
  readonly connectionTenantId: string;
}

/**
 * A constant as a Cribl JavaScript expression: backtick-quoted, with the three
 * characters that could end or interpolate a template literal escaped.
 * InputAzureBlob.queueName "must be a JavaScript expression ... enclosed in
 * quotes or backticks" (cribl-openapi.json).
 */
export function jsStringExpression(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  return `\`${escaped}\``;
}

/**
 * The queue-driven blob input body (D8): clientSecret auth with the lab
 * defaults (lab-cribl.ts:117-150). The account-key connection string is never
 * offered (D7), so there is no `connectionString` field.
 */
export function buildBlobInputBody(spec: BlobInputSpec): Record<string, unknown> {
  return {
    id: spec.id,
    type: "azure_blob" satisfies CriblInputType,
    disabled: false,
    sendToRoutes: true,
    pqEnabled: false,
    streamtags: ["azure", "azure-onboarding", spec.sourceId, tenantStreamtag(spec.connectionTenantId)],
    queueName: jsStringExpression(spec.queueName.trim()),
    fileFilter: "/.*/gm",
    visibilityTimeout: 600,
    numReceivers: 1,
    maxMessages: 1,
    servicePeriodSecs: 5,
    skipOnError: false,
    staleChannelFlushMs: 10000,
    parquetChunkSizeMB: 5,
    parquetChunkDownloadTimeout: 600,
    authType: "clientSecret",
    storageAccountName: spec.storageAccount.trim(),
    tenantId: spec.tenantId,
    clientId: spec.clientId,
    clientTextSecret: spec.secretId,
    description: stampDescription(
      `Azure onboarding: ${spec.sourceTitle} from ${spec.storageAccount.trim()}`,
      APP_ID,
    ),
  };
}

/**
 * The fields that make an existing input THE SAME input, per type. A dotted
 * name reads a nested field. classifyExistingInput compares only these:
 * Cribl adds defaults on save, so a whole-object compare would always differ.
 * Every field the builders set explicitly that changes what the input does -
 * whether it runs, whether its events reach routes, and its auth and TLS
 * posture - is listed, so a hand edit to any of them reads as `differs`, not
 * as already applied. The SAS and the OAuth fields are both listed: a field
 * the body does not set compares as absent on both sides, so a SAS input where
 * an Entra ID one is planned (or the reverse) differs by name (AZR-59).
 */
export const IDENTITY_FIELDS: Readonly<Record<CriblInputType, readonly string[]>> = {
  eventhub: [
    "type",
    "disabled",
    "sendToRoutes",
    "brokers",
    "topics",
    "groupId",
    "sasl.disabled",
    "sasl.mechanism",
    "sasl.authType",
    "sasl.username",
    "sasl.textSecret",
    "sasl.oauthEndpoint",
    "sasl.tenantId",
    "sasl.clientId",
    "sasl.clientSecretAuthType",
    "sasl.clientTextSecret",
    "sasl.scope",
    "tls.disabled",
    "tls.rejectUnauthorized",
  ],
  azure_blob: [
    "type",
    "disabled",
    "sendToRoutes",
    "queueName",
    "storageAccountName",
    "tenantId",
    "clientId",
    "authType",
    "clientTextSecret",
  ],
};
