/**
 * Contract tests for the app-mode module:
 *   - tolerant parsing (bare string, JSON string, legacy {"mode":...} object;
 *     everything unrecognized -> null = not yet chosen)
 *   - serialize/parse round-trips
 *   - the full capability matrix (4 modes x hasAzure/hasCribl, plus null)
 *   - the full nav-filter matrix (4 modes x 4 requirements, plus null)
 *   - AcceptanceRecord tolerant parsing and round-trip (null = not accepted)
 */
import { describe, expect, it } from "vitest";
import {
  APP_MODES,
  filterNavItems,
  hasAzure,
  hasCribl,
  parseAcceptanceRecord,
  parseAppMode,
  satisfiesRequirement,
  serializeAcceptanceRecord,
  serializeAppMode,
} from "./index";
import type { AppMode, NavRequirement } from "./index";

describe("parseAppMode", () => {
  it("parses each valid bare mode string", () => {
    for (const mode of APP_MODES) {
      expect(parseAppMode(mode)).toBe(mode);
    }
  });

  it("ignores surrounding whitespace on a bare mode string", () => {
    expect(parseAppMode("  air-gapped\n")).toBe("air-gapped");
  });

  it("parses a JSON string literal", () => {
    expect(parseAppMode('"cribl-only"')).toBe("cribl-only");
  });

  it("parses the legacy integration-mode.json object shape", () => {
    expect(parseAppMode('{"mode":"azure-only"}')).toBe("azure-only");
  });

  it("drops extra keys on the legacy object shape", () => {
    expect(parseAppMode('{"mode":"full","stale":"whatever"}')).toBe("full");
  });

  it("returns null for null, undefined, and empty input", () => {
    expect(parseAppMode(null)).toBeNull();
    expect(parseAppMode(undefined)).toBeNull();
    expect(parseAppMode("")).toBeNull();
    expect(parseAppMode("   ")).toBeNull();
  });

  it("returns null for unknown mode names in every accepted shape", () => {
    expect(parseAppMode("offline")).toBeNull();
    expect(parseAppMode('"offline"')).toBeNull();
    expect(parseAppMode('{"mode":"offline"}')).toBeNull();
  });

  it("returns null for malformed JSON and wrong-typed payloads", () => {
    expect(parseAppMode("{not json")).toBeNull();
    expect(parseAppMode("42")).toBeNull();
    expect(parseAppMode("true")).toBeNull();
    expect(parseAppMode('["full"]')).toBeNull();
    expect(parseAppMode('{"mode":42}')).toBeNull();
    expect(parseAppMode('{"mode":null}')).toBeNull();
    expect(parseAppMode("{}")).toBeNull();
  });

  it("is case-sensitive (mode names are exact tokens)", () => {
    expect(parseAppMode("Full")).toBeNull();
    expect(parseAppMode("AIR-GAPPED")).toBeNull();
  });
});

describe("serializeAppMode", () => {
  it("round-trips every mode through parseAppMode", () => {
    for (const mode of APP_MODES) {
      expect(parseAppMode(serializeAppMode(mode))).toBe(mode);
    }
  });

  it("emits the legacy-compatible object shape", () => {
    expect(JSON.parse(serializeAppMode("full"))).toEqual({ mode: "full" });
  });
});

describe("capability predicates", () => {
  const matrix: Array<[AppMode | null, boolean, boolean]> = [
    // [mode, hasAzure, hasCribl]
    ["full", true, true],
    ["azure-only", true, false],
    ["cribl-only", false, true],
    ["air-gapped", false, false],
    [null, false, false], // not yet chosen -> no live capability
  ];

  for (const [mode, azure, cribl] of matrix) {
    it(`${String(mode)}: hasAzure=${azure}, hasCribl=${cribl}`, () => {
      expect(hasAzure(mode)).toBe(azure);
      expect(hasCribl(mode)).toBe(cribl);
    });
  }
});

