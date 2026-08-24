/**
 * THE REMEDY DEPENDS ON WHO OWNS THE TABLE - pinned (2026-08-18 audit).
 *
 * The warning that fires when overflow fields exist but the catch-all column
 * does not is the only thing an operator is told about silent data loss, and it
 * shipped with two branches of advice and no pin on either. It went out once
 * saying "add a column to the table" for CrowdStrikeAlerts - a Microsoft-managed
 * table nobody can add a column to - for 161 dropped fields.
 *
 * The unnamed-table case is pinned too, because it is the one the branch got
 * wrong: isCustomTableName("") is false, so "no name" read as "native" and the
 * warning made an ownership claim about a table it could not identify.
 */

import { describe, expect, it } from "vitest";
import { matchFields } from "./match-fields";
import type { DestField, SourceField } from "./models";

/** A schema with NO catch-all column - the state the warning is about. */
const NO_CATCH_ALL: DestField[] = [
  { name: "TimeGenerated", type: "datetime" },
  { name: "AlertId", type: "string" },
];

function warn(table: string | undefined): string {
  const source: SourceField[] = [
    { name: "zzzUnrelatedOne", type: "string" },
    { name: "zzzUnrelatedTwo", type: "string" },
  ];
  const result = matchFields(source, NO_CATCH_ALL, undefined, table);
  return result.warnings.join(" ");
}

describe("overflow remedy - custom tables can be extended", () => {
  it("tells the operator to add the catch-all column", () => {
    const text = warn("MyApp_CL");
    expect(text).toContain("cannot be preserved");
    expect(text).toMatch(/Add a \w+ \(\w+\) column to the table/);
  });

  it("does not call a _CL table native", () => {
    expect(warn("MyApp_CL")).not.toContain("native table");
  });

  it("reads the suffix case-insensitively, as the onboarding path does", () => {
    // isCustomTableName is deliberately case-insensitive; the advice must not
    // disagree with the code that would actually create the table.
    expect(warn("myapp_cl")).not.toContain("native table");
  });
});

describe("overflow remedy - native tables cannot", () => {
  it("says so, and names the table", () => {
    const text = warn("CrowdStrikeAlerts");
    expect(text).toContain("CrowdStrikeAlerts is a native table");
  });

  it("never issues the impossible instruction", () => {
    // THE REGRESSION, verbatim: this is what shipped for 161 dropped fields.
    expect(warn("CrowdStrikeAlerts")).not.toContain("column to the table");
  });

  it("offers the three things that ARE possible instead", () => {
    const text = warn("CrowdStrikeAlerts");
    expect(text).toContain("existing columns");
    expect(text).toContain("accept the loss");
    expect(text).toContain("custom _CL table");
  });
});

describe("overflow remedy - an unnamed table claims nothing", () => {
  it("does not call an unnamed destination native", () => {
    // isCustomTableName("") is false, so the two-branch version asserted
    // "destination is a native table" about a table it could not identify.
    expect(warn(undefined)).not.toContain("native table");
  });

  it("does not tell them to add a column either", () => {
    // The other half of the same point: with no name there is no owner, so
    // neither ownership-dependent remedy is honest.
    expect(warn(undefined)).not.toMatch(/Add a \w+ \(\w+\) column/);
  });

  it("still reports the loss, and still says what to do", () => {
    // Saying nothing would be worse than the wrong advice it replaced.
    const text = warn(undefined);
    expect(text).toContain("cannot be preserved");
    expect(text).toContain("existing columns");
  });

  it("treats a blank name the same as an absent one", () => {
    expect(warn("   ")).not.toContain("native table");
  });
});
