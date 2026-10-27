/**
 * The policy-based steps: the shared policy identity, the Microsoft Audit
 * built-in initiative and the community initiative. The app has no Automated
 * mode for these yet; the steps follow what the deprecated PowerShell writer
 * did, which the Azure Logging Map already recognises.
 *
 * The identity name, its two roles, the built-in Audit initiative id, the
 * community initiative name and the diagnostic setting name all come from the
 * logging-map LEGACY_WRITER (ownership.ts), itself pinned against the frozen
 * scripts. The assignment and definition NAMES exist only in those scripts,
 * so they are declared once below, with their line, and pinned against the
 * LEGACY_WRITER name families - a name that drifted from what the Logging Map
 * recognises would fail.
 *
 * Centralized mode only: one namespace, so the names end in `-Central`.
 *
 * Pure: data and string building only.
 */

import { eventHubNamespacePath } from "../eventhub-arm/eventhub-arm";
import { coverageItem } from "../coverage-model";
import { LEGACY_WRITER } from "../logging-map/ownership";
import type { PlanValues } from "../onboarding-howto/plan-values";
import { planRuleId } from "./eventhub-steps";
import type { HowToStep } from "./steps";

/**
 * Names that live only in the frozen legacy scripts
 * (packages/core/src/domain/logging-map/legacy/).
 */
export const LEGACY_POLICY_NAMES = Object.freeze({
  /** Deploy-BuiltInPolicyInitiatives.ps1:288-289, LogMode Audit, Centralized. */
  auditAssignment: "Cribl-AU-Central",
  /** Deploy-CommunityPolicyInitiative.ps1:401, Centralized. */
  communityAssignment: "Cribl-Diag-EH-Central",
  /** Deploy-CommunityPolicyInitiative.ps1:136-137 and 387: Cribl-<Service>-DiagSettings-EH. */
  communityDefinitionPrefix: "Cribl-",
  communityDefinitionSuffix: "-DiagSettings-EH",
  /** Deploy-SupplementalPolicies.ps1:1168. */
  activityLogAssignment: "Cribl-ActivityLog",
  /** Deploy-SupplementalPolicies.ps1:1020 (Cribl-Community-$serviceType-DiagSettings-EventHub). */
  activityLogDefinition: "Cribl-Community-ActivityLog-DiagSettings-EventHub",
  /** Deploy-SupplementalPolicies.ps1:161, the community Activity Log definition, version 2. */
  activityLogCommunityName: "configure-azure-activity-logs-to-stream-to-specified-event-hub-v2",
  /** Deploy-SupplementalPolicies.ps1:89, where the community definitions live. */
  communityRepoFolder:
    "https://github.com/Azure/Community-Policy/tree/main/policyDefinitions/Monitoring/To%20Event%20Hub",
  /** Deploy-BuiltInPolicyInitiatives.ps1:723: the effect the legacy assigned with. */
  effect: "DeployIfNotExists",
});

/** The management group scope a plan's policy assignments sit at. */
export function managementGroupScope(managementGroupId: string): string {
  return `/providers/Microsoft.Management/managementGroups/${managementGroupId}`;
}

/** The ARM id of the shared user-assigned policy identity. */
export function policyIdentityId(v: Pick<PlanValues, "subscriptionId" | "resourceGroup">): string {
  return (
    `/subscriptions/${v.subscriptionId}/resourceGroups/${v.resourceGroup}` +
    `/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${LEGACY_WRITER.identityName}`
  );
}

/** The ARM id of a policy assignment at the plan's management group. */
export function assignmentId(managementGroupId: string, name: string): string {
  return `${managementGroupScope(managementGroupId)}/providers/Microsoft.Authorization/policyAssignments/${name}`;
}

/**
 * The assignment parameters the legacy writer set, when the definition
 * declares them (Deploy-BuiltInPolicyInitiatives.ps1:717-733). An empty
 * eventHubName lets Azure create one hub per category.
 */
export function policyAssignmentParameters(v: PlanValues): string {
  return JSON.stringify(
    {
      eventHubAuthorizationRuleId: { value: planRuleId(v, v.sendRule) },
      eventHubName: { value: "" },
      effect: { value: LEGACY_POLICY_NAMES.effect },
      resourceLocation: { value: v.region },
      profileName: { value: LEGACY_WRITER.diagnosticSettingNameHint },
    },
    null,
    2,
  );
}

