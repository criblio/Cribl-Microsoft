import { describe, expect, it } from "vitest";
import { appPermissionPlan } from "../app-permissions";
import {
  checklistEntries,
  effectiveSetupPath,
  requestedPermissions,
  requestedRoleNames,
  scopeNeed,
} from "./azure-connectivity";

const names = (xs: { name: string }[]) => xs.map((p) => p.name);

describe("azure connectivity (setup-pages-plan)", () => {
  it("full requests the whole plan for the saved path", () => {
    expect(names(requestedPermissions("full", [], "existing"))).toEqual(
      names(appPermissionPlan("existing")),
    );
  });

  it("partial requests only allowed entries and never leaks a lab path", () => {
    expect(
      names(requestedPermissions("partial", ["Reader"], "lab-new-rg")),
    ).toEqual(["Reader"]);
  });

  it("partial with nothing allowed requests nothing", () => {
    expect(requestedPermissions("partial", [], "existing")).toEqual([]);
  });

  it("disconnected requests nothing even when entries are allowed", () => {
    expect(requestedPermissions("disconnected", ["Reader"], "existing")).toEqual(
      [],
    );
  });

  it("scopeNeed is none for a tenant-only (Graph) partial request", () => {
    const req = requestedPermissions("partial", ["Application.Read.All"], "existing");
    expect(names(req)).toEqual(["Application.Read.All"]);
    expect(scopeNeed("partial", req)).toBe("none");
  });

  it("requestedRoleNames is the RBAC half of the request", () => {
    expect(
      requestedRoleNames("partial", ["Reader", "Application.Read.All"], "lab-new-rg"),
    ).toEqual(["Reader"]);
    expect(requestedRoleNames("disconnected", ["Reader"], "existing")).toEqual([]);
  });

  it("scopeNeed is none for disconnected and for an empty partial", () => {
    expect(scopeNeed("disconnected", [])).toBe("none");
    expect(scopeNeed("partial", [])).toBe("none");
  });

  it("partial with only Reader needs subscription scope", () => {
    const req = requestedPermissions("partial", ["Reader"], "existing");
    expect(scopeNeed("partial", req)).toBe("subscription");
  });

  it("partial with Reader and Monitoring Contributor needs full scope", () => {
    const req = requestedPermissions(
      "partial",
      ["Reader", "Monitoring Contributor"],
      "existing",
    );
    expect(names(req)).toEqual(
      expect.arrayContaining(["Reader", "Monitoring Contributor"]),
    );
    expect(scopeNeed("partial", req)).toBe("full");
  });

  it("full over the existing plan needs full scope", () => {
    expect(scopeNeed("full", appPermissionPlan("existing"))).toBe("full");
  });

  it("effectiveSetupPath collapses partial to existing only", () => {
    expect(effectiveSetupPath("partial", "lab-byo-rg")).toBe("existing");
    expect(effectiveSetupPath("full", "lab-byo-rg")).toBe("lab-byo-rg");
    expect(effectiveSetupPath("disconnected", "lab-byo-rg")).toBe("lab-byo-rg");
  });

  it("checklistEntries splits Reader from the other existing entries", () => {
    const { readOnly, others } = checklistEntries();
    expect(readOnly.name).toBe("Reader");
    expect(names(others)).toEqual(
      names(appPermissionPlan("existing")).filter((n) => n !== "Reader"),
    );
  });
});
