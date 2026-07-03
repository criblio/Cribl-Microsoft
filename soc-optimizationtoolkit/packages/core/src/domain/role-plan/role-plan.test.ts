/**
 * Tests for the canonical RBAC role plan.
 *
 *   1. rolePlanForSetupPath returns the exact roles, scope levels, and
 *      conditions per path (lab-new-rg carries the RBAC Administrator entry with
 *      its condition + assignViaPortal; existing does not).
 *   2. CHARACTERIZATION: renderRoleAssignmentCli reproduces the setup wizard's
 *      legacy buildAzScript output BYTE-FOR-BYTE, for all three paths, with both
 *      all-blank params (placeholders appear) and filled params. The full
 *      expected strings are pinned so any drift fails.
 */
import { describe, expect, it } from "vitest";
import { renderRoleAssignmentCli, rolePlanForSetupPath } from "./index";
import type { RoleAssignmentCliParams } from "./index";

const BLANK: RoleAssignmentCliParams = {
  clientId: "",
  subscriptionId: "",
  resourceGroup: "",
};

const FILLED: RoleAssignmentCliParams = {
  clientId: "CID",
  subscriptionId: "SUB",
  resourceGroup: "RG",
};

describe("rolePlanForSetupPath", () => {
  it("returns the existing-path roles, scope levels, and justifications", () => {
    expect(rolePlanForSetupPath("existing")).toEqual([
      {
        role: "Reader",
        scopeLevel: "subscription",
        justification:
          "Discover subscriptions, resource groups, workspaces, and existing DCRs before deploying.",
      },
      {
        role: "Monitoring Contributor",
        scopeLevel: "resourceGroup",
        justification:
          "Create and update Data Collection Rules in the workspace resource group.",
      },
      {
        role: "Log Analytics Contributor",
        scopeLevel: "resourceGroup",
        justification:
          "Create custom Log Analytics tables and configure the workspace for ingestion.",
      },
    ]);
  });

  it("existing has no portal-assigned or conditioned role", () => {
    const plan = rolePlanForSetupPath("existing");
    expect(plan.some((r) => r.assignViaPortal === true)).toBe(false);
    expect(plan.some((r) => r.condition !== undefined)).toBe(false);
    expect(plan.some((r) => r.role === "RBAC Administrator")).toBe(false);
  });

  it("returns the lab-new-rg roles with the RBAC Administrator condition + portal flag", () => {
    expect(rolePlanForSetupPath("lab-new-rg")).toEqual([
      {
        role: "Contributor",
        scopeLevel: "subscription",
        justification:
          "Create the lab resource group and deploy the workspace, DCRs, and tables inside it (resource group creation is a subscription-level action, so no workspace-scoped roles are needed on this path).",
      },
      {
        role: "RBAC Administrator",
        scopeLevel: "subscription",
        justification:
          "Assign the lab TTL self-destruct identity its delete role at deploy time.",
        condition:
          "Constrain roles and principal types: only Contributor and Monitoring Metrics Publisher, only to service principals.",
        assignViaPortal: true,
      },
    ]);
  });

  it("lab-new-rg's RBAC Administrator is the only portal-assigned, conditioned role", () => {
    const plan = rolePlanForSetupPath("lab-new-rg");
    const portal = plan.filter((r) => r.assignViaPortal === true);
    expect(portal).toHaveLength(1);
    expect(portal[0]?.role).toBe("RBAC Administrator");
    expect(portal[0]?.condition).toBe(
      "Constrain roles and principal types: only Contributor and Monitoring Metrics Publisher, only to service principals.",
    );
  });

  it("returns the single lab-byo-rg resource-group Contributor role", () => {
    expect(rolePlanForSetupPath("lab-byo-rg")).toEqual([
      {
        role: "Contributor",
        scopeLevel: "resourceGroup",
        justification:
          "Deploy the lab workspace, DCRs, and tables into the pre-created lab resource group; no subscription-scope rights are needed.",
      },
    ]);
  });
});

