/**
 * The shared Event Hub steps (P1 to P6) every Event Hub source starts with.
 *
 * Content follows the eventhub-arm builders the automated path and the labs
 * use (namespace, hub, consumer group and rule paths; one api-version), and
 * the consumer-group default in plan-values (never `$Default`).
 *
 * WHICH SOURCES NEED WHICH STEP is read from the onboarding source catalog's
 * transport and hub naming, never listed by hand:
 *   - every Event Hub source: namespace, Listen rule, networking
 *   - a NAMED hub (Defender export, XDR): create the hub, then its consumer group
 *   - AUTO-CREATED hubs (policy, Activity Log, Entra): a rule Azure can create
 *     hubs with, and a consumer group on each hub once Azure has created it
 *
 * The rule a diagnostic setting writes with is an operator-chosen DEDICATED
 * rule. The built-in namespace rule is never suggested.
 *
 * Pure: data and string building only.
 */

import {
  eventHubNamespacePath,
  eventHubResourceId,
  type NamespaceRef,
} from "../eventhub-arm/eventhub-arm";
import type { PlanValues } from "../onboarding-howto/plan-values";
import { ONBOARDING_SOURCES, type OnboardingSourceId } from "../onboarding-howto/sources";
import type { HowToStep } from "./steps";

/** The namespace the plan values address. */
export function planNamespace(v: PlanValues): NamespaceRef {
  return { subscriptionId: v.subscriptionId, resourceGroup: v.resourceGroup, name: v.namespace };
}

/** The ARM id of the plan's rule `ruleName` on the plan's namespace. */
export function planRuleId(v: PlanValues, ruleName: string): string {
  return `${eventHubNamespacePath(planNamespace(v))}/authorizationRules/${ruleName}`;
}

function idsWhere(pred: (s: (typeof ONBOARDING_SOURCES)[number]) => boolean): OnboardingSourceId[] {
  return ONBOARDING_SOURCES.filter(pred).map((s) => s.id);
}

/** Every Event Hub source. */
export const EVENTHUB_SOURCE_IDS = idsWhere((s) => s.transport === "eventhub");
/** Event Hub sources whose hub is named by the operator. */
export const NAMED_HUB_SOURCE_IDS = idsWhere(
  (s) => s.transport === "eventhub" && (s.hubNaming === "named" || s.hubNaming === "portal"),
);
/** Event Hub sources whose emitter writes with a connection string it is given. */
export const CONNECTION_STRING_SOURCE_IDS = idsWhere(
  (s) => s.transport === "eventhub" && s.emitterKind === "defender-export",
);
/** Event Hub sources whose hubs Azure creates itself. */
export const AUTO_HUB_SOURCE_IDS = idsWhere(
  (s) => s.transport === "eventhub" && s.hubNaming === "auto-created",
);

const NS_WRITE = "Microsoft.EventHub/namespaces/write on the resource group (Contributor includes it).";

