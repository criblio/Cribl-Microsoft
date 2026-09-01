/**
 * Pins for the COMPOSED schema ladder (DBT-50).
 *
 * The individual tiers each had pins; the ORDER they are stacked in had none,
 * which is why it drifted for three weeks with the live tier buried under both
 * repo tiers. Every tier below therefore defines the SAME table with a distinct
 * marker column, so a pin fails by naming the tier that actually answered
 * rather than by a count nobody can read.
 *
 * The load-bearing pin is "live outranks the KQL-validation tier": that is the
 * DBT-50 judgement, and reverting the composition to the old inner-most order
 * is what it has to fail on.
 */

import { describe, expect, it } from "vitest";
import { createSchemaLadder } from "./schema-ladder";
import { KQL_VALIDATION_TABLES_DIR } from "./kql-validation-schema-catalog";
import { DCR_SCHEMA_SYSTEM_COLUMNS } from "./system-columns";
import type { DcrSchemaColumn, SchemaCatalog } from "../../ports/schema-catalog";
import type { SentinelContent } from "../../ports/sentinel-content";

const SOLUTION = "Contoso Solution";
const CONNECTOR_FILE = `Solutions/${SOLUTION}/Data Connectors/Contoso_Tables.json`;

const LIVE_COLUMN: DcrSchemaColumn = { name: "FromLiveArm", type: "string" };
const KQL_COLUMN: DcrSchemaColumn = { name: "FromKqlValidation", type: "string" };
const SOLUTION_COLUMN: DcrSchemaColumn = { name: "FromSolutionArm", type: "string" };
const BASE_COLUMN: DcrSchemaColumn = { name: "FromBundledBase", type: "string" };

/** The bundled/injected last resort: defines every table it is asked about. */
const base: SchemaCatalog = {
  resolveSchema: async (name) =>
    name.toLowerCase().startsWith("known") ? [{ ...BASE_COLUMN }] : null,
};

/**
 * A SentinelContent that serves the two repo tiers for the named tables.
 *
 * `kqlTables` answers the direct exact-name read the KQL tier does first;
 * `solutionTables` answers the connector-file listing the solution tier walks.
 */
function contentWith(opts: {
  kqlTables?: readonly string[];
  solutionTables?: readonly string[];
}): SentinelContent {
  const kql = new Set(opts.kqlTables ?? []);
  const solutionTables = opts.solutionTables ?? [];
  return {
    listSolutions: async () => [],
    listSolutionFiles: async () => [],
    listRepoFiles: async () => [],
    listConnectorFiles: async () =>
      solutionTables.length === 0
        ? []
        : [{ name: "Contoso_Tables.json", path: CONNECTOR_FILE, size: 1 }],
    readFile: async (path) => {
      for (const table of kql) {
        if (path === `${KQL_VALIDATION_TABLES_DIR}/${table}.json`) {
          return JSON.stringify({
            Name: table,
            Properties: [{ Name: KQL_COLUMN.name, Type: "String" }],
          });
        }
      }
      if (path === CONNECTOR_FILE) {
        return JSON.stringify({
          resources: solutionTables.map((table) => ({
            type: "Microsoft.OperationalInsights/workspaces/tables",
            properties: {
              schema: { name: table, columns: [{ ...SOLUTION_COLUMN }] },
            },
          })),
        });
      }
      return null;
    },
    rawFetch: async () => null,
    getCommitSha: async () => null,
  };
}

/** Which tier answered, by its marker column. */
async function answeringTier(
  catalog: SchemaCatalog,
  table: string,
): Promise<string | null> {
  const resolved = await catalog.resolveSchema(table);
  if (resolved === null) return null;
  return resolved.map((column) => column.name).join(",");
}

