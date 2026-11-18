// Pins for the Entra ID tenant setting the onboarding Deploy writes (AZR-99).

import { describe, expect, it } from "vitest";
import { parseDiagnosticSettings } from "../activity-log-export/diagnostic-setting";
import { entraCategoriesFor, entraDeployTarget, entraSettingRequest } from "../onboarding-howto-steps/entra-activity-steps";
import { defaultPlanValues } from "../onboarding-howto/plan-values";
import { licenceNotes } from "./entra-categories";
import {
  buildEntraSettingDeleteRequest,
  buildEntraSettingGetRequest,
  buildEntraSettingPutRequest,
} from "./entra-diagnostic-setting";
import {
  ENTRA_SETTING_NAME,
  classifyOursEntraSetting,
  entraDiagnosticInputFor,
  expectedEntraSetting,
  findOverlappingEntraSettings,
  unknownEntraCategories,
} from "./entra-setting-deploy";
import type { EntraSettingInput } from "./entra-setting-deploy";

const EH_SUB = "11111111-1111-1111-1111-111111111111";
const NS = { subscriptionId: EH_SUB, resourceGroup: "eh-rg", name: "cribl-ns" };
const NS_PATH = `/subscriptions/${EH_SUB}/resourceGroups/eh-rg/providers/Microsoft.EventHub/namespaces/cribl-ns`;
const RULE_ID = `${NS_PATH}/authorizationRules/send`;
const STANDARD = entraCategoriesFor(["Standard"]);
const INPUT: EntraSettingInput = { namespace: NS, ruleName: "send", categories: STANDARD };

function setting(opts: {
  name: string;
  ruleId?: string;
  hub?: string;
  categories?: readonly string[];
  groups?: readonly string[];
}): unknown {
  return {
    id: `/providers/microsoft.aadiam/diagnosticSettings/${opts.name}`,
    name: opts.name,
    properties: {
      eventHubAuthorizationRuleId: opts.ruleId ?? RULE_ID,
      ...(opts.hub !== undefined ? { eventHubName: opts.hub } : {}),
      logs: [
        ...(opts.categories ?? STANDARD).map((category) => ({ category, enabled: true })),
        { category: "NonInteractiveUserSignInLogs", enabled: false },
        ...(opts.groups ?? []).map((categoryGroup) => ({ categoryGroup, enabled: true })),
      ],
    },
  };
}

describe("the Deploy writes what the How-to step shows", () => {
  it("PUTs the How-to body, byte for byte, at the tenant path with api-version 2017-04-01", () => {
    const values = {
      ...defaultPlanValues(null),
      subscriptionId: "shared-sub",
      resourceGroup: "shared-rg",
      eventHubSubscriptionId: EH_SUB,
      eventHubResourceGroup: "eh-rg",
      namespace: "cribl-ns",
      sendRule: "send",
    };
    const howto = entraSettingRequest(values, ["Standard"]);
    const put = buildEntraSettingPutRequest(entraDiagnosticInputFor(INPUT));
    expect(put.method).toBe("PUT");
    expect(put.path).toBe("/providers/microsoft.aadiam/diagnosticSettings/CriblEntraIDLogs");
    expect(put.apiVersion).toBe("2017-04-01");
    expect(JSON.stringify(put.body)).toBe(JSON.stringify(howto.body));
    // The rule comes from the namespace's OWN location, never the shared keys.
    expect(put.body.properties.eventHubAuthorizationRuleId).toBe(RULE_ID);
    expect(put.body.properties.eventHubName).toBe("");
    expect(put.body.properties.logs.filter((l) => l.enabled).map((l) => l.category)).toEqual([...STANDARD]);
    expect(put.body.properties.logs).toHaveLength(15);
  });

  it("names the same setting as the How-to and Validate", () => {
    expect(ENTRA_SETTING_NAME).toBe("CriblEntraIDLogs");
    expect(STANDARD).toContain("SignInLogs");
    expect(STANDARD).toContain("AuditLogs");
  });

  it("reads and deletes by name at the same path", () => {
    const path = "/providers/microsoft.aadiam/diagnosticSettings/CriblEntraIDLogs";
    expect(buildEntraSettingGetRequest()).toEqual({ method: "GET", path, apiVersion: "2017-04-01" });
    expect(buildEntraSettingDeleteRequest()).toEqual({ method: "DELETE", path, apiVersion: "2017-04-01" });
  });
});

