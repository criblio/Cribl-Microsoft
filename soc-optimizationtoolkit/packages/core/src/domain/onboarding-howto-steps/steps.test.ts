import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAutomationPutRequest, expectedExportFor } from "../defender-export/defender-automation";
import { ENTRA_PROFILE_CATEGORIES } from "../entra-diagnostics/entra-categories";
import { LEGACY_WRITER, TOOLKIT_MARKER_KEY, recogniseOwner } from "../logging-map/ownership";
import { PLAN_VALUE_KEYS, isPlanValueKey, type PlanValues } from "../onboarding-howto/plan-values";
import { ONBOARDING_SOURCES, isOnboardingSourceId } from "../onboarding-howto/sources";
import { CHECK_KINDS } from "../onboarding-howto/check-kinds";
import { CONNECTION_STRING_STAND_IN } from "./defender-steps";
import { LEGACY_POLICY_NAMES, MARKER_FILE, MARKER_ROW_LABEL } from "./policy-steps";
import { API_VERSION_MASK, copyCheckTexts, renderStep, renderedTexts } from "./render-instruction";
import { ALL_HOWTO_STEPS, howToStep, stepsFor, stepsForSelection, templatePlaceholders } from "./steps";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every key set to a distinct, recognisable value. */
const FULL: PlanValues = Object.fromEntries(
  PLAN_VALUE_KEYS.map((k) => [k, `${k.toLowerCase()}x`]),
) as unknown as PlanValues;
const BLANK: PlanValues = Object.fromEntries(PLAN_VALUE_KEYS.map((k) => [k, ""])) as unknown as PlanValues;

const SUBSELECTIONS: readonly (readonly string[])[] = [
  [],
  ["Standard"],
  ["HighVolume"],
  ["SecurityOnly"],
  ["All"],
  ["tier1_essential", "tier3_situational"],
];

function allRenderedText(values: PlanValues): string[] {
  const out: string[] = [];
  for (const step of ALL_HOWTO_STEPS) {
    for (const sub of SUBSELECTIONS) out.push(...renderedTexts(renderStep(step, values, sub)));
  }
  return out;
}