export const EVENTHUB_STEPS: readonly HowToStep[] = [
  {
    id: "eh-namespace",
    sourceIds: EVENTHUB_SOURCE_IDS,
    title: "Create or pick the Event Hub namespace {{namespace}}",
    why: "Azure writes the logs to a hub in this namespace and Cribl reads them from it over the Kafka protocol, which needs the Standard tier or higher. Diagnostic settings can only write to a namespace in the same region as the resource, so it lives in {{region}}.",
    portal: [
      "Open Event Hubs in the Azure portal and select Create.",
      "Subscription {{subscriptionId}}, resource group {{resourceGroup}}, namespace name {{namespace}}, location {{region}}.",
      "Pricing tier: Standard (or Premium). Basic cannot be read by Cribl.",
      "Review and create. If the namespace already exists, open it and check its pricing tier instead.",
    ],
    cli: "az eventhubs namespace create --subscription {{subscriptionId}} --resource-group {{resourceGroup}} --name {{namespace}} --location {{region}} --sku Standard",
    values: (v) => [
      { label: "Namespace resource ID", value: eventHubNamespacePath(planNamespace(v)) },
      { label: "Kafka endpoint Cribl connects to", value: `${v.namespace}.servicebus.windows.net:9093` },
      { label: "Pricing tier", value: "Standard or Premium" },
    ],
    rbac: [NS_WRITE],
    confirmHow: "The namespace {{namespace}} shows Status Active and Pricing tier Standard or Premium on its Overview page.",
    dependsOnValues: ["subscriptionId", "resourceGroup", "namespace", "region"],
    checkKinds: ["eh-namespace"],
    provenance: "repo",
  },
  {
    id: "eh-hub",
    sourceIds: NAMED_HUB_SOURCE_IDS,
    title: "Create the Event Hub {{hubName}}",
    why: "This source writes to one hub that you name. Cribl reads that hub as a Kafka topic of the same name.",
    portal: [
      "Open the namespace {{namespace}} and select Event Hubs, then + Event Hub.",
      "Name: {{hubName}}. Keep the default partition count unless you expect very high volume.",
      "Create.",
    ],
    cli: "az eventhubs eventhub create --subscription {{subscriptionId}} --resource-group {{resourceGroup}} --namespace-name {{namespace}} --name {{hubName}}",
    values: (v) => [
      { label: "Hub resource ID", value: eventHubResourceId(planNamespace(v), v.hubName) },
      { label: "Kafka topic", value: v.hubName },
    ],
    rbac: ["Microsoft.EventHub/namespaces/eventhubs/write on the namespace (Contributor includes it)."],
    confirmHow: "The hub {{hubName}} is listed under Event Hubs in the namespace {{namespace}}.",
    dependsOnValues: ["subscriptionId", "resourceGroup", "namespace", "hubName"],
    checkKinds: ["eh-hub"],
    provenance: "repo",
  },
  {
    id: "eh-rule-send",
    sourceIds: CONNECTION_STRING_SOURCE_IDS,
    title: "Create the rule {{sendRule}} that Azure writes with",
    why: "The export is given a connection string to write to the hub, taken from a namespace shared access rule that can Send. Use a dedicated Send-only rule, not the namespace's built-in one, so the exporter can write but never read or manage.",
    portal: [
      "Open the namespace {{namespace}} and select Shared access policies, then + Add.",
      "Policy name: {{sendRule}}. Tick Send only.",
      "Create.",
    ],
    cli: "az eventhubs namespace authorization-rule create --subscription {{subscriptionId}} --resource-group {{resourceGroup}} --namespace-name {{namespace}} --name {{sendRule}} --rights Send",
    values: (v) => [
      { label: "Rule resource ID", value: planRuleId(v, v.sendRule) },
      { label: "Rights", value: "Send" },
    ],
    rbac: [
      "Microsoft.EventHub/namespaces/authorizationRules/write on the namespace.",
      "Microsoft.EventHub/namespaces/authorizationRules/listKeys/action, to read the connection string when you create the export.",
    ],
    confirmHow: "The rule {{sendRule}} is listed under Shared access policies with the claim Send.",
    dependsOnValues: ["subscriptionId", "resourceGroup", "namespace", "sendRule"],
    checkKinds: ["eh-rule-send"],
    provenance: "repo",
    warning: "If you also choose a source whose hubs Azure creates itself, this guide replaces this step with one Manage rule of the same name: a Manage rule can also Send, so one rule serves both.",
  },
  {
    id: "eh-rule-diagnostic",
    sourceIds: AUTO_HUB_SOURCE_IDS,
    title: "Create the rule {{sendRule}} that Azure writes with",
    why: "Diagnostic settings write with a namespace shared access rule. Because Azure creates one hub per log category itself, the rule needs Manage as well as Send. Use a dedicated rule, not the namespace's built-in one, so it can be rotated or removed on its own.",
    portal: [
      "Open the namespace {{namespace}} and select Shared access policies, then + Add.",
      "Policy name: {{sendRule}}. Tick Manage (which also selects Send and Listen).",
      "Create.",
    ],
    cli: "az eventhubs namespace authorization-rule create --subscription {{subscriptionId}} --resource-group {{resourceGroup}} --namespace-name {{namespace}} --name {{sendRule}} --rights Manage Send Listen",
    values: (v) => [{ label: "Rule resource ID", value: planRuleId(v, v.sendRule) }],
    rbac: [
      "Microsoft.EventHub/namespaces/authorizationRules/write on the namespace.",
      "Whoever creates the diagnostic setting also needs Microsoft.EventHub/namespaces/authorizationRules/listKeys/action on this rule.",
    ],
    confirmHow: "The rule {{sendRule}} is listed under Shared access policies with the claims Manage, Send, Listen.",
    dependsOnValues: ["subscriptionId", "resourceGroup", "namespace", "sendRule"],
    // 'eh-rule-manage', not 'eh-rule-send': the rule must have Manage, and
    // 'eh-rule-send' accepts Send or Manage, so it would call a Send-only rule
    // done here - a false "done" on the very right this step grants (AZR-39).
    checkKinds: ["eh-rule-manage"],
    provenance: "inferred",
    warning: "If you also onboard the Defender export, this one rule can serve it: a Manage rule can also Send.",
  },
  {
    id: "eh-rule-listen",
    sourceIds: EVENTHUB_SOURCE_IDS,
    title: "Create the rule {{listenRule}} that Cribl reads with",
    why: "The Cribl Event Hub source authenticates with a connection string from a rule that can Listen. A Send-only rule cannot read, so the rule Azure writes with is usually not this one.",
    portal: [
      "Open the namespace {{namespace}} and select Shared access policies, then + Add.",
      "Policy name: {{listenRule}}. Tick Listen only.",
      "Create, then open the rule and copy its Connection string - primary key. You paste it into the Cribl source section of this page; the app stores it as a Cribl secret and never keeps it here.",
    ],
    cli: "az eventhubs namespace authorization-rule create --subscription {{subscriptionId}} --resource-group {{resourceGroup}} --namespace-name {{namespace}} --name {{listenRule}} --rights Listen\naz eventhubs namespace authorization-rule keys list --subscription {{subscriptionId}} --resource-group {{resourceGroup}} --namespace-name {{namespace}} --name {{listenRule}} --query primaryConnectionString --output tsv",
    values: (v) => [
      { label: "Rule resource ID", value: planRuleId(v, v.listenRule) },
      { label: "Rights", value: "Listen" },
    ],
    rbac: [
      "Microsoft.EventHub/namespaces/authorizationRules/write on the namespace.",
      "Microsoft.EventHub/namespaces/authorizationRules/listKeys/action to copy the connection string.",
    ],
    confirmHow: "The rule {{listenRule}} is listed under Shared access policies with the claim Listen.",
    dependsOnValues: ["subscriptionId", "resourceGroup", "namespace", "listenRule"],
    checkKinds: ["eh-rule-listen"],
    provenance: "repo",
  },
  {
    id: "eh-consumer-group",
    sourceIds: NAMED_HUB_SOURCE_IDS,
    title: "Create the consumer group {{consumerGroup}} on {{hubName}}",
    why: "Readers in one consumer group split the hub's partitions between them. A dedicated group for Cribl means no other reader takes part of the stream, which sharing $Default would risk.",
    portal: [
      "Open the hub {{hubName}} in the namespace {{namespace}} and select Consumer groups, then + Consumer group.",
      "Name: {{consumerGroup}}. Create.",
    ],
    cli: "az eventhubs eventhub consumer-group create --subscription {{subscriptionId}} --resource-group {{resourceGroup}} --namespace-name {{namespace}} --eventhub-name {{hubName}} --name {{consumerGroup}}",
    values: (v) => [
      {
        label: "Consumer group resource ID",
        value: `${eventHubResourceId(planNamespace(v), v.hubName)}/consumergroups/${v.consumerGroup}`,
      },
    ],
    rbac: ["Microsoft.EventHub/namespaces/eventhubs/consumergroups/write on the namespace."],
    confirmHow: "The consumer group {{consumerGroup}} is listed on the hub {{hubName}}.",
    dependsOnValues: ["subscriptionId", "resourceGroup", "namespace", "hubName", "consumerGroup"],
    checkKinds: ["eh-consumer-group"],
    provenance: "repo",
  },
  {
    id: "eh-consumer-group-auto",
    sourceIds: AUTO_HUB_SOURCE_IDS,
    title: "Create the consumer group {{consumerGroup}} on each hub Azure creates",
    why: "Azure creates a hub per log category the first time it has something to send, so these hubs do not exist yet when you set the source up. Once each appears, give it a dedicated consumer group for Cribl rather than sharing $Default.",
    portal: [
      "After the first logs arrive, open the namespace {{namespace}} and select Event Hubs. Each hub Azure created is named after its log category.",
      "For each of them: open it, select Consumer groups, then + Consumer group, and name it {{consumerGroup}}.",
      "Run Validate on this page afterwards: the Cribl source reads only the hubs Validate has seen.",
    ],
    cli: "az eventhubs eventhub consumer-group create --subscription {{subscriptionId}} --resource-group {{resourceGroup}} --namespace-name {{namespace}} --eventhub-name <hub Azure created> --name {{consumerGroup}}",
    values: (v) => [
      { label: "Hub list to watch", value: `${eventHubNamespacePath(planNamespace(v))}/eventhubs` },
      { label: "Consumer group", value: v.consumerGroup },
    ],
    rbac: ["Microsoft.EventHub/namespaces/eventhubs/consumergroups/write on the namespace."],
    confirmHow: "Every hub Azure created in {{namespace}} lists the consumer group {{consumerGroup}}.",
    dependsOnValues: ["subscriptionId", "resourceGroup", "namespace", "consumerGroup"],
    checkKinds: ["eh-hub", "eh-consumer-group"],
    provenance: "inferred",
  },
  {
    id: "eh-network",
    sourceIds: EVENTHUB_SOURCE_IDS,
    title: "Confirm Cribl and Azure can both reach {{namespace}}",
    why: "If the namespace restricts network access, Azure services must still be allowed to write and Cribl workers must be allowed to reach port 9093. Nothing here is created; it is a check before you rely on the flow.",
    portal: [
      "Open the namespace {{namespace}} and select Networking.",
      "If public access is disabled or limited to selected networks, add the Cribl workers' egress addresses (or a private endpoint they can reach).",
      "With selected networks, also tick Allow trusted Microsoft services to bypass this firewall, so diagnostic settings and Defender can write.",
    ],
    cli: "",
    values: (v) => [
      { label: "Endpoint Cribl must reach", value: `${v.namespace}.servicebus.windows.net:9093` },
    ],
    rbac: ["Microsoft.EventHub/namespaces/networkRuleSets/write only if you change the rules."],
    confirmHow: "The Networking page of {{namespace}} allows public access, or lists the Cribl egress addresses and trusted Microsoft services.",
    dependsOnValues: ["namespace"],
    // Confirm-only by design (plan step P6): whether Azure and the Cribl
    // workers can reach the namespace is a property of networks this app
    // cannot see, not of a resource it could GET. It reads "confirm by hand".
    checkKinds: [],
    provenance: "inferred",
  },
];
