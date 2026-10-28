/**
 * Validate requests - WHAT AZURE IS ASKED, PER CHECK, AND NOTHING ELSE.
 *
 * Validate (AZR-32) is READ-ONLY BY CONSTRUCTION. Every request this module
 * builds is a GET, and it never builds a listKeys POST (ADR 0005, "Validate
 * never calls listKeys"): a key is not evidence of configuration, and fetching
 * one to "check" a rule would put a secret through a read-only feature. The
 * pin in requests.test.ts walks every check kind with full values and asserts
 * the method of every request.
 *
 * NOTHING IS RETYPED. Paths and api-versions come from the builders that
 * already own them: eventhub-arm (namespace, hubs, rules, consumer group),
 * defender-plans and defender-automation, entra-diagnostic-setting (the path
 * form), logging-map-requests (policy assignments, definitions, role
 * assignments), lab-storage (account, container, queue, Event Grid) and
 * lab-flowlogs (Network Watcher, flow log). Where no builder exists, the
 * request is built here and its api-version is marked INFERRED below - it is
 * on ADR 0007's live-verification list.
 *
 * A MISSING VALUE SENDS NOTHING. {@link requestsFor} returns `{missing}` when
 * a plan value the request needs is blank, and the classifier turns that into
 * unknown `missing-value` - never absent, because nothing was asked.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto.
 */

import type { AzureManagementRequest } from "../../ports/azure-management";
import {
  buildHubConsumerGroupGetRequest,
  buildNamespaceAuthRulesListRequest,
  buildNamespaceGetRequest,
  buildNamespaceHubsListRequest,
  eventHubResourceId,
  type NamespaceRef,
} from "../eventhub-arm/eventhub-arm";
import { buildPricingsListRequest } from "../defender-export/defender-plans";
import { buildSubscriptionAutomationsListRequest } from "../defender-export/defender-automation";
import { listSettingsRequest } from "../entra-diagnostics/entra-diagnostic-setting";
import { ENTRA_CATEGORIES } from "../entra-diagnostics/entra-categories";
import {
  assignmentsAtScopeRequest,
  definitionRequest,
  roleAssignmentsForPrincipalRequest,
} from "../logging-map/logging-map-requests";
import { LEGACY_WRITER } from "../logging-map/ownership";
import {
  LAB_EVENT_GRID_API_VERSION,
  LAB_PROVIDERS_API_VERSION,
  buildBlobContainerGetRequest,
  buildStorageAccountGetRequest,
  buildStorageQueueGetRequest,
  buildSystemTopicGetRequest,
} from "../labs/lab-storage";
import {
  AZURE_NETWORK_WATCHER_RG,
  buildFlowLogGetRequest,
  buildNetworkWatcherGetRequest,
} from "../labs/lab-flowlogs";
import { metricsRequest } from "../eventhub-discovery/eventhub-discovery";
import type { CheckKind } from "../onboarding-howto/check-kinds";
import { missingValues, type PlanValueKey, type PlanValues } from "../onboarding-howto/plan-values";
import { onboardingSource, type OnboardingSourceId } from "../onboarding-howto/sources";

/**
 * api-version for subscription diagnostic settings (the Activity Log export).
 * INFERRED: the current stable Microsoft.Insights diagnosticSettings version;
 * on the live-verification list.
 */
export const SUBSCRIPTION_DIAGNOSTIC_SETTINGS_API_VERSION = "2021-05-01-preview";

/** api-version for Microsoft.PolicyInsights remediations. INFERRED; live list. */
export const POLICY_REMEDIATIONS_API_VERSION = "2021-10-01";

/**
 * The window Azure Monitor totals IncomingMessages over when the request
 * carries no timespan. INFERRED (Azure documents a one-hour default); core
 * reads no clock, so a caller that wants another window passes its own.
 */
export const DEFAULT_ARRIVAL_WINDOW = "PT1H";

/** The Defender for Cloud resource provider Validate checks registration of. */
export const SECURITY_PROVIDER_NAMESPACE = "Microsoft.Security";

/**
 * Built-in roles the Cribl principal needs on the flow-log storage account for
 * an azure_blob source that reads a queue. INFERRED from the Cribl azure_blob
 * source documentation (read blobs, read and delete queue messages); on the
 * live-verification list. Keyed by role definition GUID, which is what a role
 * assignment carries.
 */
export const STORAGE_READER_ROLES: readonly { readonly guid: string; readonly roleName: string }[] = [
  { guid: "2a2b9908-6ea1-4ae2-8e65-a410df84e7d1", roleName: "Storage Blob Data Reader" },
  {
    guid: "8a0f0c08-91a1-4084-bc3d-661d67233fed",
    roleName: "Storage Queue Data Message Processor",
  },
];

