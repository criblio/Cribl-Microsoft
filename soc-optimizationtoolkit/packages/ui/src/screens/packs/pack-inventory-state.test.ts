/**
 * Tests for the pack inventory pure decisions (porting-plan Unit 19, GUI-19).
 * The install/deploy TRUTH (deployedGroups, applyRetention) is pinned in
 * @soc/core; these pin the SCREEN's projection and guards: newest-first row
 * ordering, name-based deployed badges from the live snapshot, the scoped
 * delete-id guard (no path semantics), the regenerate-vs-cached choice, and the
 * retention/storage summary.
 */
import { describe, expect, it } from "vitest";
import type { PackBuildRecord } from "@soc/core";
import type {
  DeployedGroupPacks,
  StoredPack,
} from "../../ports-context";
import {
  deriveDeployedBadge,
  deriveInventoryRows,
  deriveStorageSummary,
  formatCrblSize,
  resolveBytesSource,
  tablesSummary,
  validateDeleteId,
} from "./pack-inventory-state";

function record(overrides: Partial<PackBuildRecord> = {}): PackBuildRecord {
  const packName = overrides.packName ?? "cribl-palo-alto";
  const version = overrides.version ?? "1.0.0";
  return {
    id: overrides.id ?? `${packName}_${version}`,
    packName,
    displayName: overrides.displayName ?? "Palo Alto Sentinel",
    version,
    solutionName: overrides.solutionName ?? "Palo Alto Networks",
    builtAtMs: overrides.builtAtMs ?? 1_700_000_000_000,
    tables: overrides.tables ?? ["CommonSecurityLog"],
    crblFileName: overrides.crblFileName ?? `${packName}_${version}.crbl`,
    crblSizeBytes: overrides.crblSizeBytes ?? 2048,
  };
}

function storedPack(
  recordOverrides: Partial<PackBuildRecord> = {},
  extra: { cachedCrblBase64?: string } = {},
): StoredPack {
  const r = record(recordOverrides);
  const pack: StoredPack = {
    record: r,
    definition: {
      plan: {
        solutionName: r.solutionName,
        packName: r.packName,
        version: r.version,
        vendorPrefix: "palo_alto",
        tables: [],
      },
      builtAtMs: r.builtAtMs,
    },
  };
  if (extra.cachedCrblBase64 !== undefined) {
    pack.cachedCrblBase64 = extra.cachedCrblBase64;
  }
  return pack;
}

function group(name: string, packIds: string[]): DeployedGroupPacks {
  return {
    group: name,
    packs: packIds.map((id) => ({ id, displayName: id, version: "1.0.0" })),
  };
}

describe("deriveInventoryRows", () => {
  it("orders newest build first, then version descending", () => {
    const packs = [
      storedPack({ version: "1.0.0", builtAtMs: 100 }),
      storedPack({ version: "2.0.0", builtAtMs: 300 }),
      storedPack({ version: "1.5.0", builtAtMs: 300 }),
    ];
    const rows = deriveInventoryRows(packs, []);
    expect(rows.map((r) => r.version)).toEqual(["2.0.0", "1.5.0", "1.0.0"]);
  });

  it("derives deployed groups by pack NAME from the live snapshot", () => {
    const packs = [storedPack({ packName: "cribl-palo-alto", version: "1.0.0" })];
    const snapshot = [
      group("wg-prod", ["cribl-palo-alto"]),
      group("wg-dev", ["something-else"]),
    ];
    const [row] = deriveInventoryRows(packs, snapshot);
    expect(row.deployedGroups).toEqual(["wg-prod"]);
  });

  it("reports no deployed groups when the pack name is absent everywhere", () => {
    const packs = [storedPack({ packName: "cribl-palo-alto" })];
    const [row] = deriveInventoryRows(packs, [group("wg-prod", ["other"])]);
    expect(row.deployedGroups).toEqual([]);
  });

  it("flags the bytes source per row (cached vs regenerate)", () => {
    const rows = deriveInventoryRows(
      [
        storedPack({ version: "1.0.0" }),
        storedPack({ version: "2.0.0" }, { cachedCrblBase64: "AAAA" }),
      ],
      [],
    );
    // Newest (2.0.0) first, and it is the cached one.
    expect(rows[0].bytesSource).toBe("cached");
    expect(rows[1].bytesSource).toBe("regenerate");
  });
});

