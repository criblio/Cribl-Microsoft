/**
 * Pins for the content-install usecases (2026-07-14): per-item ARM installs
 * over the AzureManagement port with success/failure outcomes, installed-
 * state partitioning (best-effort per dimension), and the solution
 * fetch-then-deploy flow.
 */

import { describe, expect, it } from "vitest";
import { FakeAzureManagement } from "../../testing/index";
import type { ParsedAnalyticRule } from "../../domain/coverage-analysis/index";
import {
  installAnalyticRule,
  installWorkbook,
  installSolution,
  installedContentState,
  onboardSentinelWorkspace,
} from "./content-install";
import type { WorkspaceScope } from "./content-install";

const WS: WorkspaceScope = {
  subscriptionId: "sub",
  resourceGroup: "rg",
  workspaceName: "law",
  location: "eastus",
};

const mintId = () => "11111111-2222-3333-4444-555555555555";

function rule(over: Partial<ParsedAnalyticRule>): ParsedAnalyticRule {
  return {
    id: "id",
    name: "Rule",
    severity: "Medium",
    tactics: [],
    dataTypes: [],
    query: "Table | take 1",
    entityFields: [],
    fileName: "r.yaml",
    ...over,
  };
}

describe("installAnalyticRule", () => {
  it("PUTs a scheduled rule and reports success", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 200, body: {} });
    const outcome = await installAnalyticRule(azure, WS, rule({}), mintId);
    expect(outcome).toEqual({ name: "Rule", ok: true, detail: "installed (Scheduled)" });
    const call = azure.calls[0];
    expect(call.method).toBe("PUT");
    expect(call.path).toContain("/providers/Microsoft.SecurityInsights/alertRules/");
    expect(call.apiVersion).toBe("2025-09-01");
  });

  it("uses the preview api-version for NRT", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 201, body: {} });
    await installAnalyticRule(azure, WS, rule({ kind: "NRT" }), mintId);
    expect(azure.calls[0].apiVersion).toBe("2025-10-01-preview");
  });

  it("reports the HTTP failure verbatim, never throwing", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 400, body: { error: "bad" } });
    const outcome = await installAnalyticRule(azure, WS, rule({}), mintId);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("HTTP 400");
  });

  it("skips unsupported kinds without any ARM call", async () => {
    const azure = new FakeAzureManagement();
    const outcome = await installAnalyticRule(azure, WS, rule({ kind: "Fusion" }), mintId);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("skipped:");
    expect(azure.calls).toHaveLength(0);
  });
});

describe("installWorkbook", () => {
  it("PUTs a workbook resource linked to the workspace", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 200, body: {} });
    const outcome = await installWorkbook(
      azure,
      WS,
      { displayName: "Overview", serializedData: '{"items":[]}' },
      mintId,
    );
    expect(outcome).toEqual({ name: "Overview", ok: true, detail: "installed" });
    expect(azure.calls[0].path).toContain("/providers/Microsoft.Insights/workbooks/");
    expect(azure.calls[0].apiVersion).toBe("2021-08-01");
  });
});

