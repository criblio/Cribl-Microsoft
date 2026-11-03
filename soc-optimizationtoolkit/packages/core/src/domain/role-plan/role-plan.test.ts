/**
 * Tests for the canonical RBAC role plan.
 *
 *   1. rolePlanForSetupPath returns the exact roles, scope levels, and
 *      conditions per path (lab-new-rg carries the RBAC Administrator entry with
 *      its condition + assignViaPortal; existing does not).
 *   2. CHARACTERIZATION: renderRoleAssignmentCli's command lines, for all
 *      three paths, with all-blank params (placeholders appear) and filled
 *      params. The existing path is pinned byte-for-byte. The lab paths' portal
 *      comment block is built from the plan's portal row (AZR-61 review), so
 *      it is pinned by what it must carry - the registry's role and the
 *      condition - rather than by restating either.
 */
import { describe, expect, it } from "vitest";
import { LAB_RBAC_CONDITION, renderRoleAssignmentCli, rolePlanForSetupPath } from "./index";
import { leastRoleFor } from "../least-privilege";
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
        feature: "Discovery and gap analysis",
        withoutIt:
          "The app cannot find your workspace or read the DCRs already deployed, so every screen that starts from your environment is empty and gap analysis has nothing to compare against.",
      },
      {
        role: "Monitoring Contributor",
        scopeLevel: "resourceGroup",
        justification:
          "Create and update Data Collection Rules in the workspace resource group.",
        feature: "Deploy Data Collection Rules",
        withoutIt:
          "The app can still generate the DCR ARM template for someone else to deploy, but cannot deploy it itself - no data path is created.",
      },
      {
        role: "Log Analytics Contributor",
        scopeLevel: "resourceGroup",
        justification:
          "Create custom Log Analytics tables and configure the workspace for ingestion.",
        feature: "Create custom tables",
        withoutIt:
          "Onboarding a source to a table that does not exist yet fails; existing native tables can still be targeted.",
      },
    ]);
  });

  it("every role says which feature needs it and what refusing it costs", () => {
    // Re-pinned 2026-08-11 alongside the two added fields. They live on the
    // canonical plan rather than in a ticket generator so the CLI, the role
    // ticket, and the app-registration ticket cannot describe the same role
    // three different ways - the drift this module was created to end.
    for (const path of ["existing", "lab-new-rg", "lab-byo-rg"] as const) {
      for (const req of rolePlanForSetupPath(path)) {
        expect(req.feature.length, `${path}/${req.role}`).toBeGreaterThan(0);
        expect(req.withoutIt.length, `${path}/${req.role}`).toBeGreaterThan(20);
      }
    }
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
        feature: "Deploy the lab environment",
        withoutIt:
          "Nothing on this path runs - the lab cannot create its resource group, so there is nowhere to deploy.",
      },
      {
        role: "RBAC Administrator",
        scopeLevel: "subscription",
        justification:
          "Assign the lab TTL self-destruct identity its delete role at deploy time.",
        condition:
          "Constrain roles and principal types: only Contributor and Monitoring Metrics Publisher, only to service principals.",
        assignViaPortal: true,
        feature: "Lab TTL self-destruct",
        withoutIt:
          "The lab deploys but never auto-deletes, so it lingers as orphaned cost until someone removes it by hand.",
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

  it("returns the lab-byo-rg resource-group Contributor role, then RBAC Administrator for the TTL grant", () => {
    // AZR-61 audit (medium): the foundation phase assigns the TTL identity
    // Contributor in BOTH resource-group modes (foundation-phase.ts), and a
    // failed assignment aborts the deploy. The plan used to say the app could
    // not assign roles on this path; it does, every time.
    expect(rolePlanForSetupPath("lab-byo-rg")).toEqual([
      {
        role: "Contributor",
        scopeLevel: "resourceGroup",
        justification:
          "Deploy the lab workspace, DCRs, and tables into the pre-created lab resource group. The grant reaches nothing outside it: the Event Grid provider registration (subscription) and the regional Network Watcher (NetworkWatcherRG) need rights there, or an admin who registers the provider and creates the watcher first.",
        feature: "Deploy the lab environment",
        withoutIt:
          "Nothing on this path runs - there is no other scope the lab is allowed to deploy into.",
      },
      {
        role: "RBAC Administrator",
        scopeLevel: "resourceGroup",
        justification:
          "Assign the lab TTL self-destruct identity its delete role on the lab resource group at deploy time.",
        condition:
          "Constrain roles and principal types: only Contributor and Monitoring Metrics Publisher, only to service principals.",
        assignViaPortal: true,
        feature: "Lab TTL self-destruct",
        withoutIt:
          "The deploy stops at the TTL step: a lab with no working self-destruct is never left running.",
      },
    ]);
  });

  it("reads every role name it can from the least-privilege registry (AZR-61)", () => {
    // The existing path asks for one least role per job; the two lab umbrella
    // grants (Contributor) are the one deliberate exception, documented in
    // rolePlanForSetupPath.
    expect(rolePlanForSetupPath("existing").map((r) => r.role)).toEqual([
      leastRoleFor("subscriptions.list"),
      leastRoleFor("dcr.write"),
      leastRoleFor("table.write"),
    ]);
    for (const path of ["lab-new-rg", "lab-byo-rg"] as const) {
      const rbac = rolePlanForSetupPath(path).find((r) => r.assignViaPortal === true);
      expect(rbac?.role, path).toBe(leastRoleFor("lab.roleAssignment.write"));
    }
  });
});

