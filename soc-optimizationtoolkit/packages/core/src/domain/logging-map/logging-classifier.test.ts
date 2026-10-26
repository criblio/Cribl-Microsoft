// Pins for the logging classifier (AZR-19, U1b). Logging-related is derived
// from the definition; unknown is never folded into "no".

import { describe, expect, it } from "vitest";

import type {
  DefinitionParameter,
  PolicyAssignment,
  PolicyDefinition,
  PolicySetDefinition,
} from "./logging-map-types";
import {
  KNOWN_BUILT_IN_DESTINATIONS,
  classifyAssignment,
  classifyDefinition,
  classifySet,
  definitionKey,
  destinationsFromParameterNames,
  isShortCircuited,
} from "./logging-classifier";

const P = (id: string): string => `/providers/Microsoft.Authorization/policyDefinitions/${id}`;
const S = (id: string): string => `/providers/Microsoft.Authorization/policySetDefinitions/${id}`;
const str = (defaultValue?: unknown): DefinitionParameter =>
  defaultValue === undefined
    ? { type: "String", hasDefault: false, defaultValue: undefined }
    : { type: "String", hasDefault: true, defaultValue };

function def(over: Partial<PolicyDefinition> & { id: string }): PolicyDefinition {
  return {
    name: over.id.split("/").pop() ?? "",
    displayName: "",
    policyType: "Custom",
    mode: "Indexed",
    parameters: {},
    thenEffect: "DeployIfNotExists",
    thenDetailsType: "Microsoft.Insights/diagnosticSettings",
    policyRule: {},
    ...over,
  };
}

function assignment(over: Partial<PolicyAssignment>): PolicyAssignment {
  return {
    id: "/subscriptions/s/providers/Microsoft.Authorization/policyAssignments/a",
    name: "a",
    displayName: "",
    scope: "/subscriptions/s",
    policyDefinitionId: P("x"),
    definitionKind: "policy",
    notScopes: [],
    parameters: {},
    metadata: {},
    identity: { type: "None", principalId: null, userAssigned: [] },
    enforcementMode: "Default",
    resourceSelectors: [],
    ...over,
  };
}

const NONE = { definitions: new Map(), sets: new Map() } as const;

describe("classifyDefinition", () => {
  it("DINE + diagnosticSettings + eventHubAuthorizationRuleId is yes / event-hub", () => {
    const d = def({ id: P("eh"), parameters: { eventHubAuthorizationRuleId: str(), eventHubName: str("") } });
    expect(classifyDefinition(d, {})).toEqual({ verdict: "yes", destinations: ["event-hub"], basis: "definition" });
  });

  it("a parameterised effect the assignment sets to Disabled is no", () => {
    const d = def({ id: P("p"), thenEffect: "[parameters('effect')]", parameters: { effect: str("DeployIfNotExists") } });
    expect(classifyDefinition(d, { effect: "Disabled" })).toEqual({
      verdict: "no",
      reason: "effect-not-deploy",
      effect: "Disabled",
    });
  });

  it("a parameterised effect falls back to the definition defaultValue", () => {
    const d = def({
      id: P("p"),
      thenEffect: "[parameters('effect')]",
      parameters: { effect: str("DeployIfNotExists"), workspaceId: str() },
    });
    expect(classifyDefinition(d, {})).toEqual({ verdict: "yes", destinations: ["log-analytics"], basis: "definition" });
  });

  it("an effect with no value and no default is unknown, not no", () => {
    const d = def({ id: P("p"), thenEffect: "[parameters('effect')]", parameters: { effect: str() } });
    expect(classifyDefinition(d, {}).verdict).toBe("unknown");
  });

  it("compares the effect and the details type case-insensitively", () => {
    const d = def({
      id: P("c"),
      thenEffect: "deployIfNotExists",
      thenDetailsType: "microsoft.insights/DIAGNOSTICSETTINGS",
      parameters: { storageAccountId: str() },
    });
    expect(classifyDefinition(d, {})).toEqual({ verdict: "yes", destinations: ["storage"], basis: "definition" });
  });

  it("a DINE of another type is no", () => {
    const d = def({ id: P("o"), thenDetailsType: "Microsoft.Security/pricings" });
    expect(classifyDefinition(d, {})).toEqual({ verdict: "no", reason: "not-diagnostic-settings", effect: null });
  });

  it("dcrResourceId names the dcr destination", () => {
    const d = def({ id: P("d"), parameters: { dcrResourceId: str() } });
    expect(classifyDefinition(d, {})).toEqual({ verdict: "yes", destinations: ["dcr"], basis: "definition" });
  });
});

