/**
 * The Entra ID tenant diagnostic setting step, and the Activity Log steps.
 *
 * Entra: the setting name, api-version, URL and body come from
 * entra-diagnostic-setting's buildEntraDiagnosticRequest; the categories from
 * ENTRA_PROFILE_CATEGORIES (Standard has no NonInteractiveUserSignInLogs); the
 * directory-role precondition and the volume and UEBA warnings from
 * entra-categories, so the warning rides the categories it is about.
 *
 * Activity Log: there is no built-in Activity-Log-to-Event-Hub policy. The
 * legacy writer imported the COMMUNITY definition (version 2) at the
 * management group and assigned it there, with the shared policy identity.
 *
 * Pure: data and string building only.
 */

import { coverageItem } from "../coverage-model";
import {
  ENTRA_CATEGORIES,
  ENTRA_PROFILES,
  ENTRA_PROFILE_CATEGORIES,
  type EntraProfile,
} from "../entra-diagnostics/entra-categories";
import {
  DEFAULT_SETTING_NAME,
  ENTRA_DIRECTORY_PRECONDITION,
  buildEntraDiagnosticRequest,
} from "../entra-diagnostics/entra-diagnostic-setting";
import { LEGACY_WRITER } from "../logging-map/ownership";
import type { PlanValues } from "../onboarding-howto/plan-values";
import { planRuleId } from "./eventhub-steps";
import {
  IDENTITY_TEMPLATE,
  LEGACY_POLICY_NAMES,
  MARKER_CLI,
  MARKER_CLI_NOTE,
  MARKER_ROW_LABEL,
  MG_TEMPLATE,
  PARAMS_NOTE,
  assignmentId,
  managementGroupDefinitionId,
  markerMetadata,
  markerPortalLine,
  policyAssignmentParameters,
  policyIdentityId,
  remediationStep,
} from "./policy-steps";
import type { HowToStep } from "./steps";

/** The Entra profile a sub-selection names, or the catalog's default. */
export function entraProfileFrom(subSelection: readonly string[]): EntraProfile {
  const chosen = subSelection.find((s): s is EntraProfile =>
    (ENTRA_PROFILES as readonly string[]).includes(s),
  );
  return chosen ?? (coverageItem("entraId")?.subSelection?.defaultSelected[0] as EntraProfile);
}

/** The categories the step enables for a sub-selection. */
export function entraCategoriesFor(subSelection: readonly string[]): readonly string[] {
  return ENTRA_PROFILE_CATEGORIES[entraProfileFrom(subSelection)];
}

/** The setting the step describes; eventHubName empty so Azure creates a hub per category. */
export function entraSettingRequest(v: PlanValues, subSelection: readonly string[]) {
  return buildEntraDiagnosticRequest({
    eventHubAuthorizationRuleId: planRuleId(v, v.sendRule),
    eventHubName: "",
    categories: entraCategoriesFor(subSelection),
  });
}

const ENTRA_URL = buildEntraDiagnosticRequest({
  eventHubAuthorizationRuleId: "",
  eventHubName: "",
  categories: [],
}).url;

const UEBA_TABLES = ENTRA_CATEGORIES.filter((c) => c.uebaBoundTable !== null).map(
  (c) => `${c.name} (${c.uebaBoundTable})`,
);
const VOLUME_WARNINGS = ENTRA_CATEGORIES.filter((c) => c.volumeWarning !== null).map(
  (c) => `${c.name}: ${c.volumeWarning}`,
);

/** The Entra step's warning: UEBA consequence, then each volume cliff. */
export const ENTRA_WARNING = [
  `Sentinel UEBA reads only its native tables. Sending these categories through Cribl means UEBA no longer sees them: ${UEBA_TABLES.join(", ")}.`,
  ...VOLUME_WARNINGS,
].join(" ");

export const ENTRA_STEPS: readonly HowToStep[] = [
  {
    id: "entra-setting",
    sourceIds: ["entraId"],
    title: `Create the Entra ID diagnostic setting ${DEFAULT_SETTING_NAME}`,
    why: "Entra ID sign-in and audit logs leave the tenant only through a tenant-level diagnostic setting. With no Event Hub name set, Azure creates one hub per category in {{namespace}}, writing with the rule {{sendRule}}.",
    portal: [
      "Open the Microsoft Entra admin center and select Monitoring and health, then Diagnostic settings, then + Add diagnostic setting.",
      `Name: ${DEFAULT_SETTING_NAME}. Tick the categories listed below and nothing else.`,
      "Tick Stream to an event hub: subscription {{subscriptionId}}, namespace {{namespace}}, leave Event hub name empty, policy name {{sendRule}}.",
      "Save.",
    ],
    cli: `az rest --method put --url "${ENTRA_URL}" --body @entra-setting.json\n# entra-setting.json is the Setting body below, for the rule {{sendRule}} in {{namespace}} ({{resourceGroup}}, {{subscriptionId}}).`,
    values: (v, sub) => {
      const request = entraSettingRequest(v, sub);
      return [
        { label: "Setting name", value: DEFAULT_SETTING_NAME },
        { label: "Profile", value: entraProfileFrom(sub) },
        { label: "Categories enabled", value: entraCategoriesFor(sub).join(", ") },
        { label: "Authorization rule ID", value: request.body.properties.eventHubAuthorizationRuleId },
        { label: "Setting body", value: JSON.stringify(request.body, null, 2) },
      ];
    },
    rbac: [
      ENTRA_DIRECTORY_PRECONDITION.requirement,
      "Microsoft.EventHub/namespaces/authorizationRules/listKeys/action on the rule {{sendRule}}.",
    ],
    confirmHow: `Diagnostic settings in the Entra admin center lists ${DEFAULT_SETTING_NAME} streaming to {{namespace}}; after the first sign-ins, hubs named after the categories appear in the namespace.`,
    dependsOnValues: ["subscriptionId", "resourceGroup", "namespace", "sendRule"],
    checkKinds: ["entra-setting"],
    provenance: "repo",
    warning: ENTRA_WARNING,
  },
];