describe("installedContentState", () => {
  it("collects installed rule + workbook names and the solution version", async () => {
    const azure = new FakeAzureManagement();
    // contentPackages, then alertRules, then workbooks (FIFO).
    azure.respondWith(
      {
        status: 200,
        body: { value: [{ properties: { contentId: "cf-id", version: "2.0.1" } }] },
      },
      {
        status: 200,
        body: { value: [{ properties: { displayName: "Cloudflare - Bad IP" } }] },
      },
      {
        status: 200,
        body: { value: [{ properties: { displayName: "Cloudflare Overview" } }] },
      },
    );
    const state = await installedContentState(azure, WS, "cf-id");
    expect(state.solutionInstalled).toBe(true);
    expect(state.installedSolutionVersion).toBe("2.0.1");
    expect(state.installedRuleNames.has("cloudflare - bad ip")).toBe(true);
    expect(state.installedWorkbookNames.has("cloudflare overview")).toBe(true);
    expect(state.notes).toEqual([]);
  });

  it("degrades a failed listing to a note, not an error", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 200, body: { value: [] } }, // packages: not installed
      { status: 403, body: "denied" }, // alertRules fails
      { status: 200, body: { value: [] } }, // workbooks: none
    );
    const state = await installedContentState(azure, WS, "cf-id");
    expect(state.solutionInstalled).toBe(false);
    expect(state.installedRuleNames.size).toBe(0);
    expect(state.notes.some((n) => n.includes("analytics rules"))).toBe(true);
    expect(state.notOnboarded).toBe(false);
  });

  it("flags a not-onboarded workspace instead of a raw ARM note", async () => {
    const azure = new FakeAzureManagement();
    // The EXACT double-encoded shape ARM returns live (2026-07-15): the outer
    // message is itself a JSON string containing the not-onboarded error.
    const notOnboarded = {
      error: {
        code: "BadRequest",
        message: JSON.stringify({
          error: {
            code: "BadRequest",
            message:
              "Workspace 'law-jpederson-eastus' is not onboarded to Microsoft Sentinel. " +
              "Please onboard through the portal or use the OnboardingStates ARM api to onboard to Sentinel.",
          },
        }),
      },
    };
    azure.respondWith(
      { status: 400, body: notOnboarded }, // packages
      { status: 400, body: notOnboarded }, // alertRules
      { status: 200, body: { value: [] } }, // workbooks (Insights, unaffected)
    );
    const state = await installedContentState(azure, WS, "cf-id");
    expect(state.notOnboarded).toBe(true);
    // The raw ARM error is NOT pushed as a note - the UI shows an Enable action.
    expect(state.notes.some((n) => n.includes("not onboarded"))).toBe(false);
  });
});

describe("onboardSentinelWorkspace", () => {
  it("PUTs the modern onboardingStates/default resource and reports success", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 200, body: {} });
    const outcome = await onboardSentinelWorkspace(azure, WS);
    expect(outcome.ok).toBe(true);
    const call = azure.calls[0];
    expect(call.method).toBe("PUT");
    expect(call.path).toContain(
      "/providers/Microsoft.SecurityInsights/onboardingStates/default",
    );
    expect(call.apiVersion).toBe("2024-03-01");
    expect(call.body).toEqual({ properties: {} });
  });

  it("reports the failure verbatim without throwing", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 403, body: { error: "Forbidden" } });
    const outcome = await onboardSentinelWorkspace(azure, WS);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("HTTP 403");
  });
});

describe("installSolution", () => {
  it("installs via the contentPackages PUT, sourcing fields from the product package", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      {
        status: 200,
        body: {
          properties: {
            contentId: "cloudflare.pkg",
            contentProductId: "cloudflare.pkg-sl-abc123",
            contentKind: "Solution",
            displayName: "Cloudflare (Deprecated)",
            version: "2.0.3",
          },
        },
      },
      { status: 200, body: { properties: { installedVersion: "2.0.3" } } },
    );
    const outcome = await installSolution(azure, WS, "cloudflare.pkg", "Cloudflare");
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain("installed (version 2.0.3)");
    const [get, put] = azure.calls;
    expect(get.path).toContain("/contentProductPackages/cloudflare.pkg");
    expect(put.method).toBe("PUT");
    // The first-class install operation - NOT a Microsoft.Resources/deployments.
    expect(put.path).toContain("/contentPackages/cloudflare.pkg");
    expect(put.path).not.toContain("/Microsoft.Resources/deployments/");
    expect(put.apiVersion).toBe("2025-09-01");
    const body = put.body as { properties: Record<string, unknown> };
    expect(body.properties).toEqual({
      contentId: "cloudflare.pkg",
      contentProductId: "cloudflare.pkg-sl-abc123",
      contentKind: "Solution",
      displayName: "Cloudflare (Deprecated)",
      version: "2.0.3",
    });
  });

  it("reports the install PUT failure verbatim, never throwing", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      {
        status: 200,
        body: {
          properties: {
            contentId: "c",
            contentProductId: "c-sl",
            contentKind: "Solution",
            version: "1.0.0",
          },
        },
      },
      { status: 400, body: { error: "bad" } },
    );
    const outcome = await installSolution(azure, WS, "c", "Sol");
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("HTTP 400");
  });

  it("fails honestly when the product package lacks required install fields", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 200, body: { properties: {} } });
    const outcome = await installSolution(azure, WS, "pkg", "Sol");
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("missing required install fields");
    // No install PUT is attempted when the package is unusable.
    expect(azure.calls).toHaveLength(1);
  });
});