describe("classifySet", () => {
  const m1 = def({ id: P("m1"), thenEffect: "[parameters('effect')]", parameters: { effect: str("Disabled"), eventHubName: str("") } });
  const m2 = def({ id: P("m2"), thenDetailsType: "Microsoft.Security/pricings" });
  const set: PolicySetDefinition = {
    id: S("s"),
    name: "s",
    displayName: "",
    policyType: "Custom",
    parameters: { effect: str("AuditIfNotExists") },
    members: [
      { policyDefinitionId: P("m1"), referenceId: "r1", parameters: { effect: "[parameters('effect')]" } },
      { policyDefinitionId: P("m2"), referenceId: "r2", parameters: {} },
    ],
  };
  const defs = new Map([
    [definitionKey(P("m1")), m1],
    [definitionKey(P("m2")), m2],
  ]);

  it("resolves a member effect through the set parameter to the assignment value", () => {
    expect(classifySet(set, { effect: "DeployIfNotExists" }, defs)).toEqual({
      verdict: "yes",
      destinations: ["event-hub"],
      basis: "set-members",
    });
    // Without the assignment value, the SET default (AuditIfNotExists) wins over the member default.
    // The reason is the EFFECT: m1 is a diagnostic-settings policy switched off,
    // not an unrelated one, so the reason must not read not-diagnostic-settings.
    expect(classifySet(set, {}, defs)).toEqual({
      verdict: "no",
      reason: "effect-not-deploy",
      effect: "AuditIfNotExists",
    });
  });

  it("members whose not-deploy effects disagree report effect-not-deploy with a null effect", () => {
    const off = def({ id: P("off"), thenEffect: "Disabled" });
    const audit = def({ id: P("aud"), thenEffect: "AuditIfNotExists" });
    const both: PolicySetDefinition = {
      ...set,
      parameters: {},
      members: [
        { policyDefinitionId: P("off"), referenceId: "r1", parameters: {} },
        { policyDefinitionId: P("aud"), referenceId: "r2", parameters: {} },
        { policyDefinitionId: P("m2"), referenceId: "r3", parameters: {} },
      ],
    };
    const lookup = new Map([
      [definitionKey(P("off")), off],
      [definitionKey(P("aud")), audit],
      [definitionKey(P("m2")), m2],
    ]);
    expect(classifySet(both, {}, lookup)).toEqual({ verdict: "no", reason: "effect-not-deploy", effect: null });
  });

  it("a set whose members are all non-diagnostic-settings is not-diagnostic-settings", () => {
    const only: PolicySetDefinition = {
      ...set,
      members: [{ policyDefinitionId: P("m2"), referenceId: "r2", parameters: {} }],
    };
    expect(classifySet(only, {}, defs)).toEqual({ verdict: "no", reason: "not-diagnostic-settings", effect: null });
  });

  it("every member read but one effect unresolvable is unknown (effect-unresolved), never no", () => {
    const open = def({ id: P("m3"), thenEffect: "[parameters('effect')]", parameters: { effect: str() } });
    const unresolved: PolicySetDefinition = {
      ...set,
      // The set declares effect with NO default, and the assignment gives none.
      parameters: { effect: str() },
      members: [
        { policyDefinitionId: P("m3"), referenceId: "r1", parameters: { effect: "[parameters('effect')]" } },
        { policyDefinitionId: P("m2"), referenceId: "r2", parameters: {} },
      ],
    };
    const lookup = new Map([
      [definitionKey(P("m3")), open],
      [definitionKey(P("m2")), m2],
    ]);
    expect(classifySet(unresolved, {}, lookup)).toEqual({
      verdict: "unknown",
      reason: "effect-unresolved",
      unread: [],
      knownDestinations: [],
    });
  });

  it("a set with one unread member is unknown, never no", () => {
    const only = new Map([[definitionKey(P("m2")), m2]]);
    expect(classifySet(set, { effect: "DeployIfNotExists" }, only)).toEqual({
      verdict: "unknown",
      reason: "member-not-read",
      unread: [definitionKey(P("m1"))],
      knownDestinations: [],
    });
  });
});

describe("classifyAssignment", () => {
  const ALLLOGS = S("85175a36-2f12-419a-96b4-18d5b0096531");

  it("short-circuits the confirmed Event Hub built-ins without a read", () => {
    expect(isShortCircuited(ALLLOGS.toUpperCase())).toBe(true);
    expect(classifyAssignment(assignment({ policyDefinitionId: ALLLOGS, definitionKind: "set" }), NONE)).toEqual({
      verdict: "yes",
      destinations: ["event-hub"],
      basis: "known-built-in",
    });
    expect(
      classifyAssignment(
        assignment({ policyDefinitionId: ALLLOGS, definitionKind: "set", parameters: { effect: "Disabled" } }),
        NONE,
      ).verdict,
    ).toBe("no");
  });

  it("does NOT short-circuit the unconfirmed seeds: unread means unknown", () => {
    const la = S("0884adba-2312-4468-abeb-5422caed1038");
    expect(KNOWN_BUILT_IN_DESTINATIONS.get(definitionKey(la))?.confirmedLive).toBe(false);
    expect(isShortCircuited(la)).toBe(false);
    expect(classifyAssignment(assignment({ policyDefinitionId: la, definitionKind: "set" }), NONE)).toMatchObject({
      verdict: "unknown",
      reason: "definition-not-read",
    });
  });

  it("an unread single definition is unknown, and a read one is classified", () => {
    expect(classifyAssignment(assignment({ policyDefinitionId: P("x") }), NONE).verdict).toBe("unknown");
    const d = def({ id: P("x"), parameters: { eventHubName: str("") } });
    const lookup = { definitions: new Map([[definitionKey(P("X")), d]]), sets: new Map() };
    expect(classifyAssignment(assignment({ policyDefinitionId: P("X") }), lookup).verdict).toBe("yes");
  });
});

describe("destinationsFromParameterNames", () => {
  it("returns every destination in canonical order", () => {
    expect(destinationsFromParameterNames(["dcrResourceId", "logAnalytics", "EventHubName", "storageAccountId"])).toEqual([
      "event-hub",
      "log-analytics",
      "storage",
      "dcr",
    ]);
    expect(destinationsFromParameterNames(["profileName"])).toEqual([]);
  });
});