describe("renderRoleAssignmentCli - characterization (byte-for-byte with legacy buildAzScript)", () => {
  it("existing, all-blank params -> placeholders", () => {
    expect(renderRoleAssignmentCli("existing", BLANK)).toBe(
      [
        "# Existing workspace: least privilege, scoped to its resource group",
        'az role assignment create --assignee <clientId> --role "Reader" --scope /subscriptions/<subscriptionId>',
        'az role assignment create --assignee <clientId> --role "Monitoring Contributor" --scope /subscriptions/<subscriptionId>/resourceGroups/<workspaceRg>',
        'az role assignment create --assignee <clientId> --role "Log Analytics Contributor" --scope /subscriptions/<subscriptionId>/resourceGroups/<workspaceRg>',
      ].join("\n"),
    );
  });

  it("existing, filled params", () => {
    expect(renderRoleAssignmentCli("existing", FILLED)).toBe(
      [
        "# Existing workspace: least privilege, scoped to its resource group",
        'az role assignment create --assignee CID --role "Reader" --scope /subscriptions/SUB',
        'az role assignment create --assignee CID --role "Monitoring Contributor" --scope /subscriptions/SUB/resourceGroups/RG',
        'az role assignment create --assignee CID --role "Log Analytics Contributor" --scope /subscriptions/SUB/resourceGroups/RG',
      ].join("\n"),
    );
  });

  it("lab-new-rg, all-blank params -> placeholders, RBAC Administrator not emitted as a command", () => {
    expect(renderRoleAssignmentCli("lab-new-rg", BLANK)).toBe(
      [
        "# Lab creates its own resource group and workspace: subscription Contributor",
        "# covers RG creation plus all workspace/DCR operations inside the lab, so no",
        "# workspace-scoped roles are needed on this path.",
        'az role assignment create --assignee <clientId> --role "Contributor" --scope /subscriptions/<subscriptionId>',
        "# Assign RBAC Administrator via the Azure portal so you can add the condition",
        '# "Constrain roles and principal types": only Contributor and Monitoring',
        "# Metrics Publisher, only to service principals (the lab TTL self-destruct",
        "# assigns its delete role at deploy time).",
      ].join("\n"),
    );
  });

  it("lab-new-rg, filled params", () => {
    expect(renderRoleAssignmentCli("lab-new-rg", FILLED)).toBe(
      [
        "# Lab creates its own resource group and workspace: subscription Contributor",
        "# covers RG creation plus all workspace/DCR operations inside the lab, so no",
        "# workspace-scoped roles are needed on this path.",
        'az role assignment create --assignee CID --role "Contributor" --scope /subscriptions/SUB',
        "# Assign RBAC Administrator via the Azure portal so you can add the condition",
        '# "Constrain roles and principal types": only Contributor and Monitoring',
        "# Metrics Publisher, only to service principals (the lab TTL self-destruct",
        "# assigns its delete role at deploy time).",
      ].join("\n"),
    );
  });

  it("lab-byo-rg, all-blank params -> placeholders", () => {
    expect(renderRoleAssignmentCli("lab-byo-rg", BLANK)).toBe(
      [
        "# Pre-created lab resource group: least privilege for labs; the lab deploys",
        "# its workspace and resources into this RG with no subscription-scope rights.",
        'az role assignment create --assignee <clientId> --role "Contributor" --scope /subscriptions/<subscriptionId>/resourceGroups/<labRg>',
        "# An admin must pre-assign the TTL self-destruct identity its delete rights",
        "# on this resource group (the app cannot assign roles on this path).",
      ].join("\n"),
    );
  });

  it("lab-byo-rg, filled params", () => {
    expect(renderRoleAssignmentCli("lab-byo-rg", FILLED)).toBe(
      [
        "# Pre-created lab resource group: least privilege for labs; the lab deploys",
        "# its workspace and resources into this RG with no subscription-scope rights.",
        'az role assignment create --assignee CID --role "Contributor" --scope /subscriptions/SUB/resourceGroups/RG',
        "# An admin must pre-assign the TTL self-destruct identity its delete rights",
        "# on this resource group (the app cannot assign roles on this path).",
      ].join("\n"),
    );
  });
});
