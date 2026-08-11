/**
 * Contract tests for the preflight -> capability projection.
 *
 * The projection is where the capability domain's honesty rules meet a real
 * measurement, so these pin the JOINS rather than re-testing either side:
 *   - an unread permissions API contributes NOTHING (its fabricated
 *     granted:false checks are a deploy-gate stance, not a measurement);
 *   - probes are truth for reads and outrank the RBAC evaluation;
 *   - no probe can ever grant a write - the Reader-not-deployable pin restated
 *     in capability terms, and the one that would silently unlock a broken
 *     deploy if it regressed;
 *   - unmeasured means ABSENT, so the domain resolves unknown vs unreachable
 *     from connection context instead of the projection guessing.
 */
import { describe, expect, it } from "vitest";

import {
  AZURE_ACTION_CAPABILITIES,
  AZURE_PROBE_CAPABILITIES,
  CRIBL_PROBE_CAPABILITIES,
  capabilitiesCheckedForSetupPath,
  capabilitiesFromReport,
  capabilitiesFromSides,
} from "./capability-mapping";
import {
  runAzurePreflight,
  runPermissionPreflight,
  CRIBL_CAPABILITY_PROBES,
} from "./index";
import type {
  AzurePreflight,
  CriblPreflight,
  PermissionReport,
} from "./index";
import {
  AZURE_CAPABILITIES,
  CRIBL_CAPABILITIES,
  isAzureCapability,
  verdictFor,
  type CapabilityContext,
} from "../../domain/capabilities";
import { checkResult, REQUIRED_ACTIONS } from "../../domain/azure-permissions";
import type { PermissionSet, SetupPath } from "../../domain/azure-permissions";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { FakeCriblClient } from "../../testing/fake-cribl-client";
import type { PortHttpResponse } from "../../ports/http";

const SUB = "11111111-1111-1111-1111-111111111111";
const RG = "rg-sentinel";
const WS = "law-sentinel";
const FULL_TARGET = { subscriptionId: SUB, resourceGroup: RG, workspaceName: WS };
const META = { auditedAt: "2026-08-06T00:00:00Z", connectionId: "conn-1" };

const connected: CapabilityContext = {
  azureIdentityPresent: true,
  criblReachable: true,
};

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

function permsResponse(...sets: PermissionSet[]): PortHttpResponse {
  return { status: 200, body: { value: sets } };
}
const OK: PortHttpResponse = { status: 200, body: {} };
const FORBIDDEN: PortHttpResponse = { status: 403, body: {} };

/** A minimal Azure half, overridable per test. */
function azurePreflight(partial: Partial<AzurePreflight> = {}): AzurePreflight {
  return {
    configured: true,
    setupPath: "existing-rg",
    scopeKind: "resource-group",
    scope: `/subscriptions/${SUB}/resourceGroups/${RG}`,
    permissionsFetched: true,
    checks: [],
    probes: [],
    hasRequiredAccess: false,
    error: "",
    ...partial,
  };
}

/** A minimal Cribl half, overridable per test. */
function criblPreflight(partial: Partial<CriblPreflight> = {}): CriblPreflight {
  return {
    mode: "local",
    workerGroup: "default",
    probes: [],
    hasRequiredAccess: false,
    error: "",
    ...partial,
  };
}

function report(
  azure: Partial<AzurePreflight> = {},
  cribl: Partial<CriblPreflight> = {},
): PermissionReport {
  return {
    azure: azurePreflight(azure),
    cribl: criblPreflight(cribl),
    hasRequiredAccess: false,
    summary: "",
  };
}

// ---------------------------------------------------------------------------
// Mapping tables
// ---------------------------------------------------------------------------

