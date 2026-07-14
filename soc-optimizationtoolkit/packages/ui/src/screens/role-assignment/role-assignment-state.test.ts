import { describe, expect, it } from "vitest";
import { assignDcrRoleStepName } from "@soc/core";
import type { AssignDcrRoleOutcome, DcrRoleTarget } from "@soc/core";
import {
  OBJECT_ID_EMPTY_REASON,
  OBJECT_ID_IS_CLIENT_ID_REASON,
  OBJECT_ID_NOT_GUID_REASON,
  ROLE_ASSIGN_NO_MINTER_REASON,
  ROLE_ASSIGN_NO_TARGETS_REASON,
  ROLE_ASSIGN_RUNNING_REASON,
  ROLE_DETAIL_ALREADY,
  ROLE_DETAIL_ASSIGNED,
  dcrResourceIdFor,
  projectRoleOutcome,
  roleAssignDisabledReason,
  roleAssignStepNames,
  roleTargetDisplayName,
  upsertRoleTarget,
  validateObjectId,
} from "./role-assignment-state";

const OBJECT_ID = "11111111-2222-3333-4444-555555555555";
const CLIENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function target(overrides: Partial<DcrRoleTarget> = {}): DcrRoleTarget {
  return {
    dcrResourceId:
      "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Insights/dataCollectionRules/dcr-SecurityEvent-eastus",
    table: "SecurityEvent",
    ...overrides,
  };
}

describe("validateObjectId", () => {
  it("accepts a GUID that is not the client id", () => {
    expect(validateObjectId(OBJECT_ID, CLIENT_ID)).toEqual({
      valid: true,
      reason: null,
    });
  });

  it("trims surrounding whitespace before validating", () => {
    expect(validateObjectId(`  ${OBJECT_ID}  `).valid).toBe(true);
  });

  it("is case-insensitive on the hex digits", () => {
    expect(validateObjectId(OBJECT_ID.toUpperCase()).valid).toBe(true);
  });

  it("reports the not-yet-entered empty state", () => {
    expect(validateObjectId("")).toEqual({
      valid: false,
      reason: OBJECT_ID_EMPTY_REASON,
    });
    expect(validateObjectId("   ").reason).toBe(OBJECT_ID_EMPTY_REASON);
  });

  it("rejects a non-GUID value with the wrong-id guidance", () => {
    expect(validateObjectId("not-a-guid")).toEqual({
      valid: false,
      reason: OBJECT_ID_NOT_GUID_REASON,
    });
  });

  it("rejects the app-registration client id explicitly (the classic mistake)", () => {
    expect(validateObjectId(CLIENT_ID, CLIENT_ID)).toEqual({
      valid: false,
      reason: OBJECT_ID_IS_CLIENT_ID_REASON,
    });
  });

  it("matches the client id case-insensitively and ignoring surrounding space", () => {
    expect(
      validateObjectId(`  ${CLIENT_ID.toUpperCase()} `, CLIENT_ID).reason,
    ).toBe(OBJECT_ID_IS_CLIENT_ID_REASON);
  });

  it("does not treat a blank client id as a collision", () => {
    expect(validateObjectId(OBJECT_ID, "").valid).toBe(true);
    expect(validateObjectId(OBJECT_ID, "   ").valid).toBe(true);
  });
});

describe("roleAssignDisabledReason", () => {
  const ok = {
    objectIdValid: true,
    objectIdReason: null,
    targetCount: 2,
    canMint: true,
    running: false,
  };

  it("returns null when everything is satisfied", () => {
    expect(roleAssignDisabledReason(ok)).toBeNull();
  });

  it("prioritizes running over every other reason", () => {
    expect(
      roleAssignDisabledReason({
        ...ok,
        running: true,
        canMint: false,
        targetCount: 0,
        objectIdValid: false,
      }),
    ).toBe(ROLE_ASSIGN_RUNNING_REASON);
  });

  it("reports the missing GUID minter before targets/object-id", () => {
    expect(
      roleAssignDisabledReason({
        ...ok,
        canMint: false,
        targetCount: 0,
        objectIdValid: false,
      }),
    ).toBe(ROLE_ASSIGN_NO_MINTER_REASON);
  });

  it("reports the empty-targets state before the object id", () => {
    expect(
      roleAssignDisabledReason({
        ...ok,
        targetCount: 0,
        objectIdValid: false,
        objectIdReason: OBJECT_ID_EMPTY_REASON,
      }),
    ).toBe(ROLE_ASSIGN_NO_TARGETS_REASON);
  });

  it("surfaces the object-id reason once there are targets", () => {
    expect(
      roleAssignDisabledReason({
        ...ok,
        objectIdValid: false,
        objectIdReason: OBJECT_ID_NOT_GUID_REASON,
      }),
    ).toBe(OBJECT_ID_NOT_GUID_REASON);
  });

  it("falls back to the empty reason when an invalid object id carries none", () => {
    expect(
      roleAssignDisabledReason({
        ...ok,
        objectIdValid: false,
        objectIdReason: null,
      }),
    ).toBe(OBJECT_ID_EMPTY_REASON);
  });
});