const ACTIVITY = LEGACY_POLICY_NAMES.activityLogAssignment;
const ACTIVITY_DEF = LEGACY_POLICY_NAMES.activityLogDefinition;
const ACTIVITY_DEF_TEMPLATE = managementGroupDefinitionId("{{managementGroupId}}", ACTIVITY_DEF);

const activityRemediation = remediationStep("activity-log-remediate", "activityLog", ACTIVITY);

export const ACTIVITY_LOG_STEPS: readonly HowToStep[] = [
  {
    id: "activity-log-definition",
    sourceIds: ["activityLog"],
    title: `Import the community Activity Log definition as ${ACTIVITY_DEF}`,
    why: "Azure has no built-in policy that streams the Activity Log to an Event Hub. The community definition (version 2) does, and saving it at the management group lets one assignment cover every subscription under it.",
    portal: [
      `Open the Azure Community Policy folder (link below) and copy the definition ${LEGACY_POLICY_NAMES.activityLogCommunityName}.`,
      `In Policy, Definitions, select + Policy definition at the management group {{managementGroupId}} and save it as ${ACTIVITY_DEF}.`,
    ],
    cli: `az policy definition create --management-group {{managementGroupId}} --name ${ACTIVITY_DEF} --rules <rules file> --params <parameters file> --mode All`,
    values: (v) => [
      { label: "Community definition", value: LEGACY_POLICY_NAMES.activityLogCommunityName },
      { label: "Source folder", value: LEGACY_POLICY_NAMES.communityRepoFolder },
      {
        label: "Definition ID",
        value: managementGroupDefinitionId(v.managementGroupId, ACTIVITY_DEF),
      },
    ],
    rbac: ["Microsoft.Authorization/policyDefinitions/write at the management group."],
    confirmHow: `Policy, Definitions at {{managementGroupId}} lists ${ACTIVITY_DEF}.`,
    dependsOnValues: ["managementGroupId"],
    // Covered by 'policy-definition': like the community definitions, this is
    // a custom definition saved at the management group under a name the
    // steps fix, so the same listing answers whether it is there. The built-in
    // Activity Log definition the Logging Map also accepts is not what this
    // step imports, so it does not satisfy the check.
    checkKinds: ["policy-definition"],
    provenance: "repo",
  },
  {
    id: "activity-log-assign",
    sourceIds: ["activityLog"],
    title: `Assign the Activity Log definition as ${ACTIVITY}`,
    why: "The assignment adds a subscription diagnostic setting that streams the Activity Log to {{namespace}} with the rule {{sendRule}}, on every subscription under the management group.",
    portal: [
      `Open ${ACTIVITY_DEF} in Policy, Definitions and select Assign, at the management group {{managementGroupId}}. Assignment name: ${ACTIVITY}.`,
      PARAMS_NOTE,
      `Remediation: choose the user-assigned identity ${LEGACY_WRITER.identityName} and location {{region}}.`,
      markerPortalLine(ACTIVITY),
    ],
    cli: `az policy assignment create --name ${ACTIVITY} --scope ${MG_TEMPLATE} --policy ${ACTIVITY_DEF_TEMPLATE} --mi-user-assigned ${IDENTITY_TEMPLATE} --location {{region}} --params @activity-params.json ${MARKER_CLI}\n# activity-params.json holds the assignment parameters below. The rule is {{sendRule}} in {{namespace}}.\n${MARKER_CLI_NOTE}`,
    values: (v) => [
      { label: "Assignment name", value: ACTIVITY },
      { label: "Assignment ID", value: assignmentId(v.managementGroupId, ACTIVITY) },
      { label: "Identity", value: policyIdentityId(v) },
      { label: "Assignment parameters", value: policyAssignmentParameters(v) },
      { label: MARKER_ROW_LABEL, value: markerMetadata() },
    ],
    rbac: ["Microsoft.Authorization/policyAssignments/write at the management group (Resource Policy Contributor includes it)."],
    confirmHow: `Policy, Assignments shows ${ACTIVITY} at {{managementGroupId}}; each subscription's Activity Log, Export Activity Logs, lists a setting streaming to {{namespace}}.`,
    dependsOnValues: ["subscriptionId", "resourceGroup", "managementGroupId", "region", "namespace", "sendRule"],
    checkKinds: ["policy-assignment", "activity-log-setting"],
    provenance: "repo",
  },
  { ...activityRemediation, checkKinds: ["policy-remediation", "activity-log-setting"] },
];