describe("mapping tables", () => {
  it("maps every action to a capability of the right side", () => {
    for (const capability of Object.values(AZURE_ACTION_CAPABILITIES)) {
      expect(isAzureCapability(capability)).toBe(true);
    }
    for (const capability of Object.values(AZURE_PROBE_CAPABILITIES)) {
      expect(isAzureCapability(capability)).toBe(true);
    }
    for (const capability of Object.values(CRIBL_PROBE_CAPABILITIES)) {
      expect(isAzureCapability(capability)).toBe(false);
    }
  });

  it("covers every Cribl capability with exactly one probe", () => {
    const mapped = Object.values(CRIBL_PROBE_CAPABILITIES);
    expect([...mapped].sort()).toEqual([...CRIBL_CAPABILITIES].sort());
    // And every probe the preflight actually issues has a mapping - a new probe
    // added without one would silently contribute no verdict.
    for (const spec of CRIBL_CAPABILITY_PROBES) {
      expect(CRIBL_PROBE_CAPABILITIES[spec.capability]).toBeDefined();
    }
  });

  it("probes only ever establish READ capabilities", () => {
    // Structural, not incidental: the probes are no-op GETs, so none of them can
    // prove a write. If this ever fails, a write is being granted by a read.
    for (const capability of Object.values(AZURE_PROBE_CAPABILITIES)) {
      expect(capability.endsWith(".read")).toBe(true);
    }
  });

  it("leaves lab-provisioning actions unmapped rather than widening the taxonomy", () => {
    expect(
      AZURE_ACTION_CAPABILITIES["Microsoft.Resources/subscriptions/resourceGroups/write"],
    ).toBeUndefined();
    expect(
      AZURE_ACTION_CAPABILITIES["Microsoft.OperationalInsights/workspaces/write"],
    ).toBeUndefined();
  });

  it("maps no action the capability taxonomy does not contain", () => {
    const known = new Set<string>([...AZURE_CAPABILITIES, ...CRIBL_CAPABILITIES]);
    for (const capability of Object.values(AZURE_ACTION_CAPABILITIES)) {
      expect(known.has(capability)).toBe(true);
    }
  });

  it("reports which capabilities a setup path actually checks", () => {
    // RE-PINNED 2026-08-11: role.assign joined both existing-rg and lab-byo-rg
    // when they gained the roleAssignments/write check. `feature` actions are
    // still real MEASUREMENTS - they only decline to gate deploy readiness - so
    // they belong in this list exactly like core ones.
    expect(capabilitiesCheckedForSetupPath("existing-rg").sort()).toEqual(
      ["arm.deploy", "dcr.write", "role.assign", "table.write"].sort(),
    );
    expect(capabilitiesCheckedForSetupPath("existing-subscription").sort()).toEqual(
      ["dcr.read", "workspace.read"].sort(),
    );
    // lab-byo-rg checks workspaces/write, which has no capability - the list is
    // the mapped subset, never padded to match the action count. The Sentinel
    // content actions on existing-rg are the same case: checked, measured, and
    // deliberately mapped to no capability, because the settled taxonomy has
    // none for content install and inventing one here would widen it.
    expect(capabilitiesCheckedForSetupPath("lab-byo-rg").sort()).toEqual(
      ["arm.deploy", "role.assign"].sort(),
    );
    expect(capabilitiesCheckedForSetupPath("existing-rg")).not.toContain(
      "content.install",
    );
  });

  it("never claims a capability the setup path does not check", () => {
    const paths: SetupPath[] = [
      "existing-subscription",
      "existing-rg",
      "lab-new-rg-subscription",
      "lab-byo-rg",
    ];
    for (const path of paths) {
      const actions = new Set(REQUIRED_ACTIONS[path].map((r) => r.action));
      for (const capability of capabilitiesCheckedForSetupPath(path)) {
        const backing = Object.entries(AZURE_ACTION_CAPABILITIES).filter(
          ([, c]) => c === capability,
        );
        expect(backing.some(([action]) => actions.has(action))).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Only measurements are recorded
// ---------------------------------------------------------------------------

describe("only measurements are recorded", () => {
  it("records nothing when the permissions API could not be read", () => {
    // The preflight fills `checks` with granted:false so its own deploy gate
    // stays conservative. That is NOT a permission measurement, and copying it
    // across as `denied` would have the capability model assert a fact nobody
    // established - the exact thing the domain pins against.
    const set = capabilitiesFromReport(
      report({
        permissionsFetched: false,
        checks: REQUIRED_ACTIONS["existing-rg"].map((r) => checkResult(r, false)),
        error: "fetch RBAC permissions: HTTP 500",
      }),
      META,
    );

    expect(set.verdicts).toEqual({});
    expect(verdictFor("dcr.write", set, connected)).toBe("unknown");
  });

  it("records nothing for an unconfigured Azure target", () => {
    const set = capabilitiesFromReport(
      report({
        configured: false,
        scope: "",
        permissionsFetched: false,
        checks: REQUIRED_ACTIONS["existing-rg"].map((r) => checkResult(r, false)),
        error: "No resource group configured",
      }),
      META,
    );
    expect(set.verdicts).toEqual({});
  });

  it("omits an unmeasured capability so context decides unknown vs unreachable", () => {
    const set = capabilitiesFromReport(report(), META);
    expect(verdictFor("dcr.write", set, connected)).toBe("unknown");
    expect(
      verdictFor("dcr.write", set, {
        azureIdentityPresent: false,
        criblReachable: false,
      }),
    ).toBe("unreachable");
  });

  it("omits a capability whose probe could not complete", () => {
    const set = capabilitiesFromReport(
      report(
        {},
        {
          probes: CRIBL_CAPABILITY_PROBES.map((spec) => ({
            capability: spec.capability,
            label: spec.label,
            required: spec.required,
            status: "unknown" as const,
            detail: "connect ECONNREFUSED",
          })),
          error: "Cribl leader not reachable",
        },
      ),
      META,
    );

    // An unreachable leader must read as a CONNECTION fact, not a denial.
    expect(set.verdicts).toEqual({});
    expect(
      verdictFor("pack.manage", set, {
        azureIdentityPresent: true,
        criblReachable: false,
      }),
    ).toBe("unreachable");
  });

  it("carries the caller's audit identity verbatim - core reads no clock", () => {
    const set = capabilitiesFromReport(report(), META);
    expect(set.auditedAt).toBe(META.auditedAt);
    expect(set.connectionId).toBe(META.connectionId);
    const never = capabilitiesFromReport(report(), { auditedAt: null, connectionId: null });
    expect(never.auditedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Probes are truth for reads; checks own the writes
// ---------------------------------------------------------------------------

describe("probes are truth for reads", () => {
  it("lets a successful probe outrank a denying RBAC evaluation", () => {
    const set = capabilitiesFromReport(
      report({
        checks: [
          {
            action: "Microsoft.Insights/dataCollectionRules/read",
            label: "Read DCRs",
            granted: false,
            necessity: "core",
          },
        ],
        probes: [
          { name: "dcr-list", label: "List DCRs", status: "ok", detail: "access confirmed" },
        ],
      }),
      META,
    );
    // The GET returned 2xx. Whatever the RBAC evaluation concluded, the read works.
    expect(set.verdicts["dcr.read"]).toBe("granted");
  });

  it("lets a 403 probe outrank a granting RBAC evaluation", () => {
    const set = capabilitiesFromReport(
      report({
        checks: [
          {
            action: "Microsoft.Insights/dataCollectionRules/read",
            label: "Read DCRs",
            granted: true,
            necessity: "core",
          },
        ],
        probes: [
          { name: "dcr-list", label: "List DCRs", status: "denied", detail: "HTTP 403" },
        ],
      }),
      META,
    );
    expect(set.verdicts["dcr.read"]).toBe("denied");
  });

  it("keeps the check when the probe degraded to unknown", () => {
    const set = capabilitiesFromReport(
      report({
        checks: [
          {
            action: "Microsoft.Insights/dataCollectionRules/read",
            label: "Read DCRs",
            granted: true,
            necessity: "core",
          },
        ],
        probes: [
          { name: "dcr-list", label: "List DCRs", status: "unknown", detail: "HTTP 404" },
        ],
      }),
      META,
    );
    // An unknown probe must not erase what the evaluation established.
    expect(set.verdicts["dcr.read"]).toBe("granted");
  });
});

describe("writes come from effective actions, never from a probe", () => {
  it("grants no write capability from any probe combination", () => {
    const set = capabilitiesFromReport(
      report({
        permissionsFetched: false,
        probes: [
          { name: "dcr-list", label: "List DCRs", status: "ok", detail: "" },
          { name: "workspace-get", label: "Read workspace", status: "ok", detail: "" },
          { name: "tables-list", label: "List tables", status: "ok", detail: "" },
        ],
      }),
      META,
    );

    // Every probe passed; not one write is granted.
    expect(set.verdicts["dcr.write"]).toBeUndefined();
    expect(set.verdicts["table.write"]).toBeUndefined();
    expect(set.verdicts["arm.deploy"]).toBeUndefined();
    expect(set.verdicts["dcr.read"]).toBe("granted");
  });

  it("records a measured denial as denied once the API WAS read", () => {
    const set = capabilitiesFromReport(
      report({
        permissionsFetched: true,
        checks: [
          {
            action: "Microsoft.Insights/dataCollectionRules/write",
            label: "Create/update DCRs",
            granted: false,
            necessity: "core",
          },
        ],
      }),
      META,
    );
    expect(set.verdicts["dcr.write"]).toBe("denied");
  });
});

// ---------------------------------------------------------------------------
// Cribl symmetry
// ---------------------------------------------------------------------------

describe("Cribl side gets identical treatment", () => {
  it("maps granted and denied probes onto the same verdicts", () => {
    const set = capabilitiesFromReport(
      report(
        {},
        {
          probes: [
            { capability: "packs", label: "Manage packs", required: true, status: "granted", detail: "" },
            { capability: "outputs", label: "Manage destinations", required: true, status: "denied", detail: "HTTP 403" },
            { capability: "inputs", label: "Manage sources", required: false, status: "unknown", detail: "HTTP 500" },
          ],
        },
      ),
      META,
    );
    expect(set.verdicts["pack.manage"]).toBe("granted");
    expect(set.verdicts["destination.manage"]).toBe("denied");
    expect(set.verdicts["source.manage"]).toBeUndefined();
  });

  it("treats the cloud shell's platform grant as a real measurement", async () => {
    // The app runs inside the leader under the approved policies.yml, so
    // "granted by platform" is a fact about a real grant, not an assumption.
    const azure = new FakeAzureManagement();
    azure.respondWith(permsResponse(OWNER), OK, OK, OK);
    const cloud = await runPermissionPreflight(
      { azure, cribl: new FakeCriblClient() },
      { setupPath: "existing-rg", azure: FULL_TARGET, cribl: { mode: "cloud" } },
    );

    const set = capabilitiesFromReport(cloud, META);
    for (const capability of CRIBL_CAPABILITIES) {
      expect(set.verdicts[capability]).toBe("granted");
    }
  });
});

// ---------------------------------------------------------------------------
// End to end over a real report
// ---------------------------------------------------------------------------

describe("over a real preflight report", () => {
  it("Owner on existing-rg grants the writes it checks", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(permsResponse(OWNER), OK, OK, OK);
    const preflight = await runAzurePreflight(azure, "existing-rg", FULL_TARGET);

    const set = capabilitiesFromReport(report(preflight), META);
    expect(set.verdicts["dcr.write"]).toBe("granted");
    expect(set.verdicts["table.write"]).toBe("granted");
    expect(set.verdicts["arm.deploy"]).toBe("granted");
    // Reads come from the probes on this path, which all returned 2xx.
    expect(set.verdicts["dcr.read"]).toBe("granted");
    expect(set.verdicts["workspace.read"]).toBe("granted");
    expect(set.verdicts["table.read"]).toBe("granted");
    // RE-PINNED 2026-08-11: this used to be `undefined` with the comment "not
    // checked at this scope". That was the gap - the app asked operators for
    // RBAC Administrator on this path and then never measured whether they had
    // it, so the capability stayed unknown and nothing could annotate it.
    // existing-rg now checks roleAssignments/write as a `feature` action, and
    // Owner grants it.
    expect(set.verdicts["role.assign"]).toBe("granted");
  });

  it("Reader on existing-rg reads everything and writes nothing", async () => {
    // The capability restatement of the suite's key pin: read does not imply
    // write. A Reader must never surface a granted write capability.
    const azure = new FakeAzureManagement();
    azure.respondWith(permsResponse(READER), OK, OK, OK);
    const preflight = await runAzurePreflight(azure, "existing-rg", FULL_TARGET);

    const set = capabilitiesFromReport(report(preflight), META);
    expect(set.verdicts["dcr.read"]).toBe("granted");
    expect(set.verdicts["workspace.read"]).toBe("granted");
    expect(set.verdicts["table.read"]).toBe("granted");
    expect(set.verdicts["dcr.write"]).toBe("denied");
    expect(set.verdicts["table.write"]).toBe("denied");
    expect(set.verdicts["arm.deploy"]).toBe("denied");
  });

  it("projects the same answer from the halves as from the whole report", async () => {
    // The RBAC preflight panel fires the two side-runners independently and
    // never assembles a report, so it projects through capabilitiesFromSides.
    // Both callers must agree, or the panel's cached measurement would mean
    // something different from the audit's.
    const azure = new FakeAzureManagement();
    azure.respondWith(permsResponse(READER), OK, FORBIDDEN, OK);
    const full = await runPermissionPreflight(
      { azure, cribl: new FakeCriblClient() },
      { setupPath: "existing-rg", azure: FULL_TARGET, cribl: { mode: "cloud" } },
    );

    expect(capabilitiesFromSides(full.azure, full.cribl, META)).toEqual(
      capabilitiesFromReport(full, META),
    );
  });

  it("a 403 on the DCR list denies only the read it probed", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(permsResponse(OWNER), FORBIDDEN, OK, OK);
    const preflight = await runAzurePreflight(azure, "existing-rg", FULL_TARGET);

    const set = capabilitiesFromReport(report(preflight), META);
    expect(set.verdicts["dcr.read"]).toBe("denied");
    expect(set.verdicts["workspace.read"]).toBe("granted");
    expect(set.verdicts["dcr.write"]).toBe("granted");
  });
});