describe("filterNavItems", () => {
  const items = [
    { id: "overview", requires: "none" as NavRequirement, label: "Overview" },
    { id: "data-flow", requires: "cribl" as NavRequirement, label: "Data Flow" },
    { id: "dcr", requires: "azure" as NavRequirement, label: "DCR Automation" },
    { id: "deploy", requires: "both" as NavRequirement, label: "Guided Deploy" },
  ];

  const expected: Record<string, string[]> = {
    full: ["overview", "data-flow", "dcr", "deploy"],
    "azure-only": ["overview", "dcr"],
    "cribl-only": ["overview", "data-flow"],
    "air-gapped": ["overview"],
  };

  for (const mode of APP_MODES) {
    it(`${mode} shows exactly [${expected[mode].join(", ")}]`, () => {
      expect(filterNavItems(mode, items).map((i) => i.id)).toEqual(
        expected[mode],
      );
    });
  }

  it("shows only requires:none items when the mode is not yet chosen", () => {
    expect(filterNavItems(null, items).map((i) => i.id)).toEqual(["overview"]);
  });

  it("covers the full mode x requirement matrix via satisfiesRequirement", () => {
    const requirements: NavRequirement[] = ["none", "cribl", "azure", "both"];
    const table: Record<AppMode, Record<NavRequirement, boolean>> = {
      full: { none: true, cribl: true, azure: true, both: true },
      "azure-only": { none: true, cribl: false, azure: true, both: false },
      "cribl-only": { none: true, cribl: true, azure: false, both: false },
      "air-gapped": { none: true, cribl: false, azure: false, both: false },
    };
    for (const mode of APP_MODES) {
      for (const requires of requirements) {
        expect(satisfiesRequirement(mode, requires), `${mode}/${requires}`).toBe(
          table[mode][requires],
        );
      }
    }
  });

  it("preserves item order and extra fields", () => {
    const filtered = filterNavItems("full", items);
    expect(filtered).toEqual(items);
    expect(filtered[0].label).toBe("Overview");
  });

  it("returns an empty array for no items", () => {
    expect(filterNavItems("full", [])).toEqual([]);
  });
});

describe("AcceptanceRecord codec", () => {
  it("parses a well-formed record", () => {
    expect(parseAcceptanceRecord('{"acceptedAt":"2026-07-03T12:00:00.000Z"}'))
      .toEqual({ acceptedAt: "2026-07-03T12:00:00.000Z" });
  });

  it("accepts the legacy accepted-terms.json shape, dropping extra keys", () => {
    const record = parseAcceptanceRecord(
      '{"accepted":true,"acceptedAt":"2025-01-01T00:00:00.000Z"}',
    );
    expect(record).toEqual({ acceptedAt: "2025-01-01T00:00:00.000Z" });
  });

  it("returns null (not accepted) for anything unusable", () => {
    expect(parseAcceptanceRecord(null)).toBeNull();
    expect(parseAcceptanceRecord(undefined)).toBeNull();
    expect(parseAcceptanceRecord("")).toBeNull();
    expect(parseAcceptanceRecord("not json")).toBeNull();
    expect(parseAcceptanceRecord("[]")).toBeNull();
    expect(parseAcceptanceRecord('"2026-07-03"')).toBeNull();
    expect(parseAcceptanceRecord("{}")).toBeNull();
    expect(parseAcceptanceRecord('{"accepted":true}')).toBeNull();
    expect(parseAcceptanceRecord('{"acceptedAt":""}')).toBeNull();
    expect(parseAcceptanceRecord('{"acceptedAt":"   "}')).toBeNull();
    expect(parseAcceptanceRecord('{"acceptedAt":12345}')).toBeNull();
  });

  it("round-trips through serialize/parse", () => {
    const record = { acceptedAt: "2026-07-03T12:34:56.789Z" };
    expect(parseAcceptanceRecord(serializeAcceptanceRecord(record))).toEqual(
      record,
    );
  });

  it("serializes only the known field", () => {
    const dirty = {
      acceptedAt: "2026-07-03T12:00:00.000Z",
      token: "leak",
    } as { acceptedAt: string };
    expect(JSON.parse(serializeAcceptanceRecord(dirty))).toEqual({
      acceptedAt: "2026-07-03T12:00:00.000Z",
    });
  });
});
