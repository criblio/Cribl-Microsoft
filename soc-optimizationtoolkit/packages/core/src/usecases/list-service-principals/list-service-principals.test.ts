/**
 * Service-principal picker ordering pins (B3). The order is the user's rule:
 * own app first, then cribl-named (alpha), then the rest (alpha); deduped by id;
 * default selection is the own app's SP or empty.
 */

import { describe, expect, it } from "vitest";

import type { GraphDirectory, ServicePrincipalRef } from "../../ports/graph-directory";
import {
  acquireServicePrincipals,
  defaultServicePrincipalId,
  sortServicePrincipalsForPicker,
} from "./list-service-principals";

const sp = (id: string, appId: string, displayName: string): ServicePrincipalRef => ({
  id,
  appId,
  displayName,
});

describe("sortServicePrincipalsForPicker", () => {
  it("puts the own app first, then cribl-named alpha, then the rest alpha", () => {
    const list = [
      sp("obj-zebra", "app-zebra", "Zebra Analytics"),
      sp("obj-cribl-b", "app-cb", "Cribl Worker"),
      sp("obj-own", "app-own", "My Ingestion App"),
      sp("obj-cribl-a", "app-ca", "Cribl Edge"),
      sp("obj-acme", "app-acme", "Acme Portal"),
    ];
    const sorted = sortServicePrincipalsForPicker(list, "app-own");
    expect(sorted.map((s) => s.id)).toEqual([
      "obj-own", // own app (default) first
      "obj-cribl-a", // Cribl Edge before Cribl Worker (alpha)
      "obj-cribl-b",
      "obj-acme", // rest alpha: Acme before Zebra
      "obj-zebra",
    ]);
  });

  it("deduplicates by object id (first occurrence wins)", () => {
    const list = [
      sp("dup", "app-1", "First"),
      sp("dup", "app-2", "Second"),
      sp("uniq", "app-3", "Other"),
    ];
    const sorted = sortServicePrincipalsForPicker(list);
    // "dup" survives once (as "First"); alpha: First before Other.
    expect(sorted.map((s) => s.id)).toEqual(["dup", "uniq"]);
    expect(sorted.map((s) => s.displayName)).toEqual(["First", "Other"]);
  });

  it("orders cribl-named first when no own app id is supplied", () => {
    const list = [
      sp("o1", "a1", "Beacon"),
      sp("o2", "a2", "cribl stream"),
    ];
    const sorted = sortServicePrincipalsForPicker(list);
    expect(sorted.map((s) => s.id)).toEqual(["o2", "o1"]);
  });

  it("skips entries with an empty object id", () => {
    const list = [sp("", "a0", "No Id"), sp("o1", "a1", "Real")];
    expect(sortServicePrincipalsForPicker(list).map((s) => s.id)).toEqual(["o1"]);
  });

  it("treats a blank own app id as no own match (all fall through)", () => {
    const list = [sp("o1", "a1", "Beacon"), sp("o2", "a2", "Acme")];
    const sorted = sortServicePrincipalsForPicker(list, "  ");
    expect(sorted.map((s) => s.id)).toEqual(["o2", "o1"]);
  });
});

describe("defaultServicePrincipalId", () => {
  it("returns the own app's SP object id when present", () => {
    const sorted = [sp("obj-own", "app-own", "Mine"), sp("obj-x", "app-x", "X")];
    expect(defaultServicePrincipalId(sorted, "app-own")).toBe("obj-own");
  });

  it("returns empty when the own app has no SP in the list", () => {
    const sorted = [sp("obj-x", "app-x", "X")];
    expect(defaultServicePrincipalId(sorted, "app-own")).toBe("");
  });

  it("returns empty when no own app id is supplied", () => {
    const sorted = [sp("obj-x", "app-x", "X")];
    expect(defaultServicePrincipalId(sorted)).toBe("");
  });
});

describe("acquireServicePrincipals", () => {
  it("reads the port and returns picker order", async () => {
    const graph: GraphDirectory = {
      listServicePrincipals: async () => [
        sp("obj-b", "app-b", "Bravo"),
        sp("obj-own", "app-own", "Own"),
        sp("obj-a", "app-a", "Alpha"),
      ],
    };
    const sorted = await acquireServicePrincipals(graph, "app-own");
    expect(sorted.map((s) => s.id)).toEqual(["obj-own", "obj-a", "obj-b"]);
  });

  it("propagates a port rejection (caller falls back to manual entry)", async () => {
    const graph: GraphDirectory = {
      listServicePrincipals: async () => {
        throw new Error("Authorization_RequestDenied");
      },
    };
    await expect(acquireServicePrincipals(graph, "app-own")).rejects.toThrow(
      "Authorization_RequestDenied",
    );
  });
});
