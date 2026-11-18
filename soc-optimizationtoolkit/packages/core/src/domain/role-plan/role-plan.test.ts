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
import {
  LAB_RBAC_CONDITION,
  LAB_TTL_ROLE,
  NETWORK_WATCHER_RESOURCE_GROUP,
  adminStepsForSetupPath,
  renderRoleAssignmentCli,
  rolePlanForSetupPath,
} from "./index";
import { leastRoleFor, privilegeOperation } from "../least-privilege";
import { AZURE_NETWORK_WATCHER_RG } from "../labs/lab-flowlogs";
import { TTL_ROLE_NAME } from "../labs/lab-foundation";
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
  workspaceName: "WS",
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
        // AZR-85: on the workspace, not its group.
        role: "Log Analytics Contributor",
        scopeLevel: "workspace",
        justification:
          "Create custom Log Analytics tables in the workspace. Asked on the workspace itself, not its resource group, where the role would also reach every other resource there. A custom role with only Microsoft.OperationalInsights/workspaces/read, Microsoft.OperationalInsights/workspaces/tables/read, Microsoft.OperationalInsights/workspaces/tables/write on the workspace is narrower still.",
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
          "Assign the lab TTL self-destruct identity its delete role (Managed Application Contributor Role, which can read and delete the lab resource group) at deploy time.",
        condition:
          "Constrain roles and principal types: only Managed Application Contributor Role and Monitoring Metrics Publisher, only to service principals.",
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
      "Constrain roles and principal types: only Managed Application Contributor Role and Monitoring Metrics Publisher, only to service principals.",
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
          "Deploy the lab workspace, DCRs, and tables into the pre-created lab resource group. The grant reaches nothing outside it; the two lab steps that do - flow logs on the regional Network Watcher, and the Event Grid provider registration - are asked for separately.",
        feature: "Deploy the lab environment",
        withoutIt:
          "Nothing on this path runs - there is no other scope the lab is allowed to deploy into.",
      },
      {
        role: "RBAC Administrator",
        scopeLevel: "resourceGroup",
        justification:
          "Assign the lab TTL self-destruct identity its delete role (Managed Application Contributor Role) on the lab resource group at deploy time.",
        condition:
          "Constrain roles and principal types: only Managed Application Contributor Role and Monitoring Metrics Publisher, only to service principals.",
        assignViaPortal: true,
        feature: "Lab TTL self-destruct",
        withoutIt:
          "The deploy stops at the TTL step: a lab with no working self-destruct is never left running.",
      },
      // AZR-81: the flow logs are written on the region's watcher, which
      // Azure keeps in NetworkWatcherRG, outside the lab group.
      {
        role: "Network Contributor",
        scopeLevel: "resourceGroup",
        resourceGroup: "NetworkWatcherRG",
        necessity: "feature",
        justification:
          "Read the region's Network Watcher and write the lab's flow logs on it. Azure keeps one watcher per region per subscription, normally in NetworkWatcherRG, so the lab cannot create its own in the lab resource group.",
        feature: "Lab vNet flow logs",
        withoutIt:
          "The flow-logs step fails with a message naming NetworkWatcherRG; the rest of the lab deploys.",
      },
    ]);
    expect(leastRoleFor("flowLog.write")).toBe("Network Contributor");
    expect(NETWORK_WATCHER_RESOURCE_GROUP).toBe(AZURE_NETWORK_WATCHER_RG);
  });

  it("the TTL role the condition allows is the role the foundation phase assigns (AZR-89)", () => {
    // The condition is authored before the deploy; if it named a different
    // role from the one buildRgTtlRoleAssignmentRequest PUTs, every lab
    // deploy would fail at ttl-role-assignment with an ABAC denial.
    expect(LAB_TTL_ROLE).toBe(TTL_ROLE_NAME);
    expect(LAB_RBAC_CONDITION).toContain("only " + TTL_ROLE_NAME + " and Monitoring Metrics Publisher");
    expect(LAB_RBAC_CONDITION).not.toMatch(/only Contributor/);
  });

  it("asks the byo lab's admin to register Event Grid once, instead of a subscription role (AZR-81)", () => {
    expect(adminStepsForSetupPath("lab-byo-rg").map((s) => s.command)).toEqual([
      "az provider register --namespace Microsoft.EventGrid --subscription <subscriptionId>",
    ]);
    expect(adminStepsForSetupPath("lab-byo-rg")[0]?.justification).toContain(
      privilegeOperation("eventGrid.provider.register").operation,
    );
    expect(adminStepsForSetupPath("lab-new-rg")).toEqual([]);
    expect(adminStepsForSetupPath("existing")).toEqual([]);
    // No subscription-scope ROLE on the byo path: that is the point of it.
    expect(rolePlanForSetupPath("lab-byo-rg").some((r) => r.scopeLevel === "subscription")).toBe(false);
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
        "# Existing workspace: least privilege, scoped to its resource group and the workspace",
        'az role assignment create --assignee <clientId> --role "Reader" --scope /subscriptions/<subscriptionId>',
        'az role assignment create --assignee <clientId> --role "Monitoring Contributor" --scope /subscriptions/<subscriptionId>/resourceGroups/<workspaceRg>',
        'az role assignment create --assignee <clientId> --role "Log Analytics Contributor" --scope /subscriptions/<subscriptionId>/resourceGroups/<workspaceRg>/providers/Microsoft.OperationalInsights/workspaces/<workspaceName>',
      ].join("\n"),
    );
  });

  it("existing, filled params", () => {
    expect(renderRoleAssignmentCli("existing", FILLED)).toBe(
      [
        "# Existing workspace: least privilege, scoped to its resource group and the workspace",
        'az role assignment create --assignee CID --role "Reader" --scope /subscriptions/SUB',
        'az role assignment create --assignee CID --role "Monitoring Contributor" --scope /subscriptions/SUB/resourceGroups/RG',
        'az role assignment create --assignee CID --role "Log Analytics Contributor" --scope /subscriptions/SUB/resourceGroups/RG/providers/Microsoft.OperationalInsights/workspaces/WS',
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

  it("lab-byo-rg: lab-group Contributor, Network Contributor on NetworkWatcherRG, and the Event Grid registration; RBAC Administrator is a portal comment", () => {
    // RE-PINNED (AZR-81): the two lab steps outside the group are in the script.
    expect(commandLines(renderRoleAssignmentCli("lab-byo-rg", BLANK))).toEqual([
      'az role assignment create --assignee <clientId> --role "Contributor" --scope /subscriptions/<subscriptionId>/resourceGroups/<labRg>',
      'az role assignment create --assignee <clientId> --role "Network Contributor" --scope /subscriptions/<subscriptionId>/resourceGroups/NetworkWatcherRG',
      "az provider register --namespace Microsoft.EventGrid --subscription <subscriptionId>",
    ]);
    expect(commandLines(renderRoleAssignmentCli("lab-byo-rg", FILLED))).toEqual([
      'az role assignment create --assignee CID --role "Contributor" --scope /subscriptions/SUB/resourceGroups/RG',
      'az role assignment create --assignee CID --role "Network Contributor" --scope /subscriptions/SUB/resourceGroups/NetworkWatcherRG',
      "az provider register --namespace Microsoft.EventGrid --subscription SUB",
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

describe("renderRoleAssignmentCli limited to the requested roles (C1)", () => {
  it("with every plan role named, the output is unchanged", () => {
    const all = rolePlanForSetupPath("existing").map((r) => r.role);
    expect(renderRoleAssignmentCli("existing", FILLED, all)).toBe(
      renderRoleAssignmentCli("existing", FILLED),
    );
  });

  it("Reader only -> only the Reader command", () => {
    const out = renderRoleAssignmentCli("existing", FILLED, ["Reader"]);
    const commands = out.split("\n").filter((l) => l.startsWith("az "));
    expect(commands).toEqual([
      'az role assignment create --assignee CID --role "Reader" --scope /subscriptions/SUB',
    ]);
  });

  it("no plan role named -> no command, and says so", () => {
    const out = renderRoleAssignmentCli("existing", FILLED, ["Application.Read.All"]);
    expect(out.split("\n").filter((l) => l.startsWith("az "))).toEqual([]);
    expect(out).toContain("# No roles are requested");
  });
});
