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
  });
});

describe("installSolution", () => {
  it("fetches packagedContent then deploys it, reporting acceptance", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 200, body: { properties: { packagedContent: { resources: [] } } } },
      { status: 200, body: {} },
    );
    const outcome = await installSolution(azure, WS, "cloudflare.pkg", "Cloudflare");
    expect(outcome.ok).toBe(true);
    const [get, put] = azure.calls;
    expect(get.path).toContain("/contentProductPackages/cloudflare.pkg");
    expect(put.method).toBe("PUT");
    expect(put.path).toContain("/Microsoft.Resources/deployments/");
    const body = put.body as { properties: { template: unknown } };
    expect(body.properties.template).toEqual({ resources: [] });
  });

  it("fails honestly when the package has no deployable template", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 200, body: { properties: {} } });
    const outcome = await installSolution(azure, WS, "pkg", "Sol");
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("no deployable template");
  });
});
