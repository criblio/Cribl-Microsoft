/**
 * Plan values - THE NAMES A HOW-TO STEP IS WRITTEN AGAINST.
 *
 * A guided step says "create the hub <hubName> in <namespace>". These are those
 * placeholders, filled once by the operator and applied to every step (D4).
 * They are persisted in the progress document, so every value here is a NAME or
 * an ID and never a credential: no key, no connection string, no secret. The
 * Event Hub credential travels only through the confirmed Cribl apply (D7).
 *
 * DEFAULTS THAT MATTER. consumerGroup defaults to `cribl`, never `$Default`:
 * `$Default` shares partitions with every other reader of the hub
 * and readers in one group split the partitions (the legacy generator's
 * EH_DEFAULT_CONSUMER_GROUP, eventhub-discovery.ts), so each would see only part
 * of the stream. container defaults to the VNet flow-log container Azure writes.
 *
 * STALE TICKS (D5). A done tick records the values its step depended on;
 * {@link planFingerprint} is their canonical JSON, so a later change to any of
 * those keys - and only those - makes the tick stale. Canonical JSON, not a
 * hash: core may not use crypto, and the values are short names anyway.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto.
 */

import type { AzureConfig } from "../azure-config";

/** Every plan value key, in display order. */
export const PLAN_VALUE_KEYS = [
  "subscriptionId",
  "managementGroupId",
  "resourceGroup",
  "region",
  // AZR-102: where the Event Hub namespace lives. Blank means the
  // subscription and resource group above (eventHubLocation), so a plan saved
  // before these existed addresses its namespace exactly as it did.
  "eventHubSubscriptionId",
  "eventHubResourceGroup",
  "namespace",
  "hubName",
  "sendRule",
  "listenRule",
  "consumerGroup",
  "storageAccount",
  "container",
  "queueName",
  "systemTopic",
  "networkWatcher",
  "flowLogName",
  "criblPrincipalObjectId",
  // AZR-59, ADR 0008 section 2: the DEDICATED Cribl principal the Event Hub
  // source signs in as. Ids only; its client secret is never a plan value.
  "criblTenantId",
  "criblClientId",
] as const;

export type PlanValueKey = (typeof PLAN_VALUE_KEYS)[number];

/**
 * The plan values that name the Event Hub the sources send to (AZR-102): the
 * namespace's own subscription and resource group, the namespace, the hub and
 * the Send rule. The screen's Event Hub picker (section 1) writes exactly these
 * unless the operator chose their own (progress-document
 * eventHubFollowsSection1). The SHARED subscriptionId and resourceGroup are
 * never among them: storage, Defender, flow-log and policy steps read those,
 * and they stay the operator's.
 */
export const EVENT_HUB_PLAN_KEYS = [
  "eventHubSubscriptionId",
  "eventHubResourceGroup",
  "namespace",
  "hubName",
  "sendRule",
] as const satisfies readonly PlanValueKey[];

/** One string per key; `''` means unset. */
export type PlanValues = Readonly<Record<PlanValueKey, string>>;

/**
 * Where the Event Hub namespace lives: its own subscription and resource
 * group, or the shared ones when those are blank. Every Event Hub address the
 * app builds from the plan (steps, Validate, the Cribl source) goes through
 * this.
 */
export function eventHubLocation(
  v: Pick<PlanValues, "subscriptionId" | "resourceGroup" | "eventHubSubscriptionId" | "eventHubResourceGroup">,
): { readonly subscriptionId: string; readonly resourceGroup: string } {
  const sub = (v.eventHubSubscriptionId ?? "").trim();
  const rg = (v.eventHubResourceGroup ?? "").trim();
  return { subscriptionId: sub !== "" ? sub : v.subscriptionId, resourceGroup: rg !== "" ? rg : v.resourceGroup };
}

/** The values with the two Event Hub location keys resolved by {@link eventHubLocation}, for rendering a step. */
export function withEventHubLocation(v: PlanValues): PlanValues {
  const loc = eventHubLocation(v);
  return { ...v, eventHubSubscriptionId: loc.subscriptionId, eventHubResourceGroup: loc.resourceGroup };
}