/** A plan namespace path written with placeholders, for CLI templates. */
const NS_TEMPLATE = eventHubNamespacePath({
  subscriptionId: "{{subscriptionId}}",
  resourceGroup: "{{resourceGroup}}",
  name: "{{namespace}}",
});
const MG_TEMPLATE = managementGroupScope("{{managementGroupId}}");
const IDENTITY_TEMPLATE = policyIdentityId({
  subscriptionId: "{{subscriptionId}}",
  resourceGroup: "{{resourceGroup}}",
});

const [MONITORING_ROLE, EVENTHUB_ROLE] = LEGACY_WRITER.identityRoles;

const POLICY_SOURCE_IDS = [
  "diagnosticSettingsInitiative",
  "communityPolicyInitiative",
  "activityLog",
] as const;

const PARAMS_NOTE =
  "Parameters: Event Hub authorization rule ID of {{sendRule}}, Event Hub name left empty, effect DeployIfNotExists, resource location {{region}}, and the profile name shown below - set each one the definition asks for.";

/** One remediation step for an assignment; the shape is shared, the names are not. */
function remediationStep(
  id: string,
  sourceId: (typeof POLICY_SOURCE_IDS)[number],
  assignment: string,
): HowToStep {
  return {
    id,
    sourceIds: [sourceId],
    title: `Remediate existing resources under ${assignment}`,
    why: "A DeployIfNotExists assignment only acts on resources created or changed after it exists. A remediation task adds the diagnostic setting to the resources that already exist.",
    portal: [
      "Open Policy and select Remediation.",
      `Select the assignment ${assignment} at the management group {{managementGroupId}} and create a remediation task. For an initiative, create one task per policy in it.`,
    ],
    cli: `az policy remediation create --management-group {{managementGroupId}} --name Remediate-${assignment} --policy-assignment ${assignmentId("{{managementGroupId}}", assignment)}`,
    values: (v) => [{ label: "Assignment ID", value: assignmentId(v.managementGroupId, assignment) }],
    rbac: ["Microsoft.PolicyInsights/remediations/write at the management group (Resource Policy Contributor includes it)."],
    confirmHow: `The remediation tasks for ${assignment} finish with no failed resources.`,
    dependsOnValues: ["managementGroupId"],
    checkKinds: ["policy-remediation"],
    provenance: "inferred",
  };
}

export const POLICY_IDENTITY_STEP: HowToStep = {
  id: "policy-identity",
  sourceIds: POLICY_SOURCE_IDS,
  title: `Create the policy identity ${LEGACY_WRITER.identityName} and grant its roles`,
  why: "A DeployIfNotExists policy creates diagnostic settings as its own identity. One user-assigned identity serves every policy assignment here, with the right to write diagnostic settings across the management group and to use the namespace.",
  portal: [
    `Open Managed Identities and create a user-assigned identity named ${LEGACY_WRITER.identityName} in the resource group {{resourceGroup}}, region {{region}}, subscription {{subscriptionId}}.`,
    `On the management group {{managementGroupId}}, open Access control (IAM) and assign the role ${MONITORING_ROLE.roleName} to the identity.`,
    `On the namespace {{namespace}}, open Access control (IAM) and assign the role ${EVENTHUB_ROLE.roleName} to the identity.`,
  ],
  cli: [
    `az identity create --subscription {{subscriptionId}} --resource-group {{resourceGroup}} --name ${LEGACY_WRITER.identityName} --location {{region}}`,
    `az role assignment create --assignee-object-id <principalId of the identity> --assignee-principal-type ServicePrincipal --role "${MONITORING_ROLE.roleName}" --scope ${MG_TEMPLATE}`,
    `az role assignment create --assignee-object-id <principalId of the identity> --assignee-principal-type ServicePrincipal --role "${EVENTHUB_ROLE.roleName}" --scope ${NS_TEMPLATE}`,
  ].join("\n"),
  values: (v) => [
    { label: "Identity resource ID", value: policyIdentityId(v) },
    {
      label: `${MONITORING_ROLE.roleName} scope`,
      value: managementGroupScope(v.managementGroupId),
    },
    {
      label: `${EVENTHUB_ROLE.roleName} scope`,
      value: eventHubNamespacePath({
        subscriptionId: v.subscriptionId,
        resourceGroup: v.resourceGroup,
        name: v.namespace,
      }),
    },
  ],
  rbac: [
    "Microsoft.ManagedIdentity/userAssignedIdentities/write on the resource group.",
    "Microsoft.Authorization/roleAssignments/write at the management group and on the namespace (User Access Administrator or Owner).",
  ],
  confirmHow: `The identity ${LEGACY_WRITER.identityName} lists both role assignments under Azure role assignments.`,
  dependsOnValues: ["subscriptionId", "resourceGroup", "region", "managementGroupId", "namespace"],
  checkKinds: ["policy-identity-roles"],
  provenance: "repo",
  warning:
    "Validate can only read role assignments it is allowed to list, so a missing role may read as could not be checked rather than absent.",
};

