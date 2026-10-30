/**
 * GEN-21: the existing-destination path's pack build never reads Azure. The
 * build callback is out of a mount's reach, so the promise is pinned on the
 * helper it calls, with an Azure read that throws if it is ever touched.
 */

import { describe, expect, it, vi } from "vitest";
import {
  buildDestinationPath,
  definitionDestinationFields,
  resolveBuildDestinations,
} from "./build-destinations";

describe("resolveBuildDestinations", () => {
  it("never calls the Azure inventory read on the existing path", async () => {
    const readInventory = vi.fn(async () => {
      throw new Error("Azure must not be read on the existing-destination path");
    });
    const lines: string[] = [];
    const resolved = await resolveBuildDestinations({
      existing: { destination: "PAN-CSL" },
      planTables: ["CommonSecurityLog"],
      sessionDestinations: [],
      readInventory,
      push: (line) => lines.push(line),
    });
    expect(readInventory).not.toHaveBeenCalled();
    expect(resolved).toBeNull();
    expect(lines).toEqual([
      "Using the existing Cribl Sentinel destination PAN-CSL: the pack is routable " +
        "and ships no destination, so the Azure DCR inventory is not read and no " +
        "DCR, tenant or client id is written into the pack.",
    ]);
  });

  it("still reads the inventory on the native path for a table the session did not deploy", async () => {
    const readInventory = vi.fn(async () => []);
    const resolved = await resolveBuildDestinations({
      existing: null,
      planTables: ["CommonSecurityLog"],
      sessionDestinations: [],
      readInventory,
      push: () => undefined,
    });
    expect(readInventory).toHaveBeenCalledTimes(1);
    expect(resolved?.map((r) => [r.table, r.source])).toEqual([
      ["CommonSecurityLog", "unresolved"],
    ]);
  });

  it("never reads Azure for a native-path ROUTABLE pack, which ships no destination (GEN-25)", async () => {
    // A routable pack writes no outputs.yml, so DCR values resolved from the
    // inventory were thrown away - and an empty or failed read logged that
    // tables "will ship placeholder destination values", which a routable
    // pack never does. The session's own deploys are still matched, at no cost.
    const readInventory = vi.fn(async () => {
      throw new Error("Azure must not be read for a routable pack");
    });
    const lines: string[] = [];
    const resolved = await resolveBuildDestinations({
      existing: null,
      routable: true,
      planTables: ["CommonSecurityLog", "Syslog"],
      sessionDestinations: [
        {
          table: "Syslog",
          dcrImmutableId: "dcr-1",
          ingestionEndpoint: "https://e",
          dcrName: "dcr-syslog",
        },
      ],
      readInventory,
      push: (line) => lines.push(line),
    });
    expect(readInventory).not.toHaveBeenCalled();
    expect(lines).toEqual([
      "The pack is routable and ships no destination, so the Azure DCR inventory " +
        "is not read and no DCR values are written into the pack.",
    ]);
    expect(resolved?.map((r) => [r.table, r.source])).toEqual([
      ["CommonSecurityLog", "unresolved"],
      ["Syslog", "session"],
    ]);
  });

  it("reports a failed native read and builds on", async () => {
    const lines: string[] = [];
    const resolved = await resolveBuildDestinations({
      existing: null,
      planTables: ["CommonSecurityLog"],
      sessionDestinations: [],
      readInventory: async () => {
        throw new Error("HTTP 403");
      },
      push: (line) => lines.push(line),
    });
    expect(lines).toEqual([
      "Could not read deployed DCRs (Error: HTTP 403) - tables not deployed in this " +
        "session will ship placeholder destination values.",
    ]);
    expect(resolved).toHaveLength(1);
  });
});

describe("definitionDestinationFields (GEN-25)", () => {
  // The build definition is stored and replayed by a Packs-screen rebuild, so
  // what it carries decides the README both times. The build callback is out of
  // a mount's reach, so the choice is pinned here.
  const identity = { tenantId: "tenant-1", ingestionClientId: "client-1" };

  it("carries the PICKED id, and no Azure identity, on the existing path", () => {
    expect(
      definitionDestinationFields({ resolved: null, existingDestination: "PAN-CSL", ...identity }),
    ).toEqual({ existingDestinationId: "PAN-CSL" });
  });

  it("carries nothing on the existing path before a pick", () => {
    expect(
      definitionDestinationFields({ resolved: null, existingDestination: undefined, ...identity }),
    ).toEqual({});
  });

  it("stamps the Azure identity, and never a pick, on the native path", () => {
    expect(
      definitionDestinationFields({ resolved: [], existingDestination: "PAN-CSL", ...identity }),
    ).toEqual({ outputsDefaults: { tenantId: "tenant-1", ingestionClientId: "client-1" } });
  });
});

describe("buildDestinationPath (GEN-35: the build callback's wiring)", () => {
  it("takes the native path when the build needs the inventory, routable from the plan", () => {
    expect(
      buildDestinationPath({ dcrInventory: true, existingDestination: undefined, packShape: "routable" }),
    ).toEqual({ existing: null, routable: true });
    expect(
      buildDestinationPath({ dcrInventory: true, existingDestination: "sentinel-x", packShape: "all-inclusive" }),
    ).toEqual({ existing: null, routable: false });
    // A plan with no shape set is all-inclusive, never routable.
    expect(
      buildDestinationPath({ dcrInventory: true, existingDestination: undefined, packShape: undefined }),
    ).toEqual({ existing: null, routable: false });
  });

  it("takes the existing path whenever the inventory is not needed, even with no pick", () => {
    expect(
      buildDestinationPath({ dcrInventory: false, existingDestination: "sentinel-x", packShape: "routable" }),
    ).toEqual({ existing: { destination: "sentinel-x" }, routable: true });
    expect(
      buildDestinationPath({ dcrInventory: false, existingDestination: undefined, packShape: "routable" }),
    ).toEqual({ existing: { destination: "(not picked)" }, routable: true });
  });
});
