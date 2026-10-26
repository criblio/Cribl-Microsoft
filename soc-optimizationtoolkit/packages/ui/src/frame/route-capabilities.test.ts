// Pins for the route -> capability table.
//
// The table fails toward reachable: an id it does not list resolves to [], so
// capabilitiesForRoute alone cannot tell "deliberately needs nothing" from
// "nobody wrote an entry". For azure-onboarding that difference is the point -
// its actions are needed but not yet measurable (CAP-7) - so the entry is
// pinned to EXIST, not merely to resolve to [].

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ROUTE_CAPABILITIES, capabilitiesForRoute } from "./route-capabilities";

describe("ROUTE_CAPABILITIES['azure-onboarding']", () => {
  it("is an explicit entry, not the unknown-id fallback", () => {
    expect(Object.hasOwn(ROUTE_CAPABILITIES, "azure-onboarding")).toBe(true);
  });

  it("requires nothing until CAP-7 measures its actions", () => {
    expect(ROUTE_CAPABILITIES["azure-onboarding"]).toEqual([]);
    expect(capabilitiesForRoute("azure-onboarding")).toEqual([]);
  });

  it("carries the comment naming CAP-7, so the empty entry reads as pending", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "route-capabilities.ts"),
      "utf8",
    );
    const lines = source.split(/\r?\n/);
    const at = lines.findIndex((l) => l.includes('"azure-onboarding": []'));
    expect(at).toBeGreaterThan(0);
    // The comment block directly above the entry, up to the previous entry.
    const above: string[] = [];
    for (let i = at - 1; i >= 0 && lines[i].trim().startsWith("//"); i--) above.push(lines[i]);
    expect(above.join("\n")).toContain("CAP-7");
  });
});

describe("capabilitiesForRoute", () => {
  it("resolves an unlisted id to [] (fails toward reachable)", () => {
    expect(Object.hasOwn(ROUTE_CAPABILITIES, "no-such-route")).toBe(false);
    expect(capabilitiesForRoute("no-such-route")).toEqual([]);
  });

  it("returns the listed capabilities for a constrained route", () => {
    expect(capabilitiesForRoute("labs")).toEqual(["arm.deploy"]);
  });
});
