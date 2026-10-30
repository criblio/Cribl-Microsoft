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
import { annotateNavItems, emptyCapabilitySet } from "@soc/core";
import { ROUTE_CAPABILITIES, capabilitiesForRoute } from "./route-capabilities";

describe("ROUTE_CAPABILITIES['azure-onboarding']", () => {
  it("is an explicit entry, not the unknown-id fallback", () => {
    expect(Object.hasOwn(ROUTE_CAPABILITIES, "azure-onboarding")).toBe(true);
  });

  // CAP-7a added the Defender capabilities but deliberately left this entry
  // empty (see the comment above it in route-capabilities.ts): the screen
  // still states its permissions as not yet measured, and the route serves
  // more than the Defender export.
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

  it("gates Event Hub discovery on the Resource Graph read it actually makes (CAP-1)", () => {
    // Was [] while no capability covered Resource Graph. Exactly this one: a
    // workspace or DCR read here would misreport what the screen needs.
    expect(capabilitiesForRoute("eventhub-discovery")).toEqual(["resourcegraph.read"]);
  });
});

describe("ROUTE_CAPABILITIES.integrate (GEN-21, decision F2-e)", () => {
  it("needs only destination.manage - the Cribl side every path uses", () => {
    expect(capabilitiesForRoute("integrate")).toEqual(["destination.manage"]);
  });

  it("stays attemptable for an operator with no Azure identity", () => {
    // The offline path: Cribl reachable, no tenant or client id. With
    // dcr.write listed this item was `unreachable` and not attemptable.
    const [annotated] = annotateNavItems(
      [{ id: "integrate", requires: capabilitiesForRoute("integrate") }],
      emptyCapabilitySet(),
      { azureIdentityPresent: false, criblReachable: true },
    );
    expect(annotated?.availability).toBe("unknown");
    expect(annotated?.attemptable).toBe(true);
    expect(annotated?.missing).toEqual(["destination.manage"]);
  });

  it("no longer carries a dcr.write denial onto the nav item", () => {
    const [annotated] = annotateNavItems(
      [{ id: "integrate", requires: capabilitiesForRoute("integrate") }],
      {
        verdicts: { "dcr.write": "denied", "destination.manage": "granted" },
        auditedAt: null,
        connectionId: null,
      },
      { azureIdentityPresent: true, criblReachable: true },
    );
    expect(annotated?.availability).toBe("available");
    expect(annotated?.fallback).toBeNull();
  });
});
