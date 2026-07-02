/**
 * Characterization tests: every fixture in legacy-fixtures.json encodes the
 * exact column set the legacy PowerShell pipeline (Get-TableColumns +
 * ConvertTo-DCRColumnType, native-table mode) produces for that input
 * schema, mechanically derived from the transcribed rules and cross-checked
 * against script-generated templates in DCR-Automation/core/
 * generated-templates. This is the golden compatibility contract: if one of
 * these fails, the implementation is wrong - never the fixture.
 */
import { describe, expect, it } from "vitest";
import { buildDcrColumnSet, buildStreamDeclaration } from "./index";
import legacyFixtures from "./legacy-fixtures.json";

interface FixtureColumn {
  name: string;
  laType: string;
}

interface FixtureExpectation {
  columns: Array<{ name: string; dcrType: string }>;
  dropped: string[];
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
            transformKql: "source",
            outputStream: `Microsoft-${fixture.table}`,
          },
        ]);
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