describe("deriveDeployedBadge", () => {
  it("labels an undeployed pack", () => {
    const [row] = deriveInventoryRows([storedPack()], []);
    const badge = deriveDeployedBadge(row);
    expect(badge).toMatchObject({ deployed: false, count: 0, tone: "not-deployed" });
    expect(badge.label).toBe("Not deployed");
  });

  it("labels a pack deployed on one group without pluralizing", () => {
    const [row] = deriveInventoryRows(
      [storedPack({ packName: "p" })],
      [group("wg-prod", ["p"])],
    );
    const badge = deriveDeployedBadge(row);
    expect(badge.deployed).toBe(true);
    expect(badge.label).toBe("Deployed on 1 group: wg-prod");
  });

  it("pluralizes and lists multiple groups", () => {
    const [row] = deriveInventoryRows(
      [storedPack({ packName: "p" })],
      [group("wg-a", ["p"]), group("wg-b", ["p"])],
    );
    expect(deriveDeployedBadge(row).label).toBe("Deployed on 2 groups: wg-a, wg-b");
  });
});

describe("validateDeleteId", () => {
  const packs = [storedPack({ id: "cribl-palo-alto_1.0.0" })];

  it("accepts a known record id", () => {
    expect(validateDeleteId("cribl-palo-alto_1.0.0", packs)).toEqual({ ok: true });
  });

  it("rejects an empty id", () => {
    expect(validateDeleteId("", packs).ok).toBe(false);
  });

  it("rejects path-like ids (no traversal semantics)", () => {
    for (const bad of ["../etc", "a/b", "a\\b", "..", "x/../y"]) {
      const check = validateDeleteId(bad, packs);
      expect(check.ok).toBe(false);
    }
  });

  it("rejects an unknown but well-formed id", () => {
    expect(validateDeleteId("ghost_9.9.9", packs).ok).toBe(false);
  });
});

describe("resolveBytesSource", () => {
  it("regenerates when there are no cached bytes", () => {
    expect(resolveBytesSource(storedPack())).toEqual({ kind: "regenerate" });
  });

  it("regenerates when the cache is an empty string", () => {
    expect(resolveBytesSource(storedPack({}, { cachedCrblBase64: "" }))).toEqual({
      kind: "regenerate",
    });
  });

  it("serves cached bytes when present", () => {
    expect(
      resolveBytesSource(storedPack({}, { cachedCrblBase64: "Zm9v" })),
    ).toEqual({ kind: "cached", base64: "Zm9v" });
  });
});

describe("deriveStorageSummary", () => {
  it("counts packs, distinct names, and total bytes", () => {
    const packs = [
      storedPack({ packName: "a", version: "1.0.0", crblSizeBytes: 1000 }),
      storedPack({ packName: "a", version: "2.0.0", crblSizeBytes: 2000 }),
      storedPack({ packName: "b", version: "1.0.0", crblSizeBytes: 500 }),
    ];
    const summary = deriveStorageSummary(packs, 5);
    expect(summary.totalPacks).toBe(3);
    expect(summary.distinctNames).toBe(2);
    expect(summary.totalBytes).toBe(3500);
    expect(summary.evictableIds).toEqual([]);
  });

  it("previews eviction with keep-newest-per-name retention", () => {
    const packs = [
      storedPack({ packName: "a", version: "1.0.0", builtAtMs: 100 }),
      storedPack({ packName: "a", version: "2.0.0", builtAtMs: 200 }),
    ];
    const summary = deriveStorageSummary(packs, 1);
    expect(summary.retainedIds).toEqual(["a_2.0.0"]);
    expect(summary.evictableIds).toEqual(["a_1.0.0"]);
  });
});

describe("formatCrblSize", () => {
  it("formats bytes, KiB, and MiB", () => {
    expect(formatCrblSize(512)).toBe("512 B");
    expect(formatCrblSize(786432)).toBe("768.0 KiB");
    expect(formatCrblSize(5 * 1024 * 1024)).toBe("5.0 MiB");
  });

  it("guards nonsense sizes", () => {
    expect(formatCrblSize(-1)).toBe("unknown size");
  });
});

describe("tablesSummary", () => {
  it("summarizes table lists", () => {
    expect(tablesSummary([])).toBe("no destination tables");
    expect(tablesSummary(["CommonSecurityLog"])).toBe("1 table: CommonSecurityLog");
    expect(tablesSummary(["A", "B"])).toBe("2 tables: A, B");
  });
});
