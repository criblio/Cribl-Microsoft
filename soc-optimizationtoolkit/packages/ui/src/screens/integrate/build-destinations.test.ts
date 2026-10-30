/**
 * GEN-21: the existing-destination path's pack build never reads Azure. The
 * build callback is out of a mount's reach, so the promise is pinned on the
 * helper it calls, with an Azure read that throws if it is ever touched.
 */

import { describe, expect, it, vi } from "vitest";
import { resolveBuildDestinations } from "./build-destinations";

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
