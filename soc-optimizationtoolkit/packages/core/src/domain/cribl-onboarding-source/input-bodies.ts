/**
 * Cribl INPUT and SECRET bodies for the onboarding source (AZR-34, ADR 0007 D8).
 *
 * THE EVENT HUB INPUT TYPE IS `eventhub`. `azure_eventhub` is the DESTINATION
 * type (live-architecture.ts:643,652); the vendored OpenAPI InputEventhub has
 * `type: enum ["eventhub"]` (packages/core/assets/cribl-openapi.json). The
 * blob source is the queue-driven `azure_blob` (InputAzureBlob, required
 * `type` + `queueName`).
 *
 * NO SECRET IN A BODY. The Event Hub input names its connection string through
 * `sasl.textSecret` (authType 'secret') and never carries `sasl.password`; the
 * blob input names its client secret through `clientTextSecret`. The only body
 * that carries a credential is {@link buildSecretBody}, which goes to
 * POST /system/secrets and nowhere else. No body carries `_metadata` (the
 * legacy template's buildEventHubSourceConfig does, eventhub-discovery.ts).
 *
 * `secretType`, NEVER `type`: RestSecret requires `id` and `secretType`
 * (cribl-openapi.json RestSecret.required). The older secret writers send
 * `type` (a filed bug card, not fixed here).
 *
 * Every body is stamped with the kit's stampDescription so ownership can be
 * proven later (kit/config-writes/ownership.ts, config-plane-writes rule 11).
 *
 * Pure: no IO, no Date, no randomness, no crypto.
 */

import { stampDescription } from "../../kit/config-writes/ownership";
import type { CriblInputType, OnboardingSource } from "../onboarding-howto/sources";
import type { PlanValues } from "../onboarding-howto/plan-values";

/**
 * The app id the description stamp names: the cribl-app package name
 * (apps/cribl-app/package.json "name"). Changing it orphans every object
 * already stamped, so it is a constant, not configuration.
 */
export const APP_ID = "soc-optimizationtoolkit";

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

function capped(id: string): string {
  return id.length <= ONBOARDING_ID_MAX ? id : id.slice(0, ONBOARDING_ID_MAX);
}

/**
 * The input id for one source lane, or null when a value it needs is unset.
 *
 *   Event Hub  azure_onb_eh_{namespace}_{hub}. For a source whose emitter
 *              names its hub, {hub} is that hub; for one where Azure creates
 *              the hubs itself (several topics on one input), {hub} is the
 *              source id, so the id stays stable as measured hubs appear.
 *   Blob       azure_onb_blob_{storageAccount}_{queue}.
 *
 * Idempotent: the same inputs always give the same id.
 */
export function onboardingInputId(source: OnboardingSource, values: PlanValues): string | null {
  if (source.transport === "blob") {
    const account = values.storageAccount.trim();
    const queue = values.queueName.trim();
    if (account === "" || queue === "") return null;
    return capped(`${ONBOARDING_INPUT_ID_PREFIX}blob_${sanitize(account)}_${sanitize(queue)}`);
  }
  const ns = values.namespace.trim();
  if (ns === "") return null;
  let hubKey: string = source.id;
  if (source.hubNaming === "named") {
    const hub = values.hubName.trim();
    if (hub === "") return null;
    hubKey = hub;
  }
  return capped(`${ONBOARDING_INPUT_ID_PREFIX}eh_${sanitize(ns)}_${sanitize(hubKey)}`);
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

/** The Cribl text secret an input references: one per input, never shared. */
export function onboardingSecretId(inputId: string): string {
  const suffix = "_secret";
  const base = inputId.length + suffix.length <= ONBOARDING_ID_MAX
    ? inputId
    : inputId.slice(0, ONBOARDING_ID_MAX - suffix.length);
  return `${base}${suffix}`;
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
}

/** The Event Hub (Kafka) input body (D8). Carries the secret's NAME only. */
export function buildEventHubInputBody(spec: EventHubInputSpec): Record<string, unknown> {
  const ns = spec.namespace.trim();
  return {
    id: spec.id,
    type: "eventhub" satisfies CriblInputType,
    disabled: false,
    sendToRoutes: true,
    pqEnabled: false,
    streamtags: ["azure", "azure-onboarding", spec.sourceId],
    brokers: [`${ns}.servicebus.windows.net:9093`],
    topics: [...spec.topics],
    groupId: spec.consumerGroup,
    fromBeginning: true,
    sasl: {
      disabled: false,
      mechanism: "plain",
      authType: "secret",
      username: "$ConnectionString",
      textSecret: spec.secretId,
    },
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
    streamtags: ["azure", "azure-onboarding", spec.sourceId],
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
 * The text-secret body for POST /system/secrets. THE ONLY BODY THAT CARRIES A
 * CREDENTIAL. `secretType`, never `type` (RestSecret.required).
 */
export function buildSecretBody(spec: {
  readonly id: string;
  readonly value: string;
  readonly description: string;
}): { id: string; secretType: "text"; value: string; description: string } {
  return {
    id: spec.id,
    secretType: "text",
    value: spec.value,
    description: stampDescription(spec.description, APP_ID),
  };
}

/**
 * The fields that make an existing input THE SAME input, per type. A dotted
 * name reads a nested field. classifyExistingInput compares only these:
 * Cribl adds defaults on save, so a whole-object compare would always differ.
 * Every field the builders set explicitly that changes what the input does -
 * whether it runs, whether its events reach routes, and its auth and TLS
 * posture - is listed, so a hand edit to any of them reads as `differs`, not
 * as already applied.
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