/** What a policy-based source is expected to have assigned. */
export interface PolicyExpectation {
  /** Full id of the policy set definition the assignment must use. */
  readonly definitionId: string;
  /** The exact assignment name the steps instruct, or null when legacy varied it. */
  readonly assignmentName: string | null;
  /** The family of names the legacy writer used for this initiative. */
  readonly assignmentFamily: RegExp;
}

/**
 * Per-source facts a check needs beyond the plan values. Built by
 * {@link checkExpectationsFor}; every field is optional because each matters
 * to a few check kinds only.
 */
export interface CheckExpectations {
  /** eh-hub: the exact hubs the source writes to (named or known auto-created). */
  readonly expectedHubs?: readonly string[];
  /** eh-hub: the prefix of hubs Azure creates itself when names are not known. */
  readonly expectedHubPrefix?: string;
  /** entra-setting: the categories the plan enables. */
  readonly entraCategories?: readonly string[];
  /** policy-*: the initiative the plan assigns. */
  readonly policy?: PolicyExpectation;
}

/** How a request's response is read: a list (paged) or one resource. */
export type CheckReadShape = "list" | "single";

/** One GET a check makes, and how its response is to be read. */
export interface CheckRequest {
  readonly request: AzureManagementRequest;
  readonly shape: CheckReadShape;
  /** Prefix for refusal texts and logs. */
  readonly context: string;
}

/** The requests for one check, or the plan values it is missing. */
export type CheckRequests =
  | { readonly kind: "requests"; readonly requests: readonly CheckRequest[] }
  | { readonly kind: "missing"; readonly missing: readonly PlanValueKey[] };

const SUB_RG_NS: readonly PlanValueKey[] = ["subscriptionId", "resourceGroup", "namespace"];
const STORAGE: readonly PlanValueKey[] = ["subscriptionId", "resourceGroup", "storageAccount"];

/** The plan values each check kind needs before it may send anything. */
export const CHECK_REQUIRED_VALUES: Readonly<Record<CheckKind, readonly PlanValueKey[]>> = {
  "eh-namespace": SUB_RG_NS,
  "eh-hub": SUB_RG_NS,
  "eh-rule-send": [...SUB_RG_NS, "sendRule"],
  "eh-rule-listen": [...SUB_RG_NS, "listenRule"],
  "eh-consumer-group": [...SUB_RG_NS, "hubName", "consumerGroup"],
  "defender-plans": ["subscriptionId"],
  "defender-provider": ["subscriptionId"],
  "defender-export": [...SUB_RG_NS, "hubName"],
  "entra-setting": SUB_RG_NS,
  "activity-log-setting": SUB_RG_NS,
  "policy-assignment": ["managementGroupId"],
  "policy-set-definition": ["managementGroupId"],
  "policy-identity-roles": [],
  "policy-remediation": ["managementGroupId"],
  "xdr-streaming": [],
  "network-watcher": ["subscriptionId", "networkWatcher"],
  "flow-log": ["subscriptionId", "networkWatcher", "flowLogName"],
  "storage-account": STORAGE,
  "storage-container": [...STORAGE, "container"],
  "storage-queue": [...STORAGE, "queueName"],
  // storageAccount: the topic is checked against the plan's account (DBT-167).
  "eventgrid-topic": [...STORAGE, "systemTopic"],
  // storageAccount: the subscription's queue and topic are checked against
  // the plan's account (DBT-179), as the topic's source is (DBT-167).
  "eventgrid-subscription": [...STORAGE, "systemTopic", "queueName"],
  "storage-rbac": [...STORAGE, "criblPrincipalObjectId"],
};

function v(values: PlanValues, key: PlanValueKey): string {
  return (values[key] ?? "").trim();
}

/** The namespace the plan names. Only meaningful once SUB_RG_NS are set. */
export function planNamespace(values: PlanValues): NamespaceRef {
  return {
    subscriptionId: v(values, "subscriptionId"),
    resourceGroup: v(values, "resourceGroup"),
    name: v(values, "namespace"),
  };
}

/** The ARM path of the plan's storage account. */
export function planStorageAccountId(values: PlanValues): string {
  return (
    `/subscriptions/${v(values, "subscriptionId")}/resourceGroups/${v(values, "resourceGroup")}` +
    `/providers/Microsoft.Storage/storageAccounts/${v(values, "storageAccount")}`
  );
}

/** The ARM path of a management group. */
export function managementGroupScope(managementGroupId: string): string {
  return `/providers/Microsoft.Management/managementGroups/${managementGroupId.trim()}`;
}

