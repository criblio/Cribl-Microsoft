/**
 * Tests for the permission-preflight orchestration usecase (Unit 9).
 *
 * The effective-action FOUNDATION is already exercised by
 * domain/azure-permissions/azure-permissions.test.ts (glob semantics, the
 * additive-across / subtractive-within rule, Owner/Contributor/Reader shapes).
 * These tests pin the ORCHESTRATION on top of it:
 *   - Reader-only yields the deploy-readiness bool FALSE (read != write) - the
 *     key pin: Reader passes every read probe yet is not deployable.
 *   - no-resource-group-configured stub (no ARM call made).
 *   - the checked-actions list is exported as DATA and doubles as a
 *     least-privilege custom role.
 *   - partial render: Azure OK while the Cribl probe fails still renders both.
 *   - parallel composition of the two sides.
 *   - per-SetupPath scope selection (subscription vs resource-group).
 */
import { describe, expect, it } from "vitest";

import {
  runPermissionPreflight,
  runAzurePreflight,
  runCriblPreflight,
  scopeKindForSetupPath,
  buildArmScope,
  checkedAzureActions,
  leastPrivilegeRoleDefinition,
  CRIBL_CAPABILITY_PROBES,
  RBAC_PERMISSIONS_API_VERSION,
} from "./index";
import type { PermissionPreflightInput } from "./index";
import { REQUIRED_ACTIONS } from "../../domain/azure-permissions";
import type { PermissionSet } from "../../domain/azure-permissions";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { FakeCriblClient } from "../../testing/fake-cribl-client";
import type { AzureManagement } from "../../ports/azure-management";
import type { CriblClient } from "../../ports/cribl-client";
import type { PortHttpResponse } from "../../ports/http";

const SUB = "11111111-1111-1111-1111-111111111111";
const RG = "rg-sentinel";
const WS = "law-sentinel";

// Canonical role shapes (modeled on Azure's built-in roles), same as the
// azure-permissions unit tests use.
function permSet(partial: Partial<PermissionSet>): PermissionSet {
  return {
    actions: [],
    notActions: [],
    dataActions: [],
    notDataActions: [],
    ...partial,
  };
}
const OWNER = permSet({ actions: ["*"] });
const READER = permSet({ actions: ["*/read"] });
const CONTRIBUTOR = permSet({
  actions: ["*"],
  notActions: [
    "Microsoft.Authorization/*/Write",
    "Microsoft.Authorization/*/Delete",
    "Microsoft.Authorization/elevateAccess/Action",
  ],
});

function permsResponse(...sets: PermissionSet[]): PortHttpResponse {
  return { status: 200, body: { value: sets } };
}
const OK: PortHttpResponse = { status: 200, body: {} };

const FULL_TARGET = { subscriptionId: SUB, resourceGroup: RG, workspaceName: WS };

// ---------------------------------------------------------------------------
// per-SetupPath scope selection
// ---------------------------------------------------------------------------

describe("scope selection per SetupPath", () => {
  it("maps discovery + new-RG paths to subscription scope", () => {
    expect(scopeKindForSetupPath("existing-subscription")).toBe("subscription");
    expect(scopeKindForSetupPath("lab-new-rg-subscription")).toBe("subscription");
  });

  it("maps existing-RG + byo-RG paths to resource-group scope", () => {
    expect(scopeKindForSetupPath("existing-rg")).toBe("resource-group");
    expect(scopeKindForSetupPath("lab-byo-rg")).toBe("resource-group");
  });

  it("builds a subscription scope path", () => {
    expect(buildArmScope("subscription", FULL_TARGET)).toBe(`/subscriptions/${SUB}`);
  });

  it("builds a resource-group scope path", () => {
    expect(buildArmScope("resource-group", FULL_TARGET)).toBe(
      `/subscriptions/${SUB}/resourceGroups/${RG}`,
    );
  });

  it("returns null when the scope's required ids are missing", () => {
    expect(buildArmScope("subscription", { ...FULL_TARGET, subscriptionId: "" })).toBeNull();
    expect(buildArmScope("resource-group", { ...FULL_TARGET, resourceGroup: "" })).toBeNull();
  });

  it("queries the RBAC permissions API at the scope the path selects", async () => {
    // existing-rg -> resource-group scope
    const rgAzure = new FakeAzureManagement();
    rgAzure.respondWith(permsResponse(OWNER), OK, OK, OK);
    await runAzurePreflight(rgAzure, "existing-rg", FULL_TARGET);
    expect(rgAzure.calls[0].path).toBe(
      `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Authorization/permissions`,
    );
    expect(rgAzure.calls[0].apiVersion).toBe(RBAC_PERMISSIONS_API_VERSION);

    // existing-subscription -> subscription scope (no resourceGroups segment)
    const subAzure = new FakeAzureManagement();
    subAzure.respondWith(permsResponse(READER), OK); // perms + dcr-list probe
    await runAzurePreflight(subAzure, "existing-subscription", FULL_TARGET);
    expect(subAzure.calls[0].path).toBe(
      `/subscriptions/${SUB}/providers/Microsoft.Authorization/permissions`,
    );
  });
});