/**
 * The shared key each namespace location key falls back to (eventHubLocation),
 * and the canonical name a fingerprint records it under. A tick taken before
 * these keys existed fingerprinted the shared subscription and resource group;
 * recording the resolved location under those names reproduces it exactly, so
 * an upgrade does not mark every done Event Hub step stale. With the key blank,
 * changing the shared value still moves the namespace, and the tick goes stale.
 */
const BLANK_MEANS: Readonly<Partial<Record<PlanValueKey, PlanValueKey>>> = {
  eventHubSubscriptionId: "subscriptionId",
  eventHubResourceGroup: "resourceGroup",
};

/** The consumer group a Cribl input reads with by default. Never `$Default`. */
export const DEFAULT_CONSUMER_GROUP = "cribl";

/** The container Azure writes VNet flow logs to. */
export const DEFAULT_FLOW_LOG_CONTAINER = "insights-logs-flowlogflowevent";

/** Whether `key` is a plan value key. */
export function isPlanValueKey(key: string): key is PlanValueKey {
  return (PLAN_VALUE_KEYS as readonly string[]).includes(key);
}

/**
 * A value that looks like a credential is refused as a plan value: a pasted
 * connection string in the namespace field would otherwise be persisted to KV
 * in clear. Returns `''` for such a value, the value otherwise.
 *
 * It matches the credential SHAPE (`SharedAccessKey=`, `AccountKey=`,
 * `password=`, `Endpoint=sb:`), never a bare name substring: Azure's built-in
 * rule is NAMED `RootManageSharedAccessKey`, and an operator whose existing
 * Listen-capable rule is that one must be able to record it. The how-to text
 * never instructs using that rule; recording an existing one is a name, not a key.
 */
const CREDENTIAL_SHAPE = /SharedAccessKey\s*=|AccountKey\s*=|password\s*=|Endpoint\s*=\s*sb:/i;

export function sanitizePlanValue(value: string): string {
  return CREDENTIAL_SHAPE.test(value) ? "" : value;
}

/**
 * The starting values: the subscription and resource group the app is already
 * configured with, the two defaults above, and every other key unset.
 */
export function defaultPlanValues(
  config: Pick<AzureConfig, "subscriptionId" | "resourceGroup"> | null,
): PlanValues {
  const values = Object.fromEntries(PLAN_VALUE_KEYS.map((k) => [k, ""])) as Record<
    PlanValueKey,
    string
  >;
  values.subscriptionId = config?.subscriptionId ?? "";
  values.resourceGroup = config?.resourceGroup ?? "";
  values.consumerGroup = DEFAULT_CONSUMER_GROUP;
  values.container = DEFAULT_FLOW_LOG_CONTAINER;
  return values;
}

/**
 * Canonical JSON of the listed keys' values: keys de-duplicated and sorted,
 * values trimmed. Same values for those keys, same string - whatever any other
 * key holds.
 */
export function planFingerprint(values: PlanValues, keys: readonly PlanValueKey[]): string {
  // An Event Hub location key is fingerprinted by its RESOLVED value under ONE
  // canonical name, its shared key's (AZR-102 re-review): whether the plan
  // names the namespace's resource group itself or leaves it to the shared one,
  // the same address gives the same fingerprint, and a tick recorded before
  // these keys existed (which used the shared names) still matches.
  const entries = [...new Set(keys)].map((k): [string, string] => {
    const shared = BLANK_MEANS[k];
    if (shared === undefined) return [k, planValueOf(values, k)];
    const own = planValueOf(values, k);
    return [shared, own !== "" ? own : planValueOf(values, shared)];
  });
  const unique = [...new Map(entries.map((e) => [JSON.stringify(e), e])).values()];
  unique.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return JSON.stringify(unique);
}

/** A plan value as every comparison reads it: unset is "", and spaces at either end do not count. */
function planValueOf(values: Partial<PlanValues>, key: PlanValueKey): string {
  return (values[key] ?? "").trim();
}

/**
 * The listed keys whose value differs between `a` and `b`, in the order given.
 * THE one has-this-value-changed rule (AZR-49): a How-to tick's staleness and a
 * Validate result's staleness both ask it, so a step can never read done while
 * its check reads stale over a difference only one of them counts.
 */
export function changedValueKeys(
  a: Partial<PlanValues>,
  b: Partial<PlanValues>,
  keys: readonly PlanValueKey[],
): readonly PlanValueKey[] {
  return keys.filter((k) => planValueOf(a, k) !== planValueOf(b, k));
}