describe("renderRoleAssignmentCli - characterization", () => {
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

  /** The comment lines of a script, unwrapped into one string. */
  const commentText = (cli: string): string =>
    cli
      .split("\n")
      .filter((line) => line.startsWith("#"))
      .map((line) => line.replace(/^# ?/, ""))
      .join(" ");
  const commandLines = (cli: string): string[] => cli.split("\n").filter((line) => !line.startsWith("#"));

  it("lab-new-rg: one Contributor command; the RBAC Administrator grant is a portal comment, never a command", () => {
    expect(commandLines(renderRoleAssignmentCli("lab-new-rg", BLANK))).toEqual([
      'az role assignment create --assignee <clientId> --role "Contributor" --scope /subscriptions/<subscriptionId>',
    ]);
    expect(commandLines(renderRoleAssignmentCli("lab-new-rg", FILLED))).toEqual([
      'az role assignment create --assignee CID --role "Contributor" --scope /subscriptions/SUB',
    ]);
  });

  it("lab-byo-rg: one resource-group Contributor command; the RBAC Administrator grant is a portal comment", () => {
    expect(commandLines(renderRoleAssignmentCli("lab-byo-rg", BLANK))).toEqual([
      'az role assignment create --assignee <clientId> --role "Contributor" --scope /subscriptions/<subscriptionId>/resourceGroups/<labRg>',
    ]);
    expect(commandLines(renderRoleAssignmentCli("lab-byo-rg", FILLED))).toEqual([
      'az role assignment create --assignee CID --role "Contributor" --scope /subscriptions/SUB/resourceGroups/RG',
    ]);
  });

  it("names the portal grant by the registry's role and the plan's condition, on both lab paths", () => {
    // Found by review (AZR-61): the comment block restated "RBAC Administrator"
    // and the condition word for word, and it is the only place the script
    // names that grant - a registry or condition change would have left the
    // script Setup hands out asking for the old one.
    for (const path of ["lab-new-rg", "lab-byo-rg"] as const) {
      const text = commentText(renderRoleAssignmentCli(path, FILLED));
      expect(text, path).toContain(`Assign ${leastRoleFor("lab.roleAssignment.write")} `);
      expect(text, path).toContain(`"${LAB_RBAC_CONDITION}"`);
      expect(text, path).toContain("Azure portal");
    }
  });

  it("keeps every script line within 80 columns except the az commands", () => {
    for (const path of ["lab-new-rg", "lab-byo-rg"] as const) {
      for (const line of renderRoleAssignmentCli(path, FILLED).split("\n").filter((l) => l.startsWith("#"))) {
        expect(line.length, line).toBeLessThanOrEqual(80);
      }
    }
  });

  it("never tells a byo-lab operator that no subscription-scope rights are needed", () => {
    // AZR-61 audit discrepancy 7: labs register the Event Grid provider at
    // the subscription and reach NetworkWatcherRG, and the path's own
    // app-permission plan asks for subscription-scope feature roles.
    expect(commentText(renderRoleAssignmentCli("lab-byo-rg", FILLED))).not.toMatch(/no subscription-scope/i);
    for (const req of rolePlanForSetupPath("lab-byo-rg")) {
      expect(req.justification).not.toMatch(/no subscription-scope/i);
    }
  });
});