// ---------------------------------------------------------------------------
// Reader-only -> deploy-readiness FALSE (read does not imply write)
// ---------------------------------------------------------------------------

describe("Reader-only is not deployable (read does not imply write)", () => {
  it("passes every read probe yet yields hasRequiredAccess false", async () => {
    const azure = new FakeAzureManagement();
    // perms(READER) + dcr-list + workspace-get + tables-list all succeed (reader
    // can read everything) - the probes are all OK.
    azure.respondWith(permsResponse(READER), OK, OK, OK);

    const result = await runAzurePreflight(azure, "existing-rg", FULL_TARGET);

    // Probes are truth about read access - all OK.
    expect(result.probes.every((p) => p.status === "ok")).toBe(true);
    // But the WRITE actions are not granted, so it is not deployable.
    expect(result.hasRequiredAccess).toBe(false);
    expect(result.checks.every((c) => !c.granted)).toBe(true);
  });

  it("combined report is not ready when Azure is Reader-only (cloud Cribl)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(permsResponse(READER), OK, OK, OK);
    const cribl = new FakeCriblClient(); // cloud mode issues no cribl calls

    const report = await runPermissionPreflight(
      { azure, cribl },
      {
        setupPath: "existing-rg",
        azure: FULL_TARGET,
        cribl: { mode: "cloud" },
      },
    );

    expect(report.cribl.hasRequiredAccess).toBe(true); // granted by platform
    expect(report.azure.hasRequiredAccess).toBe(false);
    expect(report.hasRequiredAccess).toBe(false);
    expect(report.summary).toContain("Cannot deploy");
    expect(report.summary).toContain("Azure: cannot");
  });

  it("Owner IS deployable; Contributor fails only where roleAssignments/write is needed", async () => {
    const ownerAzure = new FakeAzureManagement();
    ownerAzure.respondWith(permsResponse(OWNER), OK, OK, OK);
    const owner = await runAzurePreflight(ownerAzure, "existing-rg", FULL_TARGET);
    expect(owner.hasRequiredAccess).toBe(true);

    // Contributor on the lab-new-rg path: denied Authorization/*/Write, which is
    // exactly the roleAssignments/write that path uniquely requires.
    const contribAzure = new FakeAzureManagement();
    contribAzure.respondWith(permsResponse(CONTRIBUTOR), OK); // subscription scope: only dcr-list probe (no rg/ws)
    const contrib = await runAzurePreflight(contribAzure, "lab-new-rg-subscription", {
      subscriptionId: SUB,
      resourceGroup: "",
      workspaceName: "",
    });
    expect(contrib.hasRequiredAccess).toBe(false);
    const roleAssign = contrib.checks.find((c) =>
      c.action.includes("roleAssignments/write"),
    );
    expect(roleAssign?.granted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// no-resource-group-configured stub
// ---------------------------------------------------------------------------

describe("no-resource-group-configured stub", () => {
  it("returns the stub without making any ARM call", async () => {
    const azure = new FakeAzureManagement();
    const result = await runAzurePreflight(azure, "existing-rg", {
      subscriptionId: SUB,
      resourceGroup: "",
      workspaceName: "",
    });

    expect(result.configured).toBe(false);
    expect(result.hasRequiredAccess).toBe(false);
    expect(result.error).toBe("No resource group configured");
    expect(result.checks.every((c) => !c.granted)).toBe(true);
    expect(azure.calls).toHaveLength(0); // no call attempted
  });

  it("returns the no-subscription stub for a subscription-scoped path", async () => {
    const azure = new FakeAzureManagement();
    const result = await runAzurePreflight(azure, "existing-subscription", {
      subscriptionId: "",
      resourceGroup: "",
      workspaceName: "",
    });
    expect(result.configured).toBe(false);
    expect(result.error).toBe("No subscription configured");
    expect(azure.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// checked-actions exported as DATA / least-privilege role
// ---------------------------------------------------------------------------

describe("checked actions exported as data", () => {
  it("returns exactly the REQUIRED_ACTIONS action strings for a path", () => {
    expect(checkedAzureActions("existing-rg")).toEqual(
      REQUIRED_ACTIONS["existing-rg"].map((r) => r.action),
    );
    expect(checkedAzureActions("existing-rg")).toContain(
      "Microsoft.Insights/dataCollectionRules/write",
    );
  });

  it("doubles as a least-privilege custom role definition", () => {
    const role = leastPrivilegeRoleDefinition("existing-rg");
    expect(role.permissions).toHaveLength(1);
    expect(role.permissions[0].actions).toEqual(checkedAzureActions("existing-rg"));
    expect(role.permissions[0].notActions).toEqual([]);
    expect(role.assignableScopes).toEqual(["/"]);
    // No extra breadth is granted beyond the checked actions.
    expect(role.permissions[0].actions).not.toContain("*");
  });

  it("honors caller-supplied assignable scopes", () => {
    const scope = `/subscriptions/${SUB}/resourceGroups/${RG}`;
    const role = leastPrivilegeRoleDefinition("lab-byo-rg", [scope]);
    expect(role.assignableScopes).toEqual([scope]);
  });
});

// ---------------------------------------------------------------------------
// Cribl side: cloud near-vacuous, local informative, graceful degradation
// ---------------------------------------------------------------------------

describe("Cribl side", () => {
  it("cloud probe is near-vacuous: granted by platform, no request issued", async () => {
    const cribl = new FakeCriblClient();
    const result = await runCriblPreflight(cribl, "cloud", "wg-a");
    expect(result.hasRequiredAccess).toBe(true);
    expect(result.probes).toHaveLength(CRIBL_CAPABILITY_PROBES.length);
    expect(result.probes.every((p) => p.status === "granted")).toBe(true);
    expect(result.probes.every((p) => p.detail === "granted by platform")).toBe(true);
    expect(cribl.calls).toHaveLength(0);
  });

  it("local probe reads capability from live 2xx/403 responses", async () => {
    const cribl = new FakeCriblClient();
    // packs 200, outputs 200, inputs 403 (denied), routes 200
    cribl.respondWith(
      { status: 200, body: [] },
      { status: 200, body: [] },
      { status: 403, body: {} },
      { status: 200, body: [] },
    );
    const result = await runCriblPreflight(cribl, "local", "wg-a");
    // Both REQUIRED capabilities (packs, outputs) granted -> ready.
    expect(result.hasRequiredAccess).toBe(true);
    const inputs = result.probes.find((p) => p.capability === "inputs");
    expect(inputs?.status).toBe("denied");
    // Group-scoped probes carry the worker group.
    expect(cribl.calls.every((c) => c.groupId === "wg-a")).toBe(true);
  });

  it("degrades a failed probe to unknown and never crashes (graceful degradation)", async () => {
    const cribl = new FakeCriblClient(); // empty queue -> request() throws (transport failure)
    const result = await runCriblPreflight(cribl, "local", "wg-a");
    expect(result.probes.every((p) => p.status === "unknown")).toBe(true);
    expect(result.hasRequiredAccess).toBe(false);
    expect(result.error).toBe("Cribl leader not reachable");
  });
});

// ---------------------------------------------------------------------------
// partial render: Azure OK + Cribl probe fails still renders both
// ---------------------------------------------------------------------------

describe("partial render", () => {
  it("renders both halves when the Cribl probe fails and Azure is OK", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(permsResponse(OWNER), OK, OK, OK);
    const cribl = new FakeCriblClient(); // local, empty queue -> all probes fail

    const report = await runPermissionPreflight(
      { azure, cribl },
      {
        setupPath: "existing-rg",
        azure: FULL_TARGET,
        cribl: { mode: "local", workerGroup: "wg-a" },
      },
    );

    // Azure half fully rendered and ready.
    expect(report.azure.hasRequiredAccess).toBe(true);
    expect(report.azure.checks.length).toBeGreaterThan(0);
    // Cribl half rendered as unknown, not blank, not crashed.
    expect(report.cribl.probes.every((p) => p.status === "unknown")).toBe(true);
    expect(report.cribl.hasRequiredAccess).toBe(false);
    // Combined not ready; Cribl issue takes priority in the summary.
    expect(report.hasRequiredAccess).toBe(false);
    expect(report.summary.startsWith("Cannot deploy: Cribl")).toBe(true);
  });

  it("renders the Azure half when the RBAC permissions fetch itself fails", async () => {
    const azure = new FakeAzureManagement();
    // perms 403 (denied), then the 3 read probes still run and can be denied too.
    azure.respondWith(
      { status: 403, body: { error: { code: "AuthorizationFailed" } } },
      { status: 403, body: {} },
      { status: 403, body: {} },
      { status: 403, body: {} },
    );
    const result = await runAzurePreflight(azure, "existing-rg", FULL_TARGET);
    expect(result.configured).toBe(true);
    expect(result.permissionsFetched).toBe(false);
    expect(result.hasRequiredAccess).toBe(false);
    expect(result.error).toContain("HTTP 403");
    expect(result.probes.every((p) => p.status === "denied")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parallel composition
// ---------------------------------------------------------------------------

describe("parallel composition", () => {
  it("dispatches both sides before either resolves (true parallelism)", async () => {
    // Azure's request only resolves AFTER Cribl has been called at least once.
    // If the two sides ran sequentially (Azure fully awaited before Cribl), this
    // would deadlock; parallel dispatch lets Cribl's call unblock Azure.
    let releaseAzure = (): void => {};
    const criblCalled = new Promise<void>((resolve) => {
      releaseAzure = resolve;
    });

    const azure: AzureManagement = {
      async request() {
        await criblCalled;
        return permsResponse(OWNER);
      },
    };
    const cribl: CriblClient = {
      async request() {
        releaseAzure();
        return { status: 200, body: [] };
      },
      async listGroups() {
        return [];
      },
    };

    const input: PermissionPreflightInput = {
      setupPath: "existing-subscription", // subscription scope: single dcr-list probe
      azure: { subscriptionId: SUB, resourceGroup: "", workspaceName: "" },
      cribl: { mode: "local", workerGroup: "wg-a" },
    };

    // Would hang forever if the sides were sequential; resolves under parallelism.
    const report = await runPermissionPreflight({ azure, cribl }, input);
    expect(report.azure.permissionsFetched).toBe(true);
    expect(report.cribl.probes.length).toBe(CRIBL_CAPABILITY_PROBES.length);
  });

  it("an unexpected throw on one side never blanks the other", async () => {
    // Azure port throws synchronously on the first call.
    const azure: AzureManagement = {
      async request() {
        throw new Error("boom");
      },
    };
    const cribl = new FakeCriblClient(); // cloud -> granted by platform

    const report = await runPermissionPreflight(
      { azure, cribl },
      {
        setupPath: "existing-subscription",
        azure: { subscriptionId: SUB, resourceGroup: "", workspaceName: "" },
        cribl: { mode: "cloud" },
      },
    );

    // runAzurePreflight catches its own request throw (permissions try/catch) and
    // still returns a populated, configured half.
    expect(report.azure.error).toContain("boom");
    expect(report.azure.hasRequiredAccess).toBe(false);
    // Cribl half is untouched and rendered.
    expect(report.cribl.hasRequiredAccess).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// report shape identical across shells
// ---------------------------------------------------------------------------

describe("report shape", () => {
  it("has the same top-level keys in cloud and local shells", async () => {
    const mk = async (mode: "cloud" | "local"): Promise<string[]> => {
      const azure = new FakeAzureManagement();
      azure.respondWith(permsResponse(OWNER), OK, OK, OK);
      const cribl = new FakeCriblClient();
      if (mode === "local") {
        cribl.respondWith(
          { status: 200, body: [] },
          { status: 200, body: [] },
          { status: 200, body: [] },
          { status: 200, body: [] },
        );
      }
      const report = await runPermissionPreflight(
        { azure, cribl },
        { setupPath: "existing-rg", azure: FULL_TARGET, cribl: { mode, workerGroup: "wg-a" } },
      );
      return Object.keys(report).sort();
    };
    const cloudKeys = await mk("cloud");
    const localKeys = await mk("local");
    expect(cloudKeys).toEqual(localKeys);
    expect(cloudKeys).toEqual(["azure", "cribl", "hasRequiredAccess", "summary"]);
  });

  it("summary is the ready message when both sides are granted", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(permsResponse(OWNER), OK, OK, OK);
    const cribl = new FakeCriblClient();
    const report = await runPermissionPreflight(
      { azure, cribl },
      { setupPath: "existing-rg", azure: FULL_TARGET, cribl: { mode: "cloud" } },
    );
    expect(report.hasRequiredAccess).toBe(true);
    expect(report.summary).toBe("All required access verified. Ready to deploy.");
  });
});