describe("how-to step catalog", () => {
  it("gives every onboarding source at least one step, and names only real sources", () => {
    for (const source of ONBOARDING_SOURCES) {
      expect(stepsFor(source.id).length, source.id).toBeGreaterThan(0);
    }
    for (const step of ALL_HOWTO_STEPS) {
      expect(step.sourceIds.length, step.id).toBeGreaterThan(0);
      for (const id of step.sourceIds) expect(isOnboardingSourceId(id), `${step.id}: ${id}`).toBe(true);
      for (const kind of step.checkKinds) expect(CHECK_KINDS, step.id).toContain(kind);
    }
  });

  it("has unique step ids (ticks are keyed by them)", () => {
    const ids = ALL_HOWTO_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(howToStep("eh-namespace")?.id).toBe("eh-namespace");
    expect(howToStep("nope")).toBeUndefined();
  });

  it("holds each step's template placeholders EQUAL to its dependsOnValues, all plan value keys", () => {
    for (const step of ALL_HOWTO_STEPS) {
      expect(templatePlaceholders(step), step.id).toEqual([...new Set(step.dependsOnValues)].sort());
      for (const key of step.dependsOnValues) expect(isPlanValueKey(key), step.id).toBe(true);
    }
  });

  it("computes each values table from its dependsOnValues only", () => {
    for (const step of ALL_HOWTO_STEPS) {
      const base = JSON.stringify(renderStep(step, FULL, ["Standard"]).values);
      for (const key of PLAN_VALUE_KEYS) {
        if (step.dependsOnValues.includes(key)) continue;
        const changed = { ...FULL, [key]: "changedvalue" };
        expect(JSON.stringify(renderStep(step, changed, ["Standard"]).values), `${step.id} / ${key}`).toBe(base);
      }
    }
  });

  it("puts the shared Event Hub steps first for every Event Hub source", () => {
    for (const source of ONBOARDING_SOURCES) {
      const ids = stepsFor(source.id).map((s) => s.id);
      if (source.transport === "eventhub") {
        expect(ids[0], source.id).toBe("eh-namespace");
        const lastShared = Math.max(...ids.map((id, i) => (id.startsWith("eh-") ? i : -1)));
        const firstOwn = ids.findIndex((id) => !id.startsWith("eh-"));
        expect(lastShared, source.id).toBeLessThan(firstOwn);
        expect(ids, source.id).toContain("eh-rule-listen");
      } else {
        expect(ids.some((id) => id.startsWith("eh-")), source.id).toBe(false);
        expect(ids[0], source.id).toBe("blob-storage-account");
      }
    }
  });

  it("gives the Defender export a Send rule and the auto-created-hub sources a Manage rule", () => {
    expect(stepsFor("defenderExport").map((s) => s.id)).toEqual([
      "eh-namespace",
      "eh-hub",
      "eh-rule-send",
      "eh-rule-listen",
      "eh-consumer-group",
      "eh-network",
      "defender-plans",
      "defender-provider",
      "defender-export",
    ]);
    const entra = stepsFor("entraId").map((s) => s.id);
    expect(entra).toContain("eh-rule-diagnostic");
    expect(entra).toContain("eh-consumer-group-auto");
    expect(entra).not.toContain("eh-rule-send");
    expect(entra).not.toContain("eh-hub");
    expect(stepsFor("activityLog").map((s) => s.id)).toEqual(
      expect.arrayContaining(["policy-identity", "activity-log-definition", "activity-log-assign", "activity-log-remediate"]),
    );
  });

  it("never checks the Manage rule with a check that accepts Send-only", () => {
    // 'eh-rule-send' is classified as Send OR Manage, so it would pass a
    // Send-only rule for the step whose whole point is Manage.
    expect(howToStep("eh-rule-diagnostic")!.checkKinds).toEqual([]);
    expect(howToStep("eh-rule-send")!.checkKinds).toEqual(["eh-rule-send"]);
  });

  it("shows ONE Manage rule step when the Defender export and an auto-created-hub source are both chosen", () => {
    for (const other of ["entraId", "activityLog"] as const) {
      const ids = stepsForSelection(["defenderExport", other]).map((s) => s.id);
      expect(ids, other).toContain("eh-rule-diagnostic");
      expect(ids, other).not.toContain("eh-rule-send");
      expect(ids, other).toContain("defender-export");
      expect(ids, other).toContain("eh-hub");
      expect(new Set(ids).size, other).toBe(ids.length);
      expect(ids.filter((id) => id === "eh-namespace").length, other).toBe(1);
      expect(ids[0], other).toBe("eh-namespace");
    }
    // The order of the selection does not matter, and alone each keeps its own rule.
    expect(stepsForSelection(["entraId", "defenderExport"]).map((s) => s.id)).toEqual(
      stepsForSelection(["defenderExport", "entraId"]).map((s) => s.id),
    );
    expect(stepsForSelection(["defenderExport"]).map((s) => s.id)).toEqual(stepsFor("defenderExport").map((s) => s.id));
    expect(stepsForSelection(["entraId"]).map((s) => s.id)).toEqual(stepsFor("entraId").map((s) => s.id));
    expect(stepsForSelection([])).toEqual([]);
  });

  it("gives XDR one named hub and its consumer group, and never offers Azure-created hubs", () => {
    const ids = stepsFor("xdrStreaming").map((s) => s.id);
    expect(ids).toContain("eh-hub");
    expect(ids).toContain("eh-consumer-group");
    expect(ids).not.toContain("eh-consumer-group-auto");
    const text = renderedTexts(renderStep(howToStep("xdr-streaming")!, FULL)).join("\n");
    expect(text).not.toMatch(/leave it empty|one hub per table/i);
    expect(text).toContain(FULL.hubName);
  });

  it("renders the Defender export values exactly as expectedExportFor", () => {
    const step = howToStep("defender-export")!;
    const rows = renderStep(step, FULL).values;
    const expected = expectedExportFor({
      subscriptionId: FULL.subscriptionId,
      namespace: { subscriptionId: FULL.subscriptionId, resourceGroup: FULL.resourceGroup, name: FULL.namespace },
      hubName: FULL.hubName,
    });
    expect(rows.find((r) => r.label === "Scope path")?.value).toBe(expected.scopePath);
    expect(rows.find((r) => r.label === "Event Hub resource ID")?.value).toBe(expected.eventHubResourceId);
    const body = JSON.parse(rows.find((r) => r.label === "Export body")!.value);
    // The WHOLE body is the Automated builder's, with only the connection
    // string stood in: a change to sources, isEnabled, description or location
    // there must show up here.
    const automated = buildAutomationPutRequest({
      subscriptionId: FULL.subscriptionId,
      resourceGroup: FULL.resourceGroup,
      location: FULL.region,
      namespace: { subscriptionId: FULL.subscriptionId, resourceGroup: FULL.resourceGroup, name: FULL.namespace },
      hubName: FULL.hubName,
      connectionString: CONNECTION_STRING_STAND_IN,
    });
    expect(body).toEqual(JSON.parse(JSON.stringify(automated.body)));
  });

  it("uses the scripts' names: Cribl-AU-Central, never the guide's name or the built-in namespace rule", () => {
    const text = allRenderedText(FULL).join("\n");
    expect(text).toContain("Cribl-AU-Central");
    expect(text).toContain("Cribl-Diag-EH-Central");
    expect(text).toContain("Cribl-ActivityLog");
    expect(text).toContain(LEGACY_POLICY_NAMES.activityLogCommunityName);
    expect(text).not.toContain("Cribl-DiagSettings-Audit-Centralized");
    expect(text).not.toContain("RootManageSharedAccessKey");
    expect(text).not.toContain("insights-logs-*");
  });

  it("pins the legacy-only names against the Logging Map's LEGACY_WRITER patterns", () => {
    const family = (id: string) => LEGACY_WRITER.families.find((f) => f.id === id)!;
    expect(family("built-in-audit").name.test(LEGACY_POLICY_NAMES.auditAssignment)).toBe(true);
    expect(family("community-initiative").name.test(LEGACY_POLICY_NAMES.communityAssignment)).toBe(true);
    expect(family("supplemental-activity-log").name.test(LEGACY_POLICY_NAMES.activityLogAssignment)).toBe(true);
    expect(
      family("supplemental-activity-log").definitions.some((d) => d.name.test(LEGACY_POLICY_NAMES.activityLogDefinition)),
    ).toBe(true);
    const auditRows = renderStep(howToStep("policy-audit-assign")!, FULL).values;
    expect(auditRows.find((r) => r.label === "Initiative ID")?.value).toBe(LEGACY_WRITER.builtInSetIds.audit);
  });

  it("tells every hand-created policy assignment to carry metadata.criblSocToolkit, which the Logging Map reads as ours (ADR 0006)", () => {
    const assigning = ALL_HOWTO_STEPS.filter((s) => s.cli.includes("az policy assignment create"));
    // The Audit, community and Activity Log assignments: an empty list would pass vacuously.
    expect(assigning.map((s) => s.id).sort()).toEqual(["activity-log-assign", "policy-audit-assign", "policy-community-assign"]);
    for (const step of assigning) {
      expect(step.cli, step.id).toContain(`--metadata @${MARKER_FILE}`);
      expect(step.portal.join("\n"), step.id).toContain(`metadata.${TOOLKIT_MARKER_KEY}`);
      expect(step.portal.join("\n"), step.id).toContain(`az policy assignment update --name`);
      const row = renderStep(step, FULL).values.find((r) => r.label === MARKER_ROW_LABEL);
      expect(row, step.id).toBeDefined();
      // Run the metadata through the recogniser on an assignment with NO legacy
      // shape, so only the marker can make it ours.
      const owner = recogniseOwner({
        id: "/providers/Microsoft.Management/managementGroups/mg/providers/Microsoft.Authorization/policyAssignments/Hand-Made",
        name: "Hand-Made",
        displayName: "",
        scope: "/providers/Microsoft.Management/managementGroups/mg",
        policyDefinitionId: "/providers/Microsoft.Authorization/policyDefinitions/not-legacy",
        definitionKind: "policy",
        notScopes: [],
        parameters: {},
        metadata: JSON.parse(row!.value) as Record<string, unknown>,
        identity: { type: "None", principalId: null, userAssigned: [] },
        enforcementMode: "Default",
        resourceSelectors: [],
      });
      expect(owner.owner, step.id).toBe("ours");
      expect(owner.strength, step.id).toBe("toolkit-marker");
    }
  });

  it("enables exactly the Standard categories for Entra Standard (and by default), without NonInteractiveUserSignInLogs", () => {
    const step = howToStep("entra-setting")!;
    for (const sub of [["Standard"], []]) {
      const rows = renderStep(step, FULL, sub).values;
      const cats = rows.find((r) => r.label === "Categories enabled")!.value;
      expect(cats).toBe(ENTRA_PROFILE_CATEGORIES.Standard.join(", "));
      expect(cats).not.toContain("NonInteractiveUserSignInLogs");
      const body = JSON.parse(rows.find((r) => r.label === "Setting body")!.value);
      const enabled = body.properties.logs.filter((l: { enabled: boolean }) => l.enabled).map((l: { category: string }) => l.category);
      expect(enabled).toEqual([...ENTRA_PROFILE_CATEGORIES.Standard]);
      expect(body.properties.eventHubName).toBe("");
    }
    const high = renderStep(step, FULL, ["HighVolume"]).values.find((r) => r.label === "Categories enabled")!.value;
    expect(high).toContain("NonInteractiveUserSignInLogs");
    expect(step.warning).toContain("NonInteractiveUserSignInLogs");
    expect(step.warning).toContain("SigninLogs");
  });

  it("with blank values reports every dependency missing, shows each stand-in, and never prints undefined", () => {
    for (const step of ALL_HOWTO_STEPS) {
      const r = renderStep(step, BLANK);
      expect(r.missing, step.id).toEqual([...new Set(step.dependsOnValues)]);
      const text = renderedTexts(r).join("\n");
      expect(text, step.id).not.toContain("undefined");
      expect(text, step.id).not.toContain("{{");
      for (const key of step.dependsOnValues) expect(text, `${step.id}: ${key}`).toContain(`<${key}>`);
    }
    for (const step of ALL_HOWTO_STEPS) expect(renderStep(step, FULL).missing, step.id).toEqual([]);
  });

  it("never prints a credential", () => {
    for (const values of [FULL, BLANK]) {
      for (const text of allRenderedText(values)) {
        expect(text).not.toMatch(/password\s*=/i);
        expect(text).not.toMatch(/SharedAccessKey\s*=/i);
        expect(text).not.toMatch(/AccountKey\s*=/i);
      }
    }
  });

  // The ui package's copy-history rules (packages/ui/src/components/copy-rules.ts),
  // mirrored because core imports nothing from ui. The drift pin below holds
  // these sources equal to the ui file's, so this IS the rule set the ui uses.
  const UI_RULE_SOURCES = [
    String.raw`\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b`,
    String.raw`\b[A-Z]{1,5}-[A-Z]{0,4}\d+[a-z]?\b`,
    String.raw`\b(?:phase|slice|spike|unit|milestone)\s+\d+(?:\.\d+)?\b`,
  ];
  const UI_ALLOWED_ID_PREFIXES = ["SHA", "UTF", "ISO", "AES", "RFC", "TLS", "SSL", "HTTP", "MD", "CVE", "WCAG", "IEEE", "ECMA", "RSA", "CRC", "SC"];
  function historyIn(text: string): string[] {
    const out: string[] = [];
    UI_RULE_SOURCES.forEach((src, i) => {
      for (const m of text.matchAll(new RegExp(src, i === 2 ? "gi" : "g"))) {
        if (i === 1 && UI_ALLOWED_ID_PREFIXES.includes(m[0].slice(0, m[0].indexOf("-")).toUpperCase())) continue;
        out.push(m[0]);
      }
    });
    return out;
  }

  it("mirrors the ui copy-history rules exactly (drift pin)", () => {
    const ui = readFileSync(join(HERE, "../../../../ui/src/components/copy-rules.ts"), "utf8");
    for (const src of UI_RULE_SOURCES) expect(ui, src).toContain(`re: /${src}/g`);
    for (const p of UI_ALLOWED_ID_PREFIXES) expect(ui, p).toContain(`'${p}'`);
  });

  it("carries no project history in visible copy, with api-versions the one masked allowance", () => {
    const steps = ALL_HOWTO_STEPS.flatMap((step) => SUBSELECTIONS.map((sub) => renderStep(step, FULL, sub)));
    // Without the allowance the ui rule DOES fire (api-versions are dates), so
    // consumers must scan copyCheckTexts, not renderedTexts.
    expect(steps.flatMap((r) => renderedTexts(r)).some((t) => historyIn(t).length > 0)).toBe(true);
    for (const r of steps) {
      for (const text of copyCheckTexts(r)) expect(historyIn(text), `${r.id}: ${text}`).toEqual([]);
    }
    expect(steps.flatMap((r) => copyCheckTexts(r)).join("\n")).toContain(`api-version=${API_VERSION_MASK}`);
  });

  it("masks only api-version values, so a date elsewhere still fails", () => {
    const r = renderStep(howToStep("eh-namespace")!, { ...FULL, namespace: "ns-2026-01-01" });
    expect(copyCheckTexts(r).some((t) => historyIn(t).length > 0)).toBe(true);
  });

  it("lists exactly these steps as not yet confirmed against live Azure", () => {
    expect(ALL_HOWTO_STEPS.filter((s) => s.provenance === "inferred").map((s) => s.id)).toEqual([
      "eh-rule-diagnostic",
      "eh-consumer-group-auto",
      "eh-network",
      "policy-audit-remediate",
      "policy-community-remediate",
      "activity-log-remediate",
      "defender-provider",
      "xdr-streaming",
      "blob-flow-log-nsg",
      "blob-rbac",
    ]);
  });
});