describe("createSchemaLadder - precedence", () => {
  it("puts LIVE ARM columns ABOVE the KQL-validation tier (DBT-50)", async () => {
    // The defect this replaces: the live tier was the innermost fallback, so a
    // table the repo defines - which is most of them - never reached it. The
    // ARM read still fired and was still awaited; only its answer was dropped.
    const ladder = createSchemaLadder({
      content: contentWith({
        kqlTables: ["KnownTable"],
        solutionTables: ["KnownTable"],
      }),
      solutionName: SOLUTION,
      base,
      live: { KnownTable: [LIVE_COLUMN] },
    });
    expect(await answeringTier(ladder, "KnownTable")).toBe("FromLiveArm");
  });

  it("puts LIVE ARM columns above the solution's connector-ARM tier", async () => {
    // Same order, reached without the KQL tier in play - so a KQL-tier change
    // cannot be what keeps this passing.
    const ladder = createSchemaLadder({
      content: contentWith({ solutionTables: ["KnownTable"] }),
      solutionName: SOLUTION,
      base,
      live: { KnownTable: [LIVE_COLUMN] },
    });
    expect(await answeringTier(ladder, "KnownTable")).toBe("FromLiveArm");
  });

  it("keeps the KQL-validation tier above the solution's connector tables", async () => {
    // The 2026-07-14 direction, unchanged: for a table nobody picked, the
    // schema the solution's own CI validates its KQL against still wins.
    const ladder = createSchemaLadder({
      content: contentWith({
        kqlTables: ["KnownTable"],
        solutionTables: ["KnownTable"],
      }),
      solutionName: SOLUTION,
      base,
      live: {},
    });
    expect(await answeringTier(ladder, "KnownTable")).toBe("FromKqlValidation");
  });

  it("keeps the solution's connector tables above the base catalog", async () => {
    const ladder = createSchemaLadder({
      content: contentWith({ solutionTables: ["KnownTable"] }),
      solutionName: SOLUTION,
      base,
      live: {},
    });
    expect(await answeringTier(ladder, "KnownTable")).toBe("FromSolutionArm");
  });

  it("falls through to the base catalog when no tier above defines the table", async () => {
    const ladder = createSchemaLadder({
      content: contentWith({}),
      solutionName: SOLUTION,
      base,
      live: {},
    });
    expect(await answeringTier(ladder, "KnownTable")).toBe("FromBundledBase");
    expect(await answeringTier(ladder, "UnknownTable")).toBeNull();
  });
});

describe("createSchemaLadder - the promotion stays scoped", () => {
  it("leaves a table NOBODY picked on the repo tiers", async () => {
    // Pointing one log type at a real table says nothing about the others, so
    // promoting the live tier must not disturb any table absent from the map.
    const ladder = createSchemaLadder({
      content: contentWith({
        kqlTables: ["KnownOther"],
        solutionTables: ["KnownOther"],
      }),
      solutionName: SOLUTION,
      base,
      live: { KnownPicked: [LIVE_COLUMN] },
    });
    expect(await answeringTier(ladder, "KnownOther")).toBe("FromKqlValidation");
    expect(await answeringTier(ladder, "KnownPicked")).toBe("FromLiveArm");
  });

  it("behaves as the three lower tiers when no table has been picked", async () => {
    // Absent and empty are the same statement - no operator pick yet - and the
    // ladder must not branch on which one it was handed.
    const content = contentWith({ kqlTables: ["KnownTable"] });
    const absent = createSchemaLadder({ content, solutionName: SOLUTION, base });
    const empty = createSchemaLadder({
      content,
      solutionName: SOLUTION,
      base,
      live: {},
    });
    expect(await answeringTier(absent, "KnownTable")).toBe("FromKqlValidation");
    expect(await answeringTier(empty, "KnownTable")).toBe("FromKqlValidation");
  });

  it("honours an EMPTY live column set as an override, not a miss", async () => {
    // A provisioned-but-unmaterialized table really has no columns. The tier
    // pins this in isolation; here it has to survive the promotion, because a
    // repo tier below it would otherwise answer with a schema that is not the
    // one the operator is being told is in use.
    const ladder = createSchemaLadder({
      content: contentWith({
        kqlTables: ["KnownTable"],
        solutionTables: ["KnownTable"],
      }),
      solutionName: SOLUTION,
      base,
      live: { KnownTable: [] },
    });
    expect(await ladder.resolveSchema("KnownTable")).toEqual([]);
  });
});

/**
 * THE COLUMN CONTRACT ACROSS THE PROMOTION (DBT-50, second defect).
 *
 * Promoting a tier is only safe if it answers the SAME question as the tiers it
 * jumped over. These pin that it does. The live tier is fed raw ARM, which
 * reports a native table's Azure-managed columns in `standardColumns`, and it
 * did not strip them - so the first fix for DBT-50 was a live correctness
 * REGRESSION: every DCR generated for a picked table gained up to 18 columns
 * Azure populates itself, and the three tiers below guarantee absent.
 *
 * The pin is on the composed ladder rather than only on the tier, because that
 * is where the promotion made the omission reachable: nested innermost, the
 * repo tiers answered first and the unstripped columns were never returned.
 */
