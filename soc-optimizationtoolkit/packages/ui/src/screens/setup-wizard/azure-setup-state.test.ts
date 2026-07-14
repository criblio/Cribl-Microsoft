/**
 * Pins for azure-setup-state - the pure decisions behind the Setup page's
 * Azure sections, promoted from the cloud shell's live-tested Diagnostics
 * panels 3 and 4. The parsing tolerances, the actionable ARM error messages,
 * and the setup-path -> permission-scope mapping are behavior the panels
 * proved live; these pins keep the extraction faithful.
 */

import { describe, expect, it } from "vitest";
import { REQUIRED_ACTIONS } from "@soc/core";
import {
  armFailureMessage,
  connectInputIssue,
  evaluateScopeLines,
  parseResourceGroupOptions,
  parseSubscriptionOptions,
  parseWorkspaceOptions,
  permissionScopeChecks,
  resourceGroupSelectOptions,
  scriptCopyFeedback,
  scriptDownloadFeedback,
  storedCredentialReport,
  subscriptionSelectOptions,
  workspaceSelectOptions,
  wrapRoleScript,
} from "./azure-setup-state";

describe("parseSubscriptionOptions", () => {
  it("maps id + displayName and defaults a missing displayName", () => {
    const body = {
      value: [
        { subscriptionId: "sub-1", displayName: "Pay-As-You-Go" },
        { subscriptionId: "sub-2" },
      ],
    };
    expect(parseSubscriptionOptions(body)).toEqual([
      { subscriptionId: "sub-1", displayName: "Pay-As-You-Go" },
      { subscriptionId: "sub-2", displayName: "(no displayName)" },
    ]);
  });

  it("drops entries without a subscriptionId and tolerates junk shapes", () => {
    expect(parseSubscriptionOptions({ value: [{ displayName: "x" }, null, 42] })).toEqual([]);
    expect(parseSubscriptionOptions(null)).toEqual([]);
    expect(parseSubscriptionOptions("HTML error page")).toEqual([]);
    expect(parseSubscriptionOptions({ value: "not-a-list" })).toEqual([]);
  });
});

describe("parseWorkspaceOptions / parseResourceGroupOptions", () => {
  it("keeps only complete workspace entries (name AND id)", () => {
    const body = {
      value: [
        { name: "ws-1", id: "/subscriptions/s/resourceGroups/rg-1/..." },
        { name: "incomplete" },
        { id: "/only-id" },
      ],
    };
    expect(parseWorkspaceOptions(body)).toEqual([
      { name: "ws-1", id: "/subscriptions/s/resourceGroups/rg-1/..." },
    ]);
  });

  it("keeps only named resource groups", () => {
    expect(parseResourceGroupOptions({ value: [{ name: "rg-a" }, {}, { name: "" }] })).toEqual([
      { name: "rg-a" },
    ]);
  });
});

describe("select option mappings", () => {
  it("labels subscriptions as 'displayName (id)' with the id as value", () => {
    expect(
      subscriptionSelectOptions([{ subscriptionId: "sub-1", displayName: "Prod" }]),
    ).toEqual([{ value: "sub-1", label: "Prod (sub-1)" }]);
  });

  it("uses the bare name for workspaces and resource groups", () => {
    expect(workspaceSelectOptions([{ name: "ws", id: "x" }])).toEqual([
      { value: "ws", label: "ws" },
    ]);
    expect(resourceGroupSelectOptions([{ name: "rg" }])).toEqual([
      { value: "rg", label: "rg" },
    ]);
  });
});

describe("armFailureMessage", () => {
  it("401 points at reconnecting (the adapter already retried the token once)", () => {
    const msg = armFailureMessage("Subscriptions", 401, null);
    expect(msg).toContain("Subscriptions: HTTP 401");
    expect(msg).toContain("Save and connect again");
  });

  it("403 points at the role assignment script", () => {
    const msg = armFailureMessage("Workspaces", 403, null);
    expect(msg).toContain("Workspaces: HTTP 403");
    expect(msg).toContain("role assignment script");
  });

  it("other statuses carry the raw body for diagnosis", () => {
    expect(armFailureMessage("Subscriptions", 500, { error: "boom" })).toBe(
      'Subscriptions: HTTP 500\n{"error":"boom"}',
    );
  });
});

describe("connectInputIssue", () => {
  const full = { tenantId: "t", clientId: "c", clientSecret: "s" };

  it("accepts a complete input", () => {
    expect(connectInputIssue(full)).toBeNull();
  });

  it("requires client id and secret together", () => {
    expect(connectInputIssue({ ...full, clientId: " " })).toContain(
      "Client ID and client secret",
    );
    expect(connectInputIssue({ ...full, clientSecret: "" })).toContain(
      "Client ID and client secret",
    );
  });

  it("requires the tenant id for the token flow", () => {
    expect(connectInputIssue({ ...full, tenantId: " " })).toContain("Tenant ID is required");
  });
});

