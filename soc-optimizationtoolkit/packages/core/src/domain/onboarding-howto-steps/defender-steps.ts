/**
 * The Defender for Cloud continuous export steps - the Azure side the app's
 * Automated mode writes for {@link DEFENDER_EXPORT_ITEM_ID}, as steps.
 *
 * Names, the api-version, the event source, the scope path and the hub id
 * come from defender-automation (DEFENDER_EXPORT_NAME,
 * SECURITY_AUTOMATIONS_API_VERSION, expectedExportFor); the whole export body
 * comes from its buildAutomationPutRequest; the rights come
 * from defender-permissions' two lists; the plan read from defender-plans.
 * The connection string is never shown - the body names where it comes from.
 *
 * Pure: data and string building only.
 */

import {
  ALERTS_EVENT_SOURCE,
  DEFENDER_EXPORT_ITEM_ID,
  DEFENDER_EXPORT_NAME,
  SECURITY_AUTOMATIONS_API_VERSION,
  buildAutomationPutRequest,
  defenderExportPath,
  expectedExportFor,
} from "../defender-export/defender-automation";
import {
  DEFENDER_NAMESPACE_ACTIONS,
  DEFENDER_SUBSCRIPTION_ACTIONS,
} from "../defender-export/defender-permissions";
import { STANDARD_TIER } from "../defender-export/defender-plans";
import type { PlanValues } from "../onboarding-howto/plan-values";
import { planNamespace } from "./eventhub-steps";
import type { HowToStep } from "./steps";

/** What the export body carries where the connection string goes. Never a value. */
export const CONNECTION_STRING_STAND_IN = "<connection string of the Send rule, primary key>";

/**
 * The export body the app would PUT, with the connection string stood in.
 * Built by the Automated mode's own builder, so the How-to body cannot drift
 * from what Automated creates.
 */
export function defenderExportBody(v: PlanValues): string {
  const request = buildAutomationPutRequest({
    subscriptionId: v.subscriptionId,
    resourceGroup: v.resourceGroup,
    location: v.region,
    namespace: planNamespace(v),
    hubName: v.hubName,
    connectionString: CONNECTION_STRING_STAND_IN,
  });
  return JSON.stringify(request.body, null, 2);
}

const DEFENDER_ID = [DEFENDER_EXPORT_ITEM_ID] as const;

export const DEFENDER_STEPS: readonly HowToStep[] = [
  {
    id: "defender-plans",
    sourceIds: DEFENDER_ID,
    title: "Confirm a Defender for Cloud plan is on in {{subscriptionId}}",
    why: "Continuous export sends the alerts Defender for Cloud raises. With every plan off, nothing raises alerts and the export stays silent.",
    portal: [
      "Open Microsoft Defender for Cloud and select Environment settings.",
      "Open the subscription {{subscriptionId}} and check that at least one plan shows On.",
    ],
    cli: "az security pricing list --subscription {{subscriptionId}} --output table",
    values: () => [{ label: "Pricing tier that raises alerts", value: STANDARD_TIER }],
    rbac: ["Microsoft.Security/pricings/read on the subscription. The app never changes a plan."],
    confirmHow: `At least one plan in {{subscriptionId}} lists the pricing tier ${STANDARD_TIER}.`,
    dependsOnValues: ["subscriptionId"],
    checkKinds: ["defender-plans"],
    provenance: "repo",
  },
  {
    id: "defender-provider",
    sourceIds: DEFENDER_ID,
    title: "Confirm the Microsoft.Security provider is registered in {{subscriptionId}}",
    why: "The continuous export is a Microsoft.Security resource. Azure refuses to create it while that resource provider is not registered on the subscription.",
    portal: [
      "Open the subscription {{subscriptionId}} and select Resource providers.",
      "Find Microsoft.Security. If it is not Registered, select it and choose Register.",
    ],
    cli: "az provider show --subscription {{subscriptionId}} --namespace Microsoft.Security --query registrationState --output tsv",
    values: () => [{ label: "Expected state", value: "Registered" }],
    rbac: ["Microsoft.Security/register/action on the subscription, only if it must be registered."],
    confirmHow: "Microsoft.Security shows Registered for {{subscriptionId}}.",
    dependsOnValues: ["subscriptionId"],
    checkKinds: ["defender-provider"],
    provenance: "inferred",
  },
  {
    id: "defender-export",
    sourceIds: DEFENDER_ID,
    title: `Create the continuous export ${DEFENDER_EXPORT_NAME} to {{hubName}}`,
    why: "This is the export the Automated mode would create: security alerts from this subscription only, sent to the hub {{hubName}} with the Send rule's connection string. One export per hub - a second export to the same hub makes every alert arrive twice.",
    portal: [
      "Open Microsoft Defender for Cloud, select Environment settings, then the subscription {{subscriptionId}}.",
      "Select Continuous export, then the Event hub tab.",
      `Turn export on. Exported data types: Security alerts only. Save the export configuration to the resource group {{resourceGroup}}, named ${DEFENDER_EXPORT_NAME}.`,
      "Export target: subscription {{subscriptionId}}, namespace {{namespace}}, Event Hub {{hubName}}, policy name {{sendRule}}.",
      "Save. If another export already sends to {{hubName}}, do not add a second one.",
    ],
    cli: `az rest --method put --url "https://management.azure.com/subscriptions/{{subscriptionId}}/resourceGroups/{{resourceGroup}}/providers/Microsoft.Security/automations/${DEFENDER_EXPORT_NAME}?api-version=${SECURITY_AUTOMATIONS_API_VERSION}" --body @defender-export.json\n# defender-export.json is the Export body below (location {{region}}), with the connection string of the rule {{sendRule}} in place of the stand-in.`,
    values: (v) => {
      const expected = expectedExportFor({
        subscriptionId: v.subscriptionId,
        namespace: planNamespace(v),
        hubName: v.hubName,
      });
      return [
        { label: "Export name", value: DEFENDER_EXPORT_NAME },
        { label: "Export resource ID", value: defenderExportPath(v.subscriptionId, v.resourceGroup) },
        { label: "Scope path", value: expected.scopePath },
        { label: "Event Hub resource ID", value: expected.eventHubResourceId },
        { label: "Event source", value: ALERTS_EVENT_SOURCE },
        { label: "Export body", value: defenderExportBody(v) },
      ];
    },
    rbac: [
      ...DEFENDER_SUBSCRIPTION_ACTIONS.filter((a) => a.action !== "Microsoft.Security/pricings/read").map(
        (a) => `${a.action} on the subscription: ${a.label}.`,
      ),
      ...DEFENDER_NAMESPACE_ACTIONS.map((a) => `${a.action} on the namespace: ${a.label}.`),
    ],
    confirmHow: `Continuous export for {{subscriptionId}} shows the Event hub export on, Security alerts selected and target {{hubName}}; a resource named ${DEFENDER_EXPORT_NAME} exists in {{resourceGroup}}.`,
    dependsOnValues: ["subscriptionId", "resourceGroup", "region", "namespace", "hubName", "sendRule"],
    checkKinds: ["defender-export"],
    provenance: "repo",
  },
];