/** The community initiative's set definition id at a management group (Community:131). */
export function communitySetDefinitionId(managementGroupId: string): string {
  return (
    `${managementGroupScope(managementGroupId)}` +
    `/providers/Microsoft.Authorization/policySetDefinitions/${LEGACY_WRITER.communitySetName}`
  );
}

/** The assignment name the How-to steps instruct for the built-in Audit initiative. */
export const AUDIT_ASSIGNMENT_NAME = "Cribl-AU-Central";

function list(request: AzureManagementRequest, context: string): CheckRequest {
  return { request, shape: "list", context };
}

function single(request: AzureManagementRequest, context: string): CheckRequest {
  return { request, shape: "single", context };
}

function insightsHub(category: string): string {
  return `insights-logs-${category.toLowerCase()}`;
}

/**
 * The expectations one source brings to its checks, from the source catalog
 * and the plan values. Nothing here is a measurement.
 */
export function checkExpectationsFor(
  sourceId: OnboardingSourceId,
  values: PlanValues,
  subSelection: readonly string[] = [],
): CheckExpectations {
  const source = onboardingSource(sourceId);
  if (source === undefined) return {};
  const expectedHubs = source.expectedHubNames(values, subSelection);
  const hubs: CheckExpectations = {
    ...(expectedHubs.length > 0 ? { expectedHubs } : {}),
    ...(source.autoCreatedHubPrefix !== null
      ? { expectedHubPrefix: source.autoCreatedHubPrefix }
      : {}),
  };
  switch (sourceId) {
    case "diagnosticSettingsInitiative":
      return {
        ...hubs,
        policy: {
          definitionId: LEGACY_WRITER.builtInSetIds.audit,
          assignmentName: AUDIT_ASSIGNMENT_NAME,
          assignmentFamily: /^Cribl-AU-.+$/i,
        },
      };
    case "communityPolicyInitiative": {
      const mg = v(values, "managementGroupId");
      return mg === ""
        ? hubs
        : {
            ...hubs,
            policy: {
              definitionId: communitySetDefinitionId(mg),
              assignmentName: null,
              assignmentFamily: /^Cribl-Diag-EH-.+$/i,
            },
          };
    }
    case "entraId":
      // The categories are the ones whose auto-created hub the source expects,
      // so the profile is resolved in exactly one place (the source catalog).
      return {
        ...hubs,
        entraCategories: ENTRA_CATEGORIES.map((c) => c.name).filter((name) =>
          expectedHubs.includes(insightsHub(name)),
        ),
      };
    default:
      return hubs;
  }
}