describe("permissionScopeChecks", () => {
  it("existing: both scopes when fully selected, with encoded ARM paths", () => {
    const checks = permissionScopeChecks("existing", "sub 1", "rg/x");
    expect(checks).toHaveLength(2);
    expect(checks[0]).toMatchObject({
      kind: "check",
      label: "Subscription scope (existing-subscription)",
      permissionsPath:
        "/subscriptions/sub%201/providers/Microsoft.Authorization/permissions",
      required: REQUIRED_ACTIONS["existing-subscription"],
    });
    expect(checks[1]).toMatchObject({
      kind: "check",
      label: "Resource group scope (existing-rg)",
      permissionsPath:
        "/subscriptions/sub%201/resourceGroups/rg%2Fx/providers/Microsoft.Authorization/permissions",
      required: REQUIRED_ACTIONS["existing-rg"],
    });
  });

  it("existing: blank inputs degrade to needs-input messages, never failures", () => {
    const checks = permissionScopeChecks("existing", "", "");
    expect(checks.map((c) => c.kind)).toEqual(["needs-input", "needs-input"]);
    const subOnly = permissionScopeChecks("existing", "sub-1", " ");
    expect(subOnly[0].kind).toBe("check");
    expect(subOnly[1].kind).toBe("needs-input");
  });

  it("lab-new-rg: subscription scope only", () => {
    expect(permissionScopeChecks("lab-new-rg", "", "")).toEqual([
      { kind: "needs-input", message: expect.stringContaining("lab-new-rg-subscription") },
    ]);
    const checks = permissionScopeChecks("lab-new-rg", "sub-1", "ignored");
    expect(checks).toEqual([
      {
        kind: "check",
        label: "Subscription scope (lab-new-rg-subscription)",
        permissionsPath: "/subscriptions/sub-1/providers/Microsoft.Authorization/permissions",
        required: REQUIRED_ACTIONS["lab-new-rg-subscription"],
      },
    ]);
  });

  it("lab-byo-rg: the pre-created resource group scope only", () => {
    expect(permissionScopeChecks("lab-byo-rg", "sub-1", "")).toEqual([
      { kind: "needs-input", message: expect.stringContaining("lab-byo-rg") },
    ]);
    const checks = permissionScopeChecks("lab-byo-rg", "sub-1", "lab-rg");
    expect(checks).toEqual([
      {
        kind: "check",
        label: "Resource group scope (lab-byo-rg)",
        permissionsPath:
          "/subscriptions/sub-1/resourceGroups/lab-rg/providers/Microsoft.Authorization/permissions",
        required: REQUIRED_ACTIONS["lab-byo-rg"],
      },
    ]);
  });
});

describe("evaluateScopeLines", () => {
  const required = REQUIRED_ACTIONS["lab-byo-rg"];

  it("summarizes an all-granted scope with one line per required action", () => {
    const body = { value: [{ actions: ["*"], notActions: [] }] };
    const lines = evaluateScopeLines("RG scope", 200, body, required);
    expect(lines[0]).toBe("RG scope: all required actions granted");
    expect(lines).toHaveLength(1 + required.length);
    for (const line of lines.slice(1)) {
      expect(line).toMatch(/^ {2}\[ok\] /);
    }
  });

  it("flags missing actions", () => {
    const body = { value: [{ actions: [], notActions: [] }] };
    const lines = evaluateScopeLines("RG scope", 200, body, required);
    expect(lines[0]).toBe("RG scope: MISSING required actions");
    expect(lines.slice(1).every((l) => l.startsWith("  [missing]"))).toBe(true);
  });

  it("renders actionable 401/403 messages and surfaces surprising shapes", () => {
    expect(evaluateScopeLines("S", 401, null, required)[0]).toContain("HTTP 401");
    expect(evaluateScopeLines("S", 403, null, required)[0]).toContain(
      "cannot even read permissions",
    );
    expect(evaluateScopeLines("S", 500, "err", required)[0]).toBe("S: HTTP 500\nerr");
    expect(evaluateScopeLines("S", 200, { unexpected: true }, required)[0]).toContain(
      "unexpected permissions response shape",
    );
  });
});

describe("storedCredentialReport", () => {
  it("reports present secret/token keys and the remembered tenant", () => {
    const report = storedCredentialReport(
      ["azureBasic", "azureArmToken", "azureProfiles"],
      " tenant-1 ",
      "Stored in KV for app ID app-1:",
    );
    expect(report.azureBasicPresent).toBe(true);
    expect(report.tenant).toBe("tenant-1");
    expect(report.lines[0]).toBe("Stored in KV for app ID app-1:");
    expect(report.lines[1]).toContain("client secret: stored");
    expect(report.lines[2]).toContain("tenant ID: tenant-1");
    expect(report.lines[3]).toContain("azureArmToken: present");
  });

  it("names the App registration and connect section when things are absent", () => {
    const report = storedCredentialReport([], "", "Stored credentials:");
    expect(report.azureBasicPresent).toBe(false);
    expect(report.lines[1]).toContain("App registration and connect");
    expect(report.lines[2]).toContain("not saved");
    expect(report.lines[3]).toContain("not yet acquired");
  });
});

describe("role script helpers", () => {
  it("feedback warns about placeholders exactly when the script has them", () => {
    expect(scriptCopyFeedback("az role assignment <subscription>")).toContain("<placeholders>");
    expect(scriptCopyFeedback("az role assignment full")).toContain("Copied to clipboard.");
    expect(scriptDownloadFeedback("<rg>")).toContain("<placeholders>");
    expect(scriptDownloadFeedback("ok")).toContain("bash assign-roles.sh");
  });

  it("wraps the download body with a strict-mode shebang", () => {
    expect(wrapRoleScript("az foo")).toBe(
      "#!/usr/bin/env bash\nset -euo pipefail\n\naz foo\n",
    );
  });
});
