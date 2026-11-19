/**
 * The least-privilege FUNCTIONS - what an operator does with the app, and the
 * operations each one uses. Necessity lives here, because it is a property of
 * the function: the same namespace read is core to a lab and one optional
 * check inside Validate.
 *
 * Mapped from the audit's per-call function lists (each corrected row names
 * the screens and use cases that send it). A function lists an operation when
 * ANY of its paths sends the call, so a refused operation can cost a function
 * one branch rather than all of it; the consumers that ask for roles say which.
 *
 * Pure: data only.
 */

import type { PrivilegeFunction } from "./least-privilege";

const FUNCTIONS = [
  {
    id: "azure-sign-in",
    label: "Sign in to Azure as the app registration",
    necessity: "core",
    operations: ["entra.token"],
  },
  {
    id: "discovery",
    label: "Discover subscriptions, resource groups and workspaces",
    necessity: "core",
    operations: [
      "subscriptions.list",
      "resourceGroups.list",
      "resourceGroup.create",
      "workspaces.list",
      "workspace.read",
      "workspace.write",
    ],
  },
  {
    id: "permission-check",
    label: "Check the app's effective permissions",
    necessity: "core",
    operations: [
      "rbac.permissions.read",
      "dcr.list",
      "workspace.read",
      "tables.list",
      "resourceGraph.query",
    ],
  },
  // CAP-4 / CAP-5. The capability audit's OPTIONAL probes: each measures a
  // permission ahead of the feature that needs it (AZR-6, AZR-7) and only
  // annotates. A refusal costs an unknown, never the permission check, so
  // they are `feature`, not part of the core function above - nothing that
  // derives the asked-for roles from core functions may ask for them.
  {
    id: "capability-probes",
    label: "Measure optional permissions ahead of the features that need them",
    necessity: "feature",
    operations: [
      // CAP-4: the Sentinel incidents probe ($top=1) on the configured workspace.
      "sentinel.incidents.read",
      // CAP-5: the two Graph probes, on the Graph token.
      "entra.token",
      "graph.subscribedSkus.read",
      "graph.securityIncidents.read",
    ],
  },
  {
    id: "dcr-deploy",
    label: "Deploy and update Data Collection Rules",
    necessity: "core",
    operations: [
      "workspace.read",
      "dcr.list",
      "dcr.read",
      "dcr.write",
      "dce.read",
      "dce.write",
      "ampls.scopedResource.write",
      "tables.list",
      "table.read",
      "table.write",
    ],
  },
  {
    id: "custom-tables",
    label: "Create and change custom Log Analytics tables",
    necessity: "core",
    operations: ["tables.list", "table.read", "table.write"],
  },
  {
    id: "dcr-grant",
    label: "Grant Cribl's identity access to each deployed DCR",
    necessity: "feature",
    operations: ["dcr.list", "dcr.roleAssignment.write"],
  },
  {
    id: "ingestion-identity-picker",
    label: "Pick the Cribl ingestion identity by name",
    necessity: "feature",
    operations: ["entra.token", "graph.servicePrincipals.read"],
  },
  {
    id: "sentinel-content",
    label: "Install Microsoft Sentinel content",
    necessity: "feature",
    operations: [
      "workspace.read",
      "sentinel.contentProductPackages.read",
      "sentinel.contentPackages.read",
      "sentinel.alertRules.read",
      "sentinel.contentPackage.write",
      "sentinel.contentPackage.delete",
      "sentinel.alertRule.write",
      "sentinel.onboardingState.write",
      "workbooks.list",
      "workbook.write",
      "savedSearches.list",
      "savedSearch.write",
      "savedSearch.delete",
      "table.read",
      "table.write",
    ],
  },
  {
    id: "sentinel-enable",
    label: "Enable Microsoft Sentinel on a workspace",
    necessity: "feature",
    operations: ["workspace.read", "sentinel.solution.read", "sentinel.solution.write"],
  },
  {
    id: "eventhub-discovery",
    label: "Discover Event Hubs, their senders and their activity",
    necessity: "feature",
    operations: [
      "resourceGraph.query",
      "eventhub.hubs.list",
      "eventhub.consumerGroups.list",
      "eventhub.hubRules.list",
      "eventhub.metrics.read",
    ],
  },
  {
    id: "eventhub-target",
    label: "Pick the Event Hub namespace, hub and rule for onboarding",
    necessity: "feature",
    operations: ["resourceGraph.query", "eventhub.hubs.list", "eventhub.rules.list"],
  },
  {
    id: "cribl-source-create",
    label: "Create the Cribl Event Hub source",
    necessity: "feature",
    operations: [
      "eventhub.namespace.read",
      "eventhub.rules.list",
      "eventhub.consumerGroup.read",
      "eventhub.rule.listKeys",
      "cribl.config.read",
      "cribl.secret.read",
      "cribl.secret.create",
      "cribl.input.create",
      "cribl.object.read",
      "cribl.commit",
      "cribl.version.read",
      "cribl.group.read",
      "cribl.deploy",
    ],
  },
  {
    id: "eventhub-listen-access",
    label: "Create (and remove) the Listen rule and consumer group the Cribl Event Hub source reads with",
    necessity: "feature",
    operations: [
      "eventhub.rule.read",
      "eventhub.rule.write",
      "eventhub.rule.delete",
      "eventhub.consumerGroup.read",
      "eventhub.consumerGroup.write",
      "eventhub.consumerGroup.delete",
    ],
  },
  {
    id: "defender-export",
    label: "Deploy the Defender for Cloud continuous export",
    necessity: "feature",
    operations: [
      "resourceGroups.list",
      "defender.pricings.read",
      "defender.automations.list",
      "defender.automation.write",
      "defender.automation.read",
      "eventhub.rule.listKeys",
    ],
  },
  {
    id: "activity-log-export",
    label: "Deploy (and remove) the subscription Activity Log diagnostic setting",
    necessity: "feature",
    operations: [
      "activityLog.diagnosticSettings.read",
      "activityLog.diagnosticSetting.write",
      // AZR-105: the in-app Remove of the setting this deploy created.
      "activityLog.diagnosticSetting.delete",
      // The app never calls listKeys here, but Azure checks the caller holds
      // it on the rule a diagnostic setting names (documented, not measured).
      "eventhub.rule.listKeys",
    ],
  },
  {
    // AZR-103: the Cribl principal's receive role, granted from the onboarding
    // screen behind a confirm. The directory read only resolves or cross-checks
    // the principal; without it the operator types the object id.
    id: "eventhub-receiver-grant",
    label: "Grant the Cribl principal Azure Event Hubs Data Receiver on the hub or namespace",
    necessity: "feature",
    operations: ["rbac.roleAssignments.read", "eventhub.receiverGrant.write", "graph.servicePrincipals.read"],
  },
  {
    id: "entra-diagnostic-export",
    label: "Deploy (and remove) the Entra ID tenant diagnostic setting",
    necessity: "feature",
    operations: [
      "entra.diagnosticSettings.read",
      "entra.diagnosticSetting.write",
      // The in-app Remove of the setting this deploy created.
      "entra.diagnosticSetting.delete",
      // The app never calls listKeys here, but Azure checks the caller holds
      // it on the rule a diagnostic setting names (documented, not measured).
      "eventhub.rule.listKeys",
    ],
  },
  {
    id: "validate",
    label: "Validate Azure onboarding (read only)",
    necessity: "feature",
    operations: [
      "eventhub.namespace.read",
      "eventhub.hubs.list",
      "eventhub.consumerGroup.read",
      "eventhub.rules.list",
      "eventhub.metrics.read",
      "activityLog.diagnosticSettings.read",
      "defender.pricings.read",
      "defender.automations.list",
      "defender.provider.read",
      "policy.assignments.read",
      "policy.definition.read",
      "policy.mgDefinitions.list",
      "policy.remediations.read",
      "rbac.roleAssignments.read",
      "entra.diagnosticSettings.read",
      "networkWatcher.read",
      "flowLogs.read",
      "storageAccount.read",
      "blobContainer.read",
      "queue.read",
      "eventGrid.systemTopic.read",
      "eventGrid.subscription.read",
    ],
  },
  {
    id: "logging-map",
    label: "Map Azure logging across management groups and subscriptions",
    necessity: "feature",
    operations: [
      "subscriptions.list",
      "managementGroups.descendants.read",
      "managementGroups.list",
      "managementGroup.read",
      "policy.assignments.read",
      "policy.exemptions.read",
      "policy.definition.read",
      "rbac.roleAssignments.read",
      "rbac.roleDefinition.read",
    ],
  },
  {
    id: "tenant-session",
    label: "Prove which tenant answered before another tenant's reads count",
    necessity: "feature",
    operations: ["entra.token", "subscription.read"],
  },
  {
    id: "siem-migration",
    label: "Inventory workspaces for a SIEM migration",
    necessity: "feature",
    operations: ["subscriptions.list", "workspaces.list", "solutions.list", "workspace.query"],
  },
  {
    id: "data-allowances",
    label: "Show how much of the free data allowances is granted and used",
    necessity: "feature",
    operations: [
      "entra.token",
      "graph.subscribedSkus.read",
      "defender.pricings.read",
      "resourceGraph.query",
      "tables.list",
      "workspace.query",
    ],
  },
  // PLANNED (AZR-4): nothing performs this yet. Listed so the CAP-2 / CAP-3
  // writes the capability model measures ahead of the feature are not orphan
  // facts; no change request asks for them until the feature ships. NOT the
  // complete set AZR-4 needs: granting the assignment identity its roles is a
  // role-assignment write, and referencing a user-assigned identity probably
  // needs userAssignedIdentities/assign/action (CAP-12; see enabler-actions).
  {
    id: "policy-logging",
    label: "Assign the Azure Policy logging initiatives and remediate existing resources",
    necessity: "feature",
    operations: ["policy.assignment.write", "policy.remediation.write", "managedIdentity.write"],
  },
  {
    id: "labs",
    label: "Deploy, extend and destroy labs",
    necessity: "core",
    operations: [
      "subscriptions.list",
      "resourceGroups.list",
      "resourceGroup.read",
      "resourceGroup.create",
      "resourceGroup.tag",
      "resourceGroup.delete",
      "rbac.permissions.read",
      "logicApp.read",
      "logicApp.write",
      "lab.roleAssignment.write",
      "storageAccount.read",
      "storageAccount.write",
      "blobContainer.read",
      "blobContainer.write",
      "queue.read",
      "queue.write",
      "eventGrid.provider.read",
      "eventGrid.provider.register",
      "eventGrid.systemTopic.read",
      "eventGrid.systemTopic.write",
      "eventGrid.subscription.read",
      "eventGrid.subscription.write",
      "lab.network.read",
      "nsg.write",
      "vnet.write",
      "workspace.read",
      "workspace.write",
      "sentinel.solution.read",
      "sentinel.solution.write",
      "ampls.read",
      "ampls.write",
      "ampls.scopedResource.read",
      "ampls.scopedResource.write",
      "privateEndpoint.write",
      "privateDnsZone.read",
      "privateDnsZone.write",
      "dnsVnetLink.read",
      "dnsVnetLink.write",
      "eventhub.namespace.read",
      "eventhub.namespace.write",
      "eventhub.hub.read",
      "eventhub.hub.write",
      "eventhub.consumerGroup.read",
      "eventhub.consumerGroup.write",
      "adx.cluster.read",
      "adx.cluster.write",
      "adx.database.read",
      "adx.database.write",
      "adx.script.read",
      "adx.script.write",
      "networkWatcher.read",
      "networkWatcher.write",
      "flowLogs.read",
      "flowLog.write",
      "vm.read",
      "vm.write",
      "vm.schedule.read",
      "vm.schedule.write",
      "nic.write",
      "publicIp.write",
      "vpnGateway.write",
      "localNetworkGateway.write",
      "vpnConnection.write",
      "dcr.read",
      "dcr.write",
      "table.read",
      "cribl.commit",
      "cribl.deploy",
      "cribl.secret.create",
      "cribl.groups.list",
    ],
  },
  {
    id: "lab-ttl-identity",
    label: "Lab TTL self-destruct (runs as the Logic App's own identity)",
    necessity: "core",
    operations: ["lab.ttl.resourceGroup.read", "lab.ttl.resourceGroup.delete"],
  },
  {
    id: "cribl-app-storage",
    label: "Store the app's settings, secrets and records",
    necessity: "core",
    operations: ["cribl.kv.read", "cribl.kv.write", "cribl.kv.delete", "cribl.kv.list"],
  },
  {
    id: "cribl-read",
    label: "Read Cribl worker groups and their configuration",
    necessity: "core",
    operations: [
      "cribl.groups.list",
      "cribl.group.read",
      "cribl.workers.list",
      "cribl.config.read",
      "cribl.packConfig.read",
      "cribl.object.read",
      "cribl.version.read",
    ],
  },
  {
    id: "cribl-onboard",
    label: "Create Cribl destinations, secrets, routes, pipelines and Lake datasets, then commit and deploy",
    necessity: "feature",
    operations: [
      "cribl.secret.read",
      "cribl.secret.create",
      "cribl.secret.update",
      "cribl.output.create",
      "cribl.routes.write",
      "cribl.lake.dataset.create",
      "cribl.lake.dataset.createInLake",
      "cribl.pipeline.create",
      "cribl.commit",
      "cribl.deploy",
    ],
  },
  {
    id: "cribl-packs",
    label: "Install, upgrade and remove packs",
    necessity: "feature",
    operations: ["cribl.packs.manage", "cribl.pack.update"],
  },
  {
    id: "cribl-samples",
    label: "Capture and query samples, and show live flow",
    necessity: "feature",
    operations: ["cribl.capture", "cribl.metrics.query", "cribl.lake.datasets.list", "cribl.search.jobs"],
  },
] as const satisfies readonly PrivilegeFunction[];

/** The id of one function in {@link LEAST_PRIVILEGE_FUNCTIONS}. */
export type FunctionId = (typeof FUNCTIONS)[number]["id"];

/** Every function, in the order a ticket lists them. */
export const LEAST_PRIVILEGE_FUNCTIONS: readonly PrivilegeFunction[] = FUNCTIONS;
