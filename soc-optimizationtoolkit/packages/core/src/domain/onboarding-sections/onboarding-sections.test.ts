// Pins for the onboarding section layout and per-item availability (AZR-18).
//
// Each pin is aimed at one way the screen could silently go wrong: a dropped
// row (the XDR tables especially, which live outside UNSUPPORTED_SOURCES), a
// catalog item shown twice or not at all, a deploy path offered that does not
// exist, and the Defender export hidden because its sibling entraId is not
// built. The copy-history check is NOT here: findHistoryInCopy lives in ui and
// core imports nothing from ui (the last pin holds that line).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  COVERAGE_CATALOG,
  UNSUPPORTED_SOURCES,
  XDR_TABLES_NOT_SUPPORTED,
} from "../coverage-model";
import {
  ITEM_AVAILABILITY,
  ITEM_PREREQUISITES,
  ONBOARDING_SECTIONS,
  XDR_TABLES_ROW_ID,
  itemAvailability,
  sectionAvailability,
  type OnboardingSection,
} from "./index";

const HERE = dirname(fileURLToPath(import.meta.url));
const allRows = ONBOARDING_SECTIONS.flatMap((s) => s.rows);

function section(key: OnboardingSection["key"]): OnboardingSection {
  const s = ONBOARDING_SECTIONS.find((x) => x.key === key);
  if (!s) throw new Error(`no section ${key}`);
  return s;
}

describe("ONBOARDING_SECTIONS layout", () => {
  it("has catalog + unsupported + exactly one XDR row, in total", () => {
    expect(allRows.length).toBe(COVERAGE_CATALOG.length + UNSUPPORTED_SOURCES.length + 1);
    expect(allRows.filter((r) => r.kind === "xdr-tables")).toHaveLength(1);
  });

  it("orders the tickable methods first, then the reference section last", () => {
    expect(ONBOARDING_SECTIONS.map((s) => s.key)).toEqual([
      "built-in-policy",
      "custom-initiative",
      "script",
      "guided-portal",
      "none",
    ]);
  });

  it("carries both BehaviorEntities and BehaviorInfo in the explicit XDR row", () => {
    const xdr = section("none").rows.find((r) => r.kind === "xdr-tables");
    expect(xdr).toBeDefined();
    if (xdr?.kind !== "xdr-tables") throw new Error("unreachable");
    expect(xdr.id).toBe(XDR_TABLES_ROW_ID);
    expect([...xdr.tables].sort()).toEqual(["BehaviorEntities", "BehaviorInfo"]);
    expect(xdr.reason).toBe(XDR_TABLES_NOT_SUPPORTED.reason);
    // The XDR row comes after every unsupported source, as the last row.
    const none = section("none").rows;
    expect(none[none.length - 1]).toBe(xdr);
  });

  it("shows every catalog id exactly once, each in its own method's section", () => {
    const itemRows = allRows.filter((r) => r.kind === "item");
    const counts = new Map<string, number>();
    for (const r of itemRows) counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
    for (const item of COVERAGE_CATALOG) {
      expect(counts.get(item.id), item.id).toBe(1);
      const home = section(item.method);
      expect(home.rows.some((r) => r.kind === "item" && r.id === item.id), item.id).toBe(true);
    }
    expect(itemRows).toHaveLength(COVERAGE_CATALOG.length);
  });

  it("shows every unsupported source exactly once, in the reference section", () => {
    const ids = section("none")
      .rows.filter((r) => r.kind === "unsupported")
      .map((r) => r.id);
    expect(ids).toEqual(UNSUPPORTED_SOURCES.map((u) => u.id));
  });

  it("gives every section a non-empty title, each distinct", () => {
    const titles = ONBOARDING_SECTIONS.map((s) => s.title);
    for (const t of titles) expect(t.trim().length).toBeGreaterThan(0);
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe("ITEM_AVAILABILITY", () => {
  it("has exactly one available item: defenderExport", () => {
    const available = Object.entries(ITEM_AVAILABILITY)
      .filter(([, a]) => a.status === "available")
      .map(([id]) => id);
    expect(available).toEqual(["defenderExport"]);
  });

  it("has an entry for every catalog id and no other", () => {
    expect(Object.keys(ITEM_AVAILABILITY).sort()).toEqual(
      COVERAGE_CATALOG.map((i) => i.id).sort(),
    );
  });

  it("gives every not-built item a non-empty reason", () => {
    for (const [id, a] of Object.entries(ITEM_AVAILABILITY)) {
      if (a.status === "not-built") expect(a.reason.trim().length, id).toBeGreaterThan(0);
    }
  });

  it("treats an unknown id as not built, never available", () => {
    expect(itemAvailability("noSuchItem").status).toBe("not-built");
    expect(itemAvailability("defenderExport").status).toBe("available");
    expect(itemAvailability("entraId").status).toBe("not-built");
  });
});

describe("ITEM_PREREQUISITES", () => {
  it("names the Event Hub target for every catalog item, and covers no other id", () => {
    expect(Object.keys(ITEM_PREREQUISITES).sort()).toEqual(
      COVERAGE_CATALOG.map((i) => i.id).sort(),
    );
    for (const item of COVERAGE_CATALOG) {
      expect(ITEM_PREREQUISITES[item.id], item.id).toEqual(["eventHubTarget"]);
    }
  });

  it("keeps the prerequisite outside the catalog: it is not a row anyone can tick", () => {
    expect(allRows.some((r) => r.id === "eventHubTarget")).toBe(false);
  });
});

describe("sectionAvailability", () => {
  it("makes the script section available while entraId, in the same section, is not built", () => {
    const script = section("script");
    expect(script.rows.map((r) => r.id)).toEqual(
      expect.arrayContaining(["entraId", "defenderExport"]),
    );
    expect(itemAvailability("entraId").status).toBe("not-built");
    expect(sectionAvailability(script)).toBe("available");
  });

  it("marks sections with only unbuilt items as not-built, and the reference section as reference", () => {
    expect(sectionAvailability(section("built-in-policy"))).toBe("not-built");
    expect(sectionAvailability(section("custom-initiative"))).toBe("not-built");
    expect(sectionAvailability(section("guided-portal"))).toBe("not-built");
    expect(sectionAvailability(section("none"))).toBe("reference");
  });
});

describe("layering", () => {
  it("imports nothing from the ui package (findHistoryInCopy stays in the ui test)", () => {
    for (const f of ["onboarding-sections.ts", "index.ts", "onboarding-sections.test.ts"]) {
      const src = readFileSync(join(HERE, f), "utf8");
      // Split so this line does not match itself.
      expect(src.includes("@soc/" + "ui"), f).toBe(false);
      expect(/from\s+["'][^"']*packages\/ui/.test(src), f).toBe(false);
    }
  });
});
