/**
 * Characterization tests: every fixture in legacy-fixtures.json encodes the
 * exact column set the legacy PowerShell pipeline (Get-TableColumns +
 * ConvertTo-DCRColumnType, native-table mode) produces for that input
 * schema, mechanically derived from the transcribed rules and cross-checked
 * against script-generated templates in DCR-Automation/core/
 * generated-templates. This is the golden compatibility contract: if one of
 * these fails, the implementation is wrong - never the fixture.
 *
 * ONE EXCEPTION, and it is the only one (ADR 0004, 2026-08-23). For GUID-TYPED
 * columns the sentence above no longer holds: legacy dropped them, we declare
 * them string and promote them with toguid(), and the fixtures were amended to
 * match US rather than the script. The amendment was mechanical and minimal -
 * guid columns moved from `dropped` into `columns` at their source-order
 * position with dcrType "string", and into the new `casts` list; every other
 * legacy-derived dcrType and drop in every fixture is untouched. Six columns
 * across two fixtures (AWSCloudTrail 3, SyntheticTypeMatrix 3).
 *
 * The reason the fixture lost this argument: legacy's behaviour silently
 * discarded those fields at the DCR boundary, so bug-compatibility here meant
 * shipping data loss. Everywhere else, the fixture still wins.
 */
import { describe, expect, it } from "vitest";
import {
  buildDcrColumnSet,
  buildStreamDeclaration,
  buildTransformKql,
} from "./index";
import legacyFixtures from "./legacy-fixtures.json";

interface FixtureColumn {
  name: string;
  laType: string;
}

interface FixtureExpectation {
  columns: Array<{ name: string; dcrType: string }>;
  dropped: string[];
  /** ADR 0004: columns declared string and promoted in the transform. */
  casts: Array<{ name: string; laType: string; cast: string }>;
}

interface LegacyFixture {
  table: string;
  inputColumns: FixtureColumn[];
  expected: FixtureExpectation;
}

const fixtures: LegacyFixture[] = legacyFixtures;

describe("legacy characterization fixtures", () => {
  it("pins all 9 recorded fixtures totalling 700 input columns", () => {
    expect(fixtures).toHaveLength(9);
    const totalInputColumns = fixtures.reduce(
      (total, fixture) => total + fixture.inputColumns.length,
      0,
    );
    expect(totalInputColumns).toBe(700);
  });

  for (const fixture of fixtures) {
    describe(fixture.table, () => {
      it(
        `maps ${fixture.inputColumns.length} input columns to ` +
          `${fixture.expected.columns.length} DCR columns ` +
          `(${fixture.expected.dropped.length} dropped)`,
        () => {
          const result = buildDcrColumnSet(
            fixture.inputColumns.map((column) => ({
              name: column.name,
              type: column.laType,
            })),
            "native",
          );

          expect(result.columns).toEqual(
            fixture.expected.columns.map((column) => ({
              name: column.name,
              type: column.dcrType,
            })),
          );
          expect(result.dropped.map((dropped) => dropped.name)).toEqual(
            fixture.expected.dropped,
          );
          expect(result.casts).toEqual(fixture.expected.casts);
        },
      );

      it("shapes the legacy stream declaration around the mapped columns", () => {
        const result = buildDcrColumnSet(
          fixture.inputColumns.map((column) => ({
            name: column.name,
            type: column.laType,
          })),
          "native",
        );
        const declaration = buildStreamDeclaration(
          fixture.table,
          result.columns,
          "native",
          result.casts,
        );

        expect(declaration.streamName).toBe(`Custom-${fixture.table}`);
        expect(declaration.outputStreamName).toBe(`Microsoft-${fixture.table}`);
        expect(Object.keys(declaration.streamDeclarations)).toEqual([
          `Custom-${fixture.table}`,
        ]);
        expect(
          declaration.streamDeclarations[`Custom-${fixture.table}`]?.columns,
        ).toEqual(result.columns);
        expect(declaration.dataFlows).toEqual([
          {
            streams: [`Custom-${fixture.table}`],
            destinations: ["logAnalyticsWorkspace"],
            transformKql: buildTransformKql(result.casts),
            outputStream: `Microsoft-${fixture.table}`,
          },
        ]);
        // THE REGRESSION GUARD for ADR 0004's blast radius: a table with no
        // guid columns must still emit the bare literal, byte for byte. Seven
        // of the nine fixtures take this branch, so the assertion above cannot
        // pass merely because both sides call the same builder.
        if (result.casts.length === 0) {
          expect(declaration.dataFlows[0]?.transformKql).toBe("source");
        } else {
          expect(declaration.dataFlows[0]?.transformKql).toContain(
            "| extend ",
          );
        }
      });
    });
  }

  it("only SyntheticTypeMatrix exercises the unknown-type fallback", () => {
    for (const fixture of fixtures) {
      const result = buildDcrColumnSet(
        fixture.inputColumns.map((column) => ({
          name: column.name,
          type: column.laType,
        })),
        "native",
      );
      if (fixture.table === "SyntheticTypeMatrix") {
        expect(result.unknownTypes).toEqual([
          { name: "ColUnknownType", laType: "sbyte" },
        ]);
      } else {
        expect(result.unknownTypes).toEqual([]);
      }
    }
  });
});