/** Shared with the Activity Log steps. */
export { IDENTITY_TEMPLATE, MG_TEMPLATE, PARAMS_NOTE, remediationStep };

const AUDIT = LEGACY_POLICY_NAMES.auditAssignment;
const COMMUNITY = LEGACY_POLICY_NAMES.communityAssignment;

function tiersFrom(subSelection: readonly string[]): readonly string[] {
  const item = coverageItem("communityPolicyInitiative");
  const keys = new Set(item?.subSelection?.options.map((o) => o.key) ?? []);
  const chosen = subSelection.filter((s) => keys.has(s));
  return chosen.length > 0 ? chosen : (item?.subSelection?.defaultSelected ?? []);
}

export const POLICY_STEPS: readonly HowToStep[] = [
  POLICY_IDENTITY_STEP,
  {
    id: "policy-audit-assign",
    sourceIds: ["diagnosticSettingsInitiative"],
    title: `Assign the Microsoft Audit initiative as ${AUDIT}`,
    why: "The built-in initiative adds an Event Hub diagnostic setting (audit categories) to every supported resource under the management group, writing with the rule {{sendRule}}.",
    portal: [
      "Open Policy, select Definitions and find the built-in initiative with the ID shown below.",
      `Assign it at the management group {{managementGroupId}}. Assignment name: ${AUDIT}.`,
      PARAMS_NOTE,
      `Remediation: choose the user-assigned identity ${LEGACY_WRITER.identityName} and location {{region}}.`,
    ],
    cli: `az policy assignment create --name ${AUDIT} --scope ${MG_TEMPLATE} --policy-set-definition ${LEGACY_WRITER.builtInSetIds.audit} --mi-user-assigned ${IDENTITY_TEMPLATE} --location {{region}} --params @audit-params.json\n# audit-params.json holds the assignment parameters below; drop any the initiative does not declare. The rule is {{sendRule}} in {{namespace}}.`,
    values: (v) => [
      { label: "Assignment name", value: AUDIT },
      { label: "Assignment ID", value: assignmentId(v.managementGroupId, AUDIT) },
      { label: "Initiative ID", value: LEGACY_WRITER.builtInSetIds.audit },
      { label: "Identity", value: policyIdentityId(v) },
      { label: "Assignment parameters", value: policyAssignmentParameters(v) },
    ],
    rbac: ["Microsoft.Authorization/policyAssignments/write at the management group (Resource Policy Contributor includes it)."],
    confirmHow: `Policy, Assignments shows ${AUDIT} at {{managementGroupId}} with the identity attached.`,
    dependsOnValues: ["subscriptionId", "resourceGroup", "managementGroupId", "region", "namespace", "sendRule"],
    checkKinds: ["policy-assignment"],
    provenance: "repo",
  },
  remediationStep("policy-audit-remediate", "diagnosticSettingsInitiative", AUDIT),
  {
    id: "policy-community-definitions",
    sourceIds: ["communityPolicyInitiative"],
    title: "Import the community diagnostic-setting definitions into {{managementGroupId}}",
    why: "The community initiative is built from Azure Community Policy definitions, one per resource type, saved at the management group so the initiative can reference them.",
    portal: [
      `Open the Azure Community Policy folder (link below) and, for each resource type in the tiers you chose, copy its definition.`,
      `In Policy, Definitions, select + Policy definition, set the location to the management group {{managementGroupId}}, and save it as ${LEGACY_POLICY_NAMES.communityDefinitionPrefix}<ResourceType>${LEGACY_POLICY_NAMES.communityDefinitionSuffix}.`,
    ],
    cli: `az policy definition create --management-group {{managementGroupId}} --name ${LEGACY_POLICY_NAMES.communityDefinitionPrefix}<ResourceType>${LEGACY_POLICY_NAMES.communityDefinitionSuffix} --rules <rules file> --params <parameters file> --mode Indexed`,
    values: (_v, sub) => [
      { label: "Source folder", value: LEGACY_POLICY_NAMES.communityRepoFolder },
      { label: "Tiers", value: tiersFrom(sub).join(", ") },
    ],
    rbac: ["Microsoft.Authorization/policyDefinitions/write at the management group."],
    confirmHow: `Policy, Definitions at {{managementGroupId}} lists a ${LEGACY_POLICY_NAMES.communityDefinitionPrefix}...${LEGACY_POLICY_NAMES.communityDefinitionSuffix} definition for every resource type you chose.`,
    dependsOnValues: ["managementGroupId"],
    checkKinds: [],
    provenance: "repo",
  },
  {
    id: "policy-community-initiative",
    sourceIds: ["communityPolicyInitiative"],
    title: `Create the initiative ${LEGACY_WRITER.communitySetName}`,
    why: "One initiative groups the imported definitions so a single assignment covers them all.",
    portal: [
      `In Policy, Definitions, select + Initiative definition at the management group {{managementGroupId}}. Name: ${LEGACY_WRITER.communitySetName}.`,
      "Add every definition you imported and expose the Event Hub rule ID, Event Hub name, effect and location as initiative parameters.",
    ],
    cli: `az policy set-definition create --management-group {{managementGroupId}} --name ${LEGACY_WRITER.communitySetName} --definitions <definitions file> --params <parameters file>`,
    values: (v) => [
      {
        label: "Initiative ID",
        value: `${managementGroupScope(v.managementGroupId)}/providers/Microsoft.Authorization/policySetDefinitions/${LEGACY_WRITER.communitySetName}`,
      },
    ],
    rbac: ["Microsoft.Authorization/policySetDefinitions/write at the management group."],
    confirmHow: `Policy, Definitions at {{managementGroupId}} lists the initiative ${LEGACY_WRITER.communitySetName}.`,
    dependsOnValues: ["managementGroupId"],
    checkKinds: ["policy-set-definition"],
    provenance: "repo",
  },
  {
    id: "policy-community-assign",
    sourceIds: ["communityPolicyInitiative"],
    title: `Assign the community initiative as ${COMMUNITY}`,
    why: "The assignment applies the initiative to every resource under the management group, writing with the rule {{sendRule}}.",
    portal: [
      `In Policy, Definitions, open ${LEGACY_WRITER.communitySetName} and select Assign, at the management group {{managementGroupId}}. Assignment name: ${COMMUNITY}.`,
      PARAMS_NOTE,
      `Remediation: choose the user-assigned identity ${LEGACY_WRITER.identityName} and location {{region}}.`,
    ],
    cli: `az policy assignment create --name ${COMMUNITY} --scope ${MG_TEMPLATE} --policy-set-definition ${managementGroupScope("{{managementGroupId}}")}/providers/Microsoft.Authorization/policySetDefinitions/${LEGACY_WRITER.communitySetName} --mi-user-assigned ${IDENTITY_TEMPLATE} --location {{region}} --params @community-params.json\n# community-params.json holds the assignment parameters below. The rule is {{sendRule}} in {{namespace}}.`,
    values: (v) => [
      { label: "Assignment name", value: COMMUNITY },
      { label: "Assignment ID", value: assignmentId(v.managementGroupId, COMMUNITY) },
      { label: "Identity", value: policyIdentityId(v) },
      { label: "Assignment parameters", value: policyAssignmentParameters(v) },
    ],
    rbac: ["Microsoft.Authorization/policyAssignments/write at the management group (Resource Policy Contributor includes it)."],
    confirmHow: `Policy, Assignments shows ${COMMUNITY} at {{managementGroupId}} with the identity attached.`,
    dependsOnValues: ["subscriptionId", "resourceGroup", "managementGroupId", "region", "namespace", "sendRule"],
    checkKinds: ["policy-assignment"],
    provenance: "repo",
  },
  remediationStep("policy-community-remediate", "communityPolicyInitiative", COMMUNITY),
];
