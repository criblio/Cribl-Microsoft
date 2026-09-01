// @vitest-environment happy-dom
/**
 * THE SEAM PIN for DBT-50: the picked table's LIVE columns actually reach the
 * analysis the operator sees.
 *
 * WHY THIS FILE EXISTS. The first fix for DBT-50 promoted the live tier to the
 * top of the schema ladder and pinned the new order in
 * `core/domain/field-matcher/schema-ladder.test.ts`. Those pins are real, but
 * they test the LADDER, and the defect was never in the ladder - it was in the
 * wiring between this screen's `liveSchemas` state and the ladder it builds.
 * The adversarial review proved the gap by severing exactly that wiring
 * (`live,` -> `live: {},` in the `createSchemaLadder` call): the ARM columns
 * stopped reaching resolution, DBT-50 was fully reintroduced, and all 1299 UI
 * tests still passed. A composition pin cannot see a composition that is never
 * handed its input.
 *
 * So this drives the REAL component through the real interaction - pick a table
 * from the destination dropdown - and asserts on the report the screen emits.
 * It fails if the fetched schema stops reaching the analysis, whichever half of
 * the wiring breaks: the state, the callback argument, or the ladder call.
 *
 * It also pins the COLUMN CONTRACT at the same seam (DBT-50's second defect):
 * the live ARM response carries Azure-managed columns, and a DCR generated from
 * this report must not declare them.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { DCR_SCHEMA_SYSTEM_COLUMNS, parseSampleContent } from "@soc/core";
import type {
  DestField,
  GapReport,
  SchemaCatalog,
  TaggedSample,
} from "@soc/core";
import { MappingReviewSection } from "./mapping-review-section";

afterEach(cleanup);

/** The table the operator picks - present in the workspace listing. */
const PICKED_TABLE = "ContosoAudit_CL";

/** Only the live tier can produce this; no other tier defines it. */
const LIVE_ONLY_COLUMN = "FromLiveArm";

/** What every OTHER tier would answer with, so a fallthrough is visible. */
const DERIVED_ONLY_COLUMN = "FromDerivedCatalog";

/**
 * A live ARM read of the picked table: three real columns plus every
 * Azure-managed name, which is what `standardColumns` carries for a native
 * table and what the tier had been passing straight through.
 */
const LIVE_ARM_SCHEMA: DestField[] = [
  { name: LIVE_ONLY_COLUMN, type: "string" },
  { name: "TimeGenerated", type: "datetime" },
  { name: "SrcUserName", type: "string" },
  ...DCR_SCHEMA_SYSTEM_COLUMNS.map((name) => ({ name, type: "string" })),
];

/**
 * The base catalog every non-picked table resolves through. It ALSO defines the
 * picked table, deliberately: that is the state the defect lived in - a table
 * the lower tiers can answer for, where dropping the live columns looks like a
 * perfectly normal analysis instead of an empty one.
 *
 * Its column COUNT differs from the live schema's on purpose. With both at
 * three, the count assertion below passed against the severed wiring - a pin
 * that reads like evidence and is measuring a coincidence.
 */
const derivedCatalog: SchemaCatalog = {
  resolveSchema: async () => [
    { name: DERIVED_ONLY_COLUMN, type: "string" },
    { name: "TimeGenerated", type: "datetime" },
    { name: "SrcUserName", type: "string" },
    { name: "DerivedExtraOne", type: "string" },
    { name: "DerivedExtraTwo", type: "string" },
  ],
};

function sample(): TaggedSample {
  const content = JSON.stringify({
    srcUser: "abby",
    action: "login",
    ts: "2026-08-31T12:00:00Z",
  });
  return {
    logType: "AUDIT",
    format: "json",
    rawEvents: [content],
    parsed: parseSampleContent(content, { sourceName: "audit.json" }),
  };
}

interface Harness {
  reports: () => GapReport[];
  container: HTMLElement;
  fetchTableSchema: ReturnType<typeof vi.fn>;
}

