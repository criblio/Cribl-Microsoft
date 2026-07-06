/**
 * CrowdStrike FDR field-matching characterization - porting-plan Unit 13.
 *
 * Ports the legacy field-matcher.test.ts CrowdStrike blocks and the relevant
 * assertions from IS-T/test-uat-crowdstrike.ts (TEST 3 schema loading, TEST 4
 * field matching), run against the byte-faithful vendored crowdstrike-fdr corpus
 * and the pre-extracted bundled SchemaCatalog - the %APPDATA%/linked-repo state
 * the legacy tests needed is now the committed dcr-template-schemas.json asset.
 *
 * For ALL 10 tables: system columns filtered, matchRate > 0.3, event_simpleName
 * matched, timestamp mapped (not overflowed), NO Cribl internals leak, per-class
 * overflow config = AdditionalData_d, and the AdditionalData_d-missing warning.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseSampleContent } from "../sample-parsing/index";
import { CROWDSTRIKE_FDR_CORPUS } from "../../assets/sample-corpus/manifest";
import {
  createBundledSchemaCatalog,
  getOverflowConfig,
  matchParsedSampleToColumns,
  matchSampleToTable,
  resolveSchemaFromCatalog,
} from "./index";

const VALID_COLUMN_TYPES = new Set([
  "string",
  "int",
  "long",
  "real",
  "boolean",
  "datetime",
  "dynamic",
  "guid",
]);

function readCorpus(table: string): string {
  const url = new URL(
    `../../assets/sample-corpus/${table}.json`,
    import.meta.url,
  );
  return readFileSync(url, "utf8");
}

describe("field-matcher: CrowdStrike schema loading (uat TEST 3)", () => {
  for (const table of CROWDSTRIKE_FDR_CORPUS) {
    it(`loads schema for ${table}`, () => {
      const columns = resolveSchemaFromCatalog(table);
      expect(columns).not.toBeNull();
      expect(columns!.length).toBeGreaterThan(10);

      const colNames = new Set(columns!.map((c) => c.name));
      expect(colNames.has("TenantId")).toBe(false);
      expect(colNames.has("_ResourceId")).toBe(false);
      expect(colNames.has("TimeGenerated")).toBe(true);
      expect(colNames.has("event_simpleName")).toBe(true);

      for (const col of columns!) {
        expect(VALID_COLUMN_TYPES.has(col.type)).toBe(true);
      }
    });
  }
});

describe("field-matcher: CrowdStrike field matching (uat TEST 4)", () => {
  for (const table of CROWDSTRIKE_FDR_CORPUS) {
    describe(table, () => {
      const parsed = parseSampleContent(readCorpus(table), {
        sourceName: `${table}.json`,
      });
      const schema = resolveSchemaFromCatalog(table);
      const result = matchParsedSampleToColumns(parsed, schema, table);

      it("matches fields", () => {
        expect(result.matched.length).toBeGreaterThan(0);
      });

      it("achieves >30% match rate", () => {
        expect(result.matchRate).toBeGreaterThan(0.3);
      });

      it("matches event_simpleName", () => {
        const matched = result.matched.find(
          (m) => m.sourceName === "event_simpleName",
        );
        expect(matched).toBeDefined();
      });

      it("maps timestamp to a schema column (not overflow)", () => {
        const tsMatch = result.matched.find(
          (m) => m.sourceName === "timestamp",
        );
        expect(tsMatch).toBeDefined();
        expect(["timestamp", "TimeGenerated"]).toContain(tsMatch!.destName);
        expect(
          result.overflow.some((o) => o.sourceName === "timestamp"),
        ).toBe(false);
      });

      it("leaks no Cribl internal fields into matches", () => {
        const internals = result.matched.filter(
          (m) =>
            m.sourceName.startsWith("cribl_") ||
            m.sourceName.startsWith("__") ||
            m.sourceName === "_raw",
        );
        expect(internals).toHaveLength(0);
      });

      it("targets AdditionalData_d as the overflow field", () => {
        expect(getOverflowConfig(table).fieldName).toBe("AdditionalData_d");
        expect(result.overflowConfig.fieldName).toBe("AdditionalData_d");
      });

      it("surfaces the AdditionalData_d-missing warning (fix + pin)", () => {
        // Every CrowdStrike _CL custom schema carries AdditionalFields, NOT
        // AdditionalData_d, so the overflow column is absent: legacy dropped
        // these overflow fields SILENTLY. The warning makes it visible.
        expect(result.overflow.length).toBeGreaterThan(0);
        expect(result.overflowConfig.enabled).toBe(false);
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(
          result.warnings.some((w) => w.includes("AdditionalData_d")),
        ).toBe(true);
      });
    });
  }
});

describe("field-matcher: async SchemaCatalog path (matchSampleToTable)", () => {
  const catalog = createBundledSchemaCatalog();

  it.each(CROWDSTRIKE_FDR_CORPUS)(
    "resolves and matches %s through the port",
    async (table) => {
      const parsed = parseSampleContent(readCorpus(table), {
        sourceName: `${table}.json`,
      });
      const result = await matchSampleToTable(parsed, catalog, table);
      expect(result.matched.length).toBeGreaterThan(0);
      expect(result.matchRate).toBeGreaterThan(0.3);
      expect(
        result.warnings.some((w) => w.includes("AdditionalData_d")),
      ).toBe(true);
    },
  );
});