describe("dcrResourceIdFor", () => {
  it("composes the canonical DCR ARM resource id", () => {
    expect(
      dcrResourceIdFor({
        subscriptionId: "sub-1",
        resourceGroup: "rg-1",
        dcrName: "dcr-SecurityEvent-eastus",
      }),
    ).toBe(
      "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Insights/dataCollectionRules/dcr-SecurityEvent-eastus",
    );
  });
});

describe("upsertRoleTarget", () => {
  it("appends a new target without mutating the input", () => {
    const list: DcrRoleTarget[] = [target()];
    const next = upsertRoleTarget(list, target({
      dcrResourceId: "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Insights/dataCollectionRules/dcr-Syslog-eastus",
      table: "Syslog",
    }));
    expect(next).toHaveLength(2);
    expect(list).toHaveLength(1);
    expect(next[1].table).toBe("Syslog");
  });

  it("replaces an existing target with the same id (case-insensitive)", () => {
    const list: DcrRoleTarget[] = [target({ table: "old" })];
    const next = upsertRoleTarget(
      list,
      target({
        dcrResourceId: target().dcrResourceId.toUpperCase(),
        table: "new",
      }),
    );
    expect(next).toHaveLength(1);
    expect(next[0].table).toBe("new");
  });
});

describe("roleTargetDisplayName", () => {
  it("uses the table when present", () => {
    expect(roleTargetDisplayName(target())).toBe("SecurityEvent");
  });

  it("falls back to the DCR name (last path segment) when table is absent", () => {
    expect(
      roleTargetDisplayName({ dcrResourceId: target().dcrResourceId }),
    ).toBe("dcr-SecurityEvent-eastus");
  });

  it("falls back to the DCR name when table is empty", () => {
    expect(
      roleTargetDisplayName(target({ table: "" })),
    ).toBe("dcr-SecurityEvent-eastus");
  });
});

describe("roleAssignStepNames", () => {
  it("names one step per target with the core's step-name helper", () => {
    const names = roleAssignStepNames([
      target(),
      { dcrResourceId: "/x/y/z/dcr-Syslog-eastus", table: "Syslog" },
    ]);
    expect(names).toEqual([
      assignDcrRoleStepName("SecurityEvent"),
      assignDcrRoleStepName("Syslog"),
    ]);
  });
});

describe("projectRoleOutcome", () => {
  it("projects assigned / already / failed rows and the aggregate", () => {
    const outcome: AssignDcrRoleOutcome = {
      results: [
        {
          dcr: "SecurityEvent",
          dcrResourceId: "/a",
          assignmentName: "g1",
          success: true,
          alreadyAssigned: false,
        },
        {
          dcr: "Syslog",
          dcrResourceId: "/b",
          assignmentName: "g2",
          success: true,
          alreadyAssigned: true,
        },
        {
          dcr: "CommonSecurityLog",
          dcrResourceId: "/c",
          assignmentName: "g3",
          success: false,
          alreadyAssigned: false,
          error: "HTTP 403 forbidden",
        },
      ],
      assigned: 2,
      total: 3,
    };
    const view = projectRoleOutcome(outcome);
    expect(view.assigned).toBe(2);
    expect(view.total).toBe(3);
    expect(view.allSucceeded).toBe(false);
    expect(view.summary).toContain("2 of 3");
    expect(view.summary).toContain("Monitoring Metrics Publisher");
    expect(view.rows).toEqual([
      { dcr: "SecurityEvent", kind: "assigned", detail: ROLE_DETAIL_ASSIGNED },
      { dcr: "Syslog", kind: "already", detail: ROLE_DETAIL_ALREADY },
      { dcr: "CommonSecurityLog", kind: "failed", detail: "HTTP 403 forbidden" },
    ]);
  });

  it("marks allSucceeded when every target holds the role", () => {
    const outcome: AssignDcrRoleOutcome = {
      results: [
        {
          dcr: "SecurityEvent",
          dcrResourceId: "/a",
          assignmentName: "g1",
          success: true,
          alreadyAssigned: false,
        },
      ],
      assigned: 1,
      total: 1,
    };
    expect(projectRoleOutcome(outcome).allSucceeded).toBe(true);
  });

  it("is not allSucceeded for an empty outcome", () => {
    const outcome: AssignDcrRoleOutcome = { results: [], assigned: 0, total: 0 };
    expect(projectRoleOutcome(outcome).allSucceeded).toBe(false);
  });

  it("supplies fallback detail when a failed row carries no error text", () => {
    const outcome: AssignDcrRoleOutcome = {
      results: [
        {
          dcr: "SecurityEvent",
          dcrResourceId: "/a",
          assignmentName: "g1",
          success: false,
          alreadyAssigned: false,
        },
      ],
      assigned: 0,
      total: 1,
    };
    expect(projectRoleOutcome(outcome).rows[0].detail).toContain(
      "recorded no error text",
    );
  });
});