/** The listed keys that are unset (blank after trimming), in the order given. */
export function missingValues(
  values: PlanValues,
  keys: readonly PlanValueKey[],
): readonly PlanValueKey[] {
  return [...new Set(keys)].filter((k) => (values[k] ?? "").trim() === "");
}

/** The visible label and the (i) text for one plan value. */
export interface PlanValueLabel {
  readonly label: string;
  readonly info: string;
}

/** Visible copy: no card ids, no dates. */
export const PLAN_VALUE_LABELS: Readonly<Record<PlanValueKey, PlanValueLabel>> = {
  subscriptionId: {
    label: "Subscription ID",
    info: "The Azure subscription that holds the storage account, and whose Activity Log and Defender alerts are exported. It holds the Event Hub namespace too unless Event Hub subscription ID names another.",
  },
  managementGroupId: {
    label: "Management group ID",
    info: "The management group the policy initiatives are assigned at. Needed only for the policy-based sources.",
  },
  resourceGroup: {
    label: "Resource group",
    info: "The resource group that holds the storage account and the Defender export. It holds the Event Hub namespace too unless Event Hub resource group names another.",
  },
  region: {
    label: "Region",
    info: "The Azure region of the namespace or storage account, for example eastus. Diagnostic settings can only send to a namespace in the same region as the resource.",
  },
  eventHubSubscriptionId: {
    label: "Event Hub subscription ID",
    info: "The subscription that holds the Event Hub namespace. Leave it blank when that is the Subscription ID above.",
  },
  eventHubResourceGroup: {
    label: "Event Hub resource group",
    info: "The resource group that holds the Event Hub namespace. Leave it blank when that is the Resource group above.",
  },
  namespace: {
    label: "Event Hub namespace",
    info: "The namespace name only, without .servicebus.windows.net. It must be Standard tier or higher, because Cribl reads Event Hubs over the Kafka protocol.",
  },
  hubName: {
    label: "Event Hub name",
    info: "The hub a named exporter writes to. Sources that let Azure create their own hubs ignore it.",
  },
  sendRule: {
    label: "Send rule",
    info: "The shared access rule Azure uses to WRITE to the hub. It needs Send rights, or Manage when Azure creates the hubs itself (Entra ID and Activity Log diagnostic settings, the policy initiatives). Do not use RootManageSharedAccessKey.",
  },
  listenRule: {
    label: "Listen rule",
    info: "The shared access rule Cribl uses to READ the hub. It needs Listen rights. A Send-only rule cannot be used by the Cribl source.",
  },
  consumerGroup: {
    label: "Consumer group",
    info: "The consumer group Cribl reads with. Use a dedicated group, not $Default, so Cribl does not share partitions with another reader.",
  },
  storageAccount: {
    label: "Storage account",
    info: "The storage account flow logs are written to.",
  },
  container: {
    label: "Blob container",
    info: "The container Azure writes flow logs to. Azure names it; change it only if yours differs.",
  },
  queueName: {
    label: "Storage queue",
    info: "The queue Event Grid posts a message to for every new blob. Cribl reads the queue to find new files.",
  },
  systemTopic: {
    label: "Event Grid system topic",
    info: "The storage account's Event Grid system topic that publishes blob-created events to the queue.",
  },
  networkWatcher: {
    label: "Network Watcher",
    info: "The Network Watcher in the flow log's region, which owns the flow log resource.",
  },
  flowLogName: {
    label: "Flow log name",
    info: "The name of the flow log resource under the Network Watcher.",
  },
  criblPrincipalObjectId: {
    label: "Cribl service principal object ID",
    info: "The object ID (not the client ID) of the service principal Cribl authenticates as. It is granted read access to the storage account and queue, and Azure Event Hubs Data Receiver on the hub.",
  },
  criblTenantId: {
    label: "Cribl service principal tenant ID",
    info: "The Entra tenant (directory) ID the Cribl service principal belongs to. The Event Hub source signs in to this tenant.",
  },
  criblClientId: {
    label: "Cribl service principal client ID",
    info: "The application (client) ID of a service principal dedicated to Cribl, not this app's own registration: anyone who can read the worker group's secrets can use its secret.",
  },
};