describe("classifyOursEntraSetting", () => {
  const expected = expectedEntraSetting(INPUT);

  it("ours with exactly the chosen categories, the rule and no hub is present-matching", () => {
    const listing = parseDiagnosticSettings([setting({ name: "CriblEntraIDLogs" })]);
    expect(classifyOursEntraSetting(listing, expected).kind).toBe("present-matching");
  });

  it("a missing chosen category is named (how an unlicensed category shows)", () => {
    const listing = parseDiagnosticSettings([
      setting({ name: "CriblEntraIDLogs", categories: STANDARD.filter((c) => c !== "RiskyUsers") }),
    ]);
    const state = classifyOursEntraSetting(listing, expected);
    expect(state.kind).toBe("present-differs");
    expect(state.kind === "present-differs" ? state.diffs : []).toEqual([
      { field: "logs", expected: `exactly ${STANDARD.join(", ")}`, actual: "not enabled: RiskyUsers" },
    ]);
  });

  it("an extra enabled category, a category group, a hub name and another rule are each named", () => {
    const listing = parseDiagnosticSettings([
      setting({
        name: "criblentraidlogs",
        ruleId: `${NS_PATH}/authorizationRules/other`,
        hub: "entra",
        categories: [...STANDARD, "ADFSSignInLogs"],
        groups: ["allLogs"],
      }),
    ]);
    const state = classifyOursEntraSetting(listing, expected);
    expect(state.kind === "present-differs" ? state.diffs.map((d) => [d.field, d.actual]) : []).toEqual([
      ["eventHubAuthorizationRuleId", `${NS_PATH}/authorizationRules/other`],
      ["eventHubName", "entra"],
      ["logs", "category groups enabled: allLogs; enabled but not chosen: ADFSSignInLogs"],
    ]);
  });

  it("an empty list is an unmeasured absent; a listed one without ours is measured", () => {
    expect(classifyOursEntraSetting(parseDiagnosticSettings([]))).toEqual({ kind: "absent", measured: false });
    expect(classifyOursEntraSetting(parseDiagnosticSettings([setting({ name: "x", ruleId: "" })]))).toEqual({
      kind: "absent",
      measured: true,
    });
  });
});

describe("findOverlappingEntraSettings", () => {
  it("returns another setting on the namespace sharing a chosen category, and only that", () => {
    const listing = parseDiagnosticSettings([
      setting({ name: "CriblEntraIDLogs" }),
      setting({ name: "sentinel", categories: ["SignInLogs"] }),
      setting({ name: "adfs-only", categories: ["ADFSSignInLogs"] }),
      setting({ name: "elsewhere", ruleId: "/subscriptions/x/resourceGroups/y/providers/Microsoft.EventHub/namespaces/z/authorizationRules/r" }),
      setting({ name: "groups", categories: [], groups: ["allLogs"] }),
    ]);
    expect(findOverlappingEntraSettings(listing, NS, STANDARD).map((s) => s.name)).toEqual(["sentinel", "groups"]);
  });
});

describe("categories and licences", () => {
  it("a category this app cannot express is named, never dropped", () => {
    expect(unknownEntraCategories(["SignInLogs", "BogusLogs", "AuditLogs"])).toEqual(["BogusLogs"]);
    expect(unknownEntraCategories(STANDARD)).toEqual([]);
  });

  it("licence notes follow Microsoft's licensing table: none for audit and sign-in, P1/P2 and P2 where documented", () => {
    expect(licenceNotes(["AuditLogs", "SignInLogs"])).toEqual([]);
    expect(licenceNotes(STANDARD).map((n) => n.category)).toEqual([
      "ProvisioningLogs",
      "RiskyUsers",
      "UserRiskEvents",
      "RiskyServicePrincipals",
      "ServicePrincipalRiskEvents",
    ]);
    expect(licenceNotes(["ProvisioningLogs"])[0]?.licence).toContain("Microsoft Entra ID P1 or P2");
    expect(licenceNotes(["RiskyUsers"])[0]?.licence).toContain("Microsoft Entra ID P2");
  });
});

describe("entraDeployTarget - the Deploy reads the plan the How-to renders", () => {
  const base = {
    ...defaultPlanValues({ subscriptionId: "shared-sub", resourceGroup: "shared-rg" }),
    namespace: "cribl-ns",
    sendRule: "send",
  };

  it("locates the namespace by its OWN Event Hub keys, never the shared subscription and resource group", () => {
    const { input, missing } = entraDeployTarget(
      { ...base, eventHubSubscriptionId: EH_SUB, eventHubResourceGroup: "eh-rg" },
      ["Standard"],
    );
    expect(missing).toEqual([]);
    expect(input).toEqual({ namespace: NS, ruleName: "send", categories: STANDARD });
  });

  it("falls back to the shared keys only when the Event Hub keys are blank (eventHubLocation)", () => {
    expect(entraDeployTarget(base, ["HighVolume"]).input?.namespace).toEqual({
      subscriptionId: "shared-sub",
      resourceGroup: "shared-rg",
      name: "cribl-ns",
    });
    expect(entraDeployTarget(base, ["HighVolume"]).input?.categories).toHaveLength(15);
  });

  it("names every blank value it needs and offers no input", () => {
    const { input, missing } = entraDeployTarget(defaultPlanValues(null), []);
    expect(input).toBeNull();
    expect(missing).toEqual(["eventHubSubscriptionId", "eventHubResourceGroup", "namespace", "sendRule"]);
  });
});