describe("createSchemaLadder - the promoted tier honours the column contract", () => {
  /** One real column per type, so a stripped result is still a useful schema. */
  const REAL_COLUMNS: DcrSchemaColumn[] = [
    { name: "TimeGenerated", type: "datetime" },
    { name: "Computer", type: "string" },
    { name: "EventID", type: "int" },
  ];

  /** What ARM hands back for a table carrying every managed column. */
  const LIVE_ARM_COLUMNS: DcrSchemaColumn[] = [
    ...REAL_COLUMNS,
    ...DCR_SCHEMA_SYSTEM_COLUMNS.map((name) => ({ name, type: "string" })),
  ];

  function ladderWithLiveArm(): SchemaCatalog {
    return createSchemaLadder({
      content: contentWith({
        kqlTables: ["KnownTable"],
        solutionTables: ["KnownTable"],
      }),
      solutionName: SOLUTION,
      base,
      live: { KnownTable: LIVE_ARM_COLUMNS },
    });
  }

  it("strips every Azure-managed column the live ARM read carried", async () => {
    // The measurement the fix is about: 21 columns in, 3 out, and the 18
    // dropped are exactly the managed set - not a count that happens to match.
    expect(LIVE_ARM_COLUMNS.length).toBe(21);
    const resolved = await ladderWithLiveArm().resolveSchema("KnownTable");
    expect(resolved).not.toBeNull();
    expect(resolved!.length).toBe(3);
    const names = new Set(resolved!.map((c) => c.name));
    for (const system of DCR_SCHEMA_SYSTEM_COLUMNS) {
      expect(names.has(system)).toBe(false);
    }
  });

  it("keeps TimeGenerated, which is a REAL column and not a managed one", async () => {
    // The strip is a named list, not "anything that looks Azure-ish". Losing
    // TimeGenerated would be the same class of defect in the other direction.
    const resolved = await ladderWithLiveArm().resolveSchema("KnownTable");
    expect(resolved!.map((c) => c.name)).toEqual([
      "TimeGenerated",
      "Computer",
      "EventID",
    ]);
  });

  it("leaves NO tier of the ladder emitting a managed column", async () => {
    // Whichever tier answers, the answer obeys one contract. Each table below
    // is defined by a different tier and every one of them carries the managed
    // names in its source document.
    const systemProps = DCR_SCHEMA_SYSTEM_COLUMNS.map((name) => ({
      Name: name,
      Type: "String",
    }));
    const systemArmColumns = DCR_SCHEMA_SYSTEM_COLUMNS.map((name) => ({
      name,
      type: "string",
    }));
    const content: SentinelContent = {
      ...contentWith({}),
      listConnectorFiles: async () => [
        { name: "Contoso_Tables.json", path: CONNECTOR_FILE, size: 1 },
      ],
      readFile: async (path) => {
        if (path === `${KQL_VALIDATION_TABLES_DIR}/KqlTable.json`) {
          return JSON.stringify({
            Name: "KqlTable",
            Properties: [{ Name: KQL_COLUMN.name, Type: "String" }, ...systemProps],
          });
        }
        if (path === CONNECTOR_FILE) {
          return JSON.stringify({
            resources: [
              {
                type: "Microsoft.OperationalInsights/workspaces/tables",
                properties: {
                  schema: {
                    name: "SolutionTable",
                    columns: [{ ...SOLUTION_COLUMN }, ...systemArmColumns],
                  },
                },
              },
            ],
          });
        }
        return null;
      },
    };
    const ladder = createSchemaLadder({
      content,
      solutionName: SOLUTION,
      base,
      live: { LiveTable: LIVE_ARM_COLUMNS },
    });
    const managed = new Set(DCR_SCHEMA_SYSTEM_COLUMNS);
    for (const [table, expectedMarker] of [
      ["LiveTable", "TimeGenerated"],
      ["KqlTable", KQL_COLUMN.name],
      ["SolutionTable", SOLUTION_COLUMN.name],
    ] as const) {
      const resolved = await ladder.resolveSchema(table);
      expect(resolved, `${table} resolved nowhere`).not.toBeNull();
      // Assert the intended tier answered, so a pin cannot pass by resolving
      // to some other tier that happens to be clean.
      expect(resolved!.map((c) => c.name)).toContain(expectedMarker);
      for (const column of resolved!) {
        expect(managed.has(column.name), `${table} emitted ${column.name}`).toBe(
          false,
        );
      }
    }
  });

  it("reduces an all-managed live table to the empty override, not a fallthrough", async () => {
    // A table whose every column is Azure-managed has nothing a DCR may
    // declare. That is the empty-override state the tier already defines - it
    // must NOT become a miss that lets a repo tier answer instead, which would
    // be the quiet substitution this tier exists to prevent.
    const ladder = createSchemaLadder({
      content: contentWith({
        kqlTables: ["KnownTable"],
        solutionTables: ["KnownTable"],
      }),
      solutionName: SOLUTION,
      base,
      live: {
        KnownTable: DCR_SCHEMA_SYSTEM_COLUMNS.map((name) => ({
          name,
          type: "string",
        })),
      },
    });
    expect(await ladder.resolveSchema("KnownTable")).toEqual([]);
  });
});
