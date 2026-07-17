import { describe, expect, it } from "vitest";
import {
  canDeployFoundation,
  defaultLabFormState,
  formatLabPhaseLine,
  foundationResultLines,
  labPlanArtifact,
  labPlanFromForm,
  labResourceNameRows,
  ttlExpiryPreview,
} from "./labs-state";
import type { ProvisionLabFoundationResult } from "@soc/core";

const SUB = "11111111-2222-3333-4444-555555555555";
const NOW = "2026-07-16T12:00:00.000Z";

function validForm() {
  return {
    ...defaultLabFormState(),
    baseObjectName: "cribllab",
    ttlEmail: "user@example.com",
  };
}

describe("defaultLabFormState", () => {
  it("defaults to SentinelLab, public, create-new, legacy TTL values", () => {
    const form = defaultLabFormState();
    expect(form.labType).toBe("SentinelLab");
    expect(form.labMode).toBe("public");
    expect(form.rgMode).toBe("create-new");
    expect(form.ttlHours).toBe("72");
    expect(form.ttlWarningHours).toBe("24");
  });
});

describe("labPlanFromForm", () => {
  it("produces a valid plan from a complete form", () => {
    const plan = labPlanFromForm(validForm(), SUB);
    expect(plan.errors).toEqual([]);
    expect(plan.resourceGroupName).toBe("rg-lab-SentinelLab");
  });

  it("rejects junk TTL input through the core validators (never coerces to 0)", () => {
    const plan = labPlanFromForm({ ...validForm(), ttlHours: "abc" }, SUB);
    expect(plan.errors.some((e) => e.includes("TTL hours"))).toBe(true);
  });

  it("flags a missing subscription (no Azure target committed)", () => {
    const plan = labPlanFromForm(validForm(), "");
    expect(plan.errors.some((e) => e.includes("subscriptionId"))).toBe(true);
  });
});

describe("canDeployFoundation", () => {
  it("gates on validation errors, then on the shell minter", () => {
    const good = labPlanFromForm(validForm(), SUB);
    expect(canDeployFoundation(good, true).ok).toBe(true);
    expect(canDeployFoundation(good, false).ok).toBe(false);
    expect(canDeployFoundation(good, false).reason).toContain("mintAssignmentName");

    const bad = labPlanFromForm({ ...validForm(), baseObjectName: "" }, SUB);
    expect(canDeployFoundation(bad, true).ok).toBe(false);
  });
});

describe("formatting", () => {
  it("formats a phase line with its steps", () => {
    const plan = labPlanFromForm(validForm(), SUB);
    expect(formatLabPhaseLine(plan.phases[0])).toBe(
      "Phase 1 - Foundation: Resource group, TTL self-destruct",
    );
  });

  it("previews the TTL expiry from an injected instant", () => {
    expect(ttlExpiryPreview(validForm(), NOW)).toBe(
      "self-destructs 2026-07-19T12:00:00Z (warning 2026-07-18T12:00:00Z)",
    );
    expect(ttlExpiryPreview({ ...validForm(), ttlHours: "junk" }, NOW)).toBe("");
  });
});

describe("labResourceNameRows", () => {
  it("lists only what the profile deploys", () => {
    const sentinel = labPlanFromForm(validForm(), SUB);
    const sentinelRows = labResourceNameRows(sentinel.names, sentinel.flags);
    expect(sentinelRows.map((r) => r.label)).toEqual(["Log Analytics workspace"]);

    const complete = labPlanFromForm({ ...validForm(), labType: "CompleteLab" }, SUB);
    const completeRows = labResourceNameRows(complete.names, complete.flags);
    const labels = completeRows.map((r) => r.label);
    expect(labels).toContain("Virtual network");
    expect(labels).toContain("VPN gateway");
    expect(labels).toContain("Storage account");
    expect(labels).toContain("ADX cluster");
    expect(labels.filter((l) => l === "Event Hub")).toHaveLength(3);
  });
});

describe("labPlanArtifact", () => {
  it("is deterministic and named after the profile + mode", () => {
    const plan = labPlanFromForm(validForm(), SUB);
    const first = labPlanArtifact(plan);
    const second = labPlanArtifact(plan);
    expect(first.filename).toBe("lab-plan-SentinelLab-public.json");
    expect(first.json).toBe(second.json);
    expect(JSON.parse(first.json).resourceGroupName).toBe("rg-lab-SentinelLab");
  });
});

describe("foundationResultLines", () => {
  const base: ProvisionLabFoundationResult = {
    resourceGroupId: `/subscriptions/${SUB}/resourceGroups/rg-lab-SentinelLab`,
    resourceGroupCreated: true,
    ttlExpiresAt: "2026-07-19T12:00:00Z",
    logicAppName: "la-ttl-cleanup-cribllab",
    logicAppCreated: true,
    principalId: "principal-1",
    roleAssigned: true,
    roleAlreadyAssigned: false,
    ok: true,
  };

  it("summarizes a clean create honestly", () => {
    const lines = foundationResultLines(base);
    expect(lines[0]).toContain("Resource group created");
    expect(lines.some((l) => l.includes("self-destruct expires"))).toBe(true);
    expect(lines.some((l) => l.includes("can now self-delete"))).toBe(true);
  });

  it("surfaces the manual grant command when the role step failed", () => {
    const lines = foundationResultLines({
      ...base,
      roleAssigned: false,
      manualRoleAssignmentCommand: "az role assignment create --assignee-object-id principal-1",
      ok: false,
    });
    expect(lines.some((l) => l.includes("will not self-destruct"))).toBe(true);
    expect(lines.some((l) => l.startsWith("az role assignment create"))).toBe(true);
  });

  it("says TTL extended for a reused group", () => {
    const lines = foundationResultLines({ ...base, resourceGroupCreated: false });
    expect(lines[0]).toContain("TTL extended");
  });
});