function requestList(kind: CheckKind, values: PlanValues, ex: CheckExpectations): CheckRequest[] {
  const ns = planNamespace(values);
  const sub = v(values, "subscriptionId");
  const rg = v(values, "resourceGroup");
  const account = v(values, "storageAccount");
  const mg = v(values, "managementGroupId");
  switch (kind) {
    case "eh-namespace":
      return [single(buildNamespaceGetRequest(ns), `Event Hub namespace ${ns.name}`)];
    case "eh-hub":
      return [list(buildNamespaceHubsListRequest(ns), `hubs in ${ns.name}`)];
    case "eh-rule-send":
    case "eh-rule-listen":
      return [list(buildNamespaceAuthRulesListRequest(ns), `access rules on ${ns.name}`)];
    case "eh-consumer-group":
      return [
        single(
          buildHubConsumerGroupGetRequest(ns, v(values, "hubName"), v(values, "consumerGroup")),
          `consumer group ${v(values, "consumerGroup")}`,
        ),
      ];
    case "defender-plans":
      return [list(buildPricingsListRequest(sub), `Defender plans on ${sub}`)];
    case "defender-provider":
      return [
        single(
          {
            method: "GET",
            path: `/subscriptions/${sub}/providers/${SECURITY_PROVIDER_NAMESPACE}`,
            apiVersion: LAB_PROVIDERS_API_VERSION,
          },
          `${SECURITY_PROVIDER_NAMESPACE} registration on ${sub}`,
        ),
      ];
    case "defender-export":
      return [list(buildSubscriptionAutomationsListRequest(sub), `continuous exports on ${sub}`)];
    case "entra-setting":
      return [list(listSettingsRequest(), "Entra ID diagnostic settings")];
    case "activity-log-setting":
      return [
        list(
          {
            method: "GET",
            path: `/subscriptions/${sub}/providers/Microsoft.Insights/diagnosticSettings`,
            apiVersion: SUBSCRIPTION_DIAGNOSTIC_SETTINGS_API_VERSION,
          },
          `Activity Log diagnostic settings on ${sub}`,
        ),
      ];
    case "policy-assignment":
      return ex.policy === undefined
        ? []
        : [list(assignmentsAtScopeRequest(managementGroupScope(mg)), `policy assignments at ${mg}`)];
    case "policy-set-definition":
      return ex.policy === undefined
        ? []
        : [single(definitionRequest(ex.policy.definitionId), "policy set definition")];
    case "policy-remediation":
      return ex.policy === undefined
        ? []
        : [
            list(
              {
                method: "GET",
                path: `${managementGroupScope(mg)}/providers/Microsoft.PolicyInsights/remediations`,
                apiVersion: POLICY_REMEDIATIONS_API_VERSION,
              },
              `policy remediations at ${mg}`,
            ),
          ];
    case "policy-identity-roles":
    case "xdr-streaming":
      // Nothing is read: see classify.ts for why each is unknown.
      return [];
    case "network-watcher":
      return [
        single(
          buildNetworkWatcherGetRequest(sub, AZURE_NETWORK_WATCHER_RG, v(values, "networkWatcher")),
          `Network Watcher ${v(values, "networkWatcher")}`,
        ),
      ];
    case "flow-log":
      return [
        single(
          buildFlowLogGetRequest(
            sub,
            AZURE_NETWORK_WATCHER_RG,
            v(values, "networkWatcher"),
            v(values, "flowLogName"),
          ),
          `flow log ${v(values, "flowLogName")}`,
        ),
      ];
    case "storage-account":
      return [single(buildStorageAccountGetRequest(sub, rg, account), `storage account ${account}`)];
    case "storage-container":
      return [
        single(
          buildBlobContainerGetRequest(sub, rg, account, v(values, "container")),
          `container ${v(values, "container")}`,
        ),
      ];
    case "storage-queue":
      return [
        single(
          buildStorageQueueGetRequest(sub, rg, account, v(values, "queueName")),
          `queue ${v(values, "queueName")}`,
        ),
      ];
    case "eventgrid-topic":
      return [
        single(
          buildSystemTopicGetRequest(sub, rg, v(values, "systemTopic")),
          `Event Grid system topic ${v(values, "systemTopic")}`,
        ),
      ];
    case "eventgrid-subscription":
      return [
        list(
          {
            method: "GET",
            path:
              `/subscriptions/${sub}/resourceGroups/${rg}` +
              `/providers/Microsoft.EventGrid/systemTopics/${v(values, "systemTopic")}/eventSubscriptions`,
            apiVersion: LAB_EVENT_GRID_API_VERSION,
          },
          `event subscriptions on ${v(values, "systemTopic")}`,
        ),
      ];
    case "storage-rbac":
      return [
        list(
          roleAssignmentsForPrincipalRequest(
            planStorageAccountId(values),
            v(values, "criblPrincipalObjectId"),
          ),
          `role assignments of the Cribl principal on ${account}`,
        ),
      ];
  }
}

/**
 * The GETs one check makes, in the order {@link classifyCheck} expects their
 * reads. `{missing}` when a needed plan value is blank: nothing is sent.
 * An EMPTY request list (xdr-streaming, policy-identity-roles, a policy
 * check with no expected initiative) is not a failure - the classifier says
 * why there is nothing to read.
 */
export function requestsFor(
  kind: CheckKind,
  values: PlanValues,
  expectations: CheckExpectations = {},
): CheckRequests {
  const missing = missingValues(values, CHECK_REQUIRED_VALUES[kind]);
  if (missing.length > 0) return { kind: "missing", missing };
  return { kind: "requests", requests: requestList(kind, values, expectations) };
}

/** The arrival request for one hub, and the window its total covers. */
export type ArrivalRequest =
  | { readonly kind: "request"; readonly request: AzureManagementRequest; readonly window: string }
  | { readonly kind: "missing"; readonly missing: readonly PlanValueKey[] };

/**
 * The Azure Monitor IncomingMessages GET for one hub of the plan's namespace
 * (the metrics builder eventhub-discovery already owns). `timespan` is
 * "{startISO}/{endISO}" minted by a caller that has a clock; without one, no
 * timespan is sent and Azure's default window applies.
 */
export function arrivalRequestFor(
  values: PlanValues,
  hub: string,
  timespan?: string,
): ArrivalRequest {
  const missing = missingValues(values, SUB_RG_NS);
  if (missing.length > 0) return { kind: "missing", missing };
  const base = metricsRequest(eventHubResourceId(planNamespace(values), hub), timespan ?? "");
  const query = { ...(base.query ?? {}) };
  if (timespan === undefined || timespan.trim() === "") delete query["timespan"];
  return {
    kind: "request",
    request: { ...base, query },
    window: timespan !== undefined && timespan.trim() !== "" ? timespan : DEFAULT_ARRIVAL_WINDOW,
  };
}
