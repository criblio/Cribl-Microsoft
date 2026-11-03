import { describe, expect, it } from "vitest";
import {
  allowanceFor,
  criblWritable,
  E5_QUALIFYING_SKUS,
  eligibleTables,
} from "./allowance-catalog";

describe("allowanceFor", () => {
  it("tags SecurityAlert Free (Free wins over Servers P2)", () => {
    expect(allowanceFor("SecurityAlert")).toEqual({ kind: "free" });
  });
  it("is case-insensitive and tags Entra tables E5", () => {
    expect(allowanceFor("signinlogs")).toEqual({
      kind: "grant",
      grant: "e5",
      condition: null,
    });
  });
  it("tags SecurityEvent Servers P2", () => {
    expect(allowanceFor("SecurityEvent")).toEqual({
      kind: "grant",
      grant: "servers-p2",
      condition: null,
    });
  });
  it("carries conditions for Update and WindowsEvent", () => {
    const update = allowanceFor("Update");
    const winEvent = allowanceFor("WindowsEvent");
    expect(update.kind === "grant" && update.condition).toMatch(
      /Update Management/,
    );
    expect(winEvent.kind === "grant" && winEvent.condition).toMatch(
      /Microsoft-SecurityEvent/,
    );
  });
  it("treats unlisted tables as billable", () => {
    expect(allowanceFor("CommonSecurityLog")).toEqual({ kind: "billable" });
    expect(allowanceFor("Zscaler_CL")).toEqual({ kind: "billable" });
  });
});

describe("eligibleTables", () => {
  it("has the spec's counts", () => {
    expect(eligibleTables("e5")).toHaveLength(29);
    expect(eligibleTables("e5")).toContain("InformationProtectionLogs_CL");
    expect(eligibleTables("servers-p2")).toHaveLength(13);
  });
});

describe("E5_QUALIFYING_SKUS", () => {
  it("has GUID-shaped, unique skuIds", () => {
    const guid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(E5_QUALIFYING_SKUS.length).toBeGreaterThan(0);
    for (const s of E5_QUALIFYING_SKUS) expect(s.skuId).toMatch(guid);
    expect(new Set(E5_QUALIFYING_SKUS.map((s) => s.skuId)).size).toBe(
      E5_QUALIFYING_SKUS.length,
    );
  });
});

describe("criblWritable", () => {
  it("is no for Entra and Defender XDR tables", () => {
    expect(criblWritable("SigninLogs")).toBe("no");
    expect(criblWritable("devicenetworkevents")).toBe("no");
    expect(criblWritable("DeviceEvents")).toBe("no");
  });
  it("is yes for a native table in the bundled catalog", () => {
    expect(criblWritable("SecurityEvent")).toBe("yes");
    expect(criblWritable("commonsecuritylog")).toBe("yes");
  });
  it("is unknown otherwise", () => {
    expect(criblWritable("NotARealTable_XYZ")).toBe("unknown");
  });
});