function renderSection(): Harness {
  let latest: GapReport[] = [];
  const fetchTableSchema = vi.fn(async (table: string) =>
    table === PICKED_TABLE ? LIVE_ARM_SCHEMA : null,
  );
  const { container } = render(
    <MappingReviewSection
      solutionName=""
      samples={[sample()]}
      catalog={derivedCatalog}
      workspaceTables={[PICKED_TABLE]}
      fetchTableSchema={fetchTableSchema}
      onReportsChange={(next) => {
        latest = next;
      }}
    />,
  );
  return { reports: () => latest, container, fetchTableSchema };
}

/** Click Analyze and wait for the first report to land. */
async function analyze(h: Harness): Promise<void> {
  const button = [...h.container.querySelectorAll("button")].find((b) =>
    /analyze/i.test(b.textContent ?? ""),
  );
  if (button === undefined) throw new Error("Analyze button not rendered");
  fireEvent.click(button);
  await waitFor(() => {
    expect(h.reports().length).toBe(1);
  });
}

/** Drive the destination-table combobox to `table`, as an operator would. */
async function pickTable(h: Harness, table: string): Promise<void> {
  const control = h.container.querySelector(
    ".mapping-review-table-select .searchable-select-control",
  );
  if (control === null) throw new Error("destination table control not rendered");
  fireEvent.click(control);
  const options = [...h.container.querySelectorAll(".searchable-select-option")];
  const option = options.find((o) => o.textContent?.includes(table));
  if (option === undefined) {
    throw new Error(
      `table ${table} not offered - saw: ${options
        .map((o) => o.textContent)
        .join(", ")}`,
    );
  }
  fireEvent.click(option);
  await waitFor(() => {
    expect(h.reports()[0]?.tableName).toBe(table);
  });
}

/** The destination columns the report offers - what a DCR would declare. */
function destColumnNames(report: GapReport): string[] {
  return report.destSchema.map((f) => f.name);
}

describe("mapping review - the picked table's live schema reaches the analysis", () => {
  it("analyses against the LIVE ARM columns, not the derived catalog", async () => {
    // THE PIN THE REVIEW ASKED FOR. Severing `live` in the createSchemaLadder
    // call makes the fetch still fire and still be awaited - and this fail,
    // because the report then describes the derived table instead.
    const h = renderSection();
    await analyze(h);
    expect(destColumnNames(h.reports()[0]!)).toContain(DERIVED_ONLY_COLUMN);

    await pickTable(h, PICKED_TABLE);

    expect(h.fetchTableSchema).toHaveBeenCalledWith(PICKED_TABLE);
    const names = destColumnNames(h.reports()[0]!);
    expect(names).toContain(LIVE_ONLY_COLUMN);
    expect(names).not.toContain(DERIVED_ONLY_COLUMN);
  });

  it("declares NO Azure-managed column from the live read", async () => {
    // The live ARM response carried all 18. A DCR generated from this report
    // must declare none of them - the contract the other three tiers keep.
    const h = renderSection();
    await analyze(h);
    await pickTable(h, PICKED_TABLE);

    const names = destColumnNames(h.reports()[0]!);
    for (const system of DCR_SCHEMA_SYSTEM_COLUMNS) {
      expect(names, `report declared managed column ${system}`).not.toContain(
        system,
      );
    }
    // The three real columns survive, so the strip is not just "returned
    // nothing" passing by accident.
    expect(names.length).toBe(3);
    expect([...names].sort()).toEqual(
      [LIVE_ONLY_COLUMN, "SrcUserName", "TimeGenerated"].sort(),
    );
  });

  it("reports the live column COUNT, not the raw ARM count", async () => {
    // The operator-visible number, and the measurement DBT-50 turns on: 21
    // columns came back from ARM, 3 of them are columns a DCR may declare, and
    // the derived schema this replaced had 5 - so a wrong answer from either
    // defect (18 spurious columns, or the live read never arriving) shows up
    // here as a different number rather than as a silently plausible one.
    expect(LIVE_ARM_SCHEMA.length).toBe(21);
    const h = renderSection();
    await analyze(h);
    expect(h.reports()[0]!.destFieldCount).toBe(5);

    await pickTable(h, PICKED_TABLE);
    expect(h.reports()[0]!.destFieldCount).toBe(3);
  });
});
