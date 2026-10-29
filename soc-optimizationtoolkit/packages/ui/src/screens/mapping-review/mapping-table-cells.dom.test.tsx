// @vitest-environment happy-dom
/**
 * DBT-192: the mapping tables' cells stay table cells.
 *
 * styles.css gave .match-field-type `display: block`, and that class sits on
 * <td>s. A block <td> drops out of the table layout and consecutive ones merge
 * into one anonymous cell, so an unmapped row (three type cells in a row) put
 * the column name under Type and its type under Dest Field. Counting DOM cells
 * cannot see that - the DOM still had seven <td>s.
 *
 * happy-dom does no layout and does not apply the stylesheet, so this reads
 * styles.css (comments stripped, the way raw-body-wrap.dom.test.tsx does) and
 * asks, for every <td> the REAL components render in the Field Mappings and
 * Mapping Catalog tables, whether any rule that matches it (Element.matches)
 * declares a display other than table-cell. Row and cell classes carry
 * variants (mapping-row-<action>, mapping-example-value-<kind>), so every
 * variant is rendered, not only the ones a default sample produces.
 *
 * Scope: styles.css only. The Cribl shell also loads its own App.css (shell
 * chrome, no table rules today); @soc/ui does not read the shell's files.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { FIELD_EXAMPLE_MAX_CHARS, parseSampleContent } from "@soc/core";
import type { GapReport, SchemaCatalog, TaggedSample } from "@soc/core";
import { MappingReviewSection } from "./mapping-review-section";
import { MappingCatalogScreen } from "../mapping-catalog/mapping-catalog-screen";

afterEach(cleanup);

const css = readFileSync(resolve(__dirname, "../../styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

interface DisplayRule {
  selector: string;
  display: string;
}

/**
 * Every selector that declares display, from plain rules at any depth (the
 * innermost-braces match also reaches rules inside @media). State
 * pseudo-classes are stripped so a :hover rule still counts against the
 * cell; pseudo-element rules style generated boxes, not the cell, and are
 * left out. When a block declares display more than once, the one the
 * browser applies is read: the last !important one, else the last one.
 */
function displayRules(text: string): DisplayRule[] {
  const out: DisplayRule[] = [];
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = [...m[2].matchAll(/(?:^|;)\s*display\s*:\s*([^;]+)/g)].map((d) => d[1].trim());
    if (decls.length === 0) continue;
    const important = decls.filter((d) => /!important$/.test(d));
    const applied = (important.length > 0 ? important : decls).at(-1)!.replace(/\s*!important$/, "");
    for (const raw of m[1].split(",").map((s) => s.trim())) {
      if (raw === "" || raw.includes("::")) continue;
      const selector = raw.replace(/:(hover|focus-visible|focus-within|focus|active|visited)\b/g, "");
      out.push({ selector, display: applied });
    }
  }
  return out;
}

/**
 * The rules that match a cell and set display to anything but table-cell,
 * as "selector -> value" lines. A selector happy-dom cannot parse is
 * reported as such rather than skipped, so it cannot hide a match.
 */
function offenders(cells: HTMLTableCellElement[], rules: DisplayRule[]): string[] {
  const out = new Set<string>();
  for (const td of cells) {
    for (const rule of rules) {
      let hit: boolean;
      try {
        hit = td.matches(rule.selector);
      } catch {
        if (/\btd\b/.test(rule.selector) || [...td.classList].some((c) => rule.selector.includes(`.${c}`))) {
          out.add(`${rule.selector} -> unparseable`);
        }
        continue;
      }
      if (hit && rule.display !== "table-cell") out.add(`${rule.selector} -> ${rule.display}`);
    }
  }
  return [...out].sort();
}

const RULES = displayRules(css);

// ---------------------------------------------------------------------------
// Field Mappings: mapped rows and an unmapped-destination row
// ---------------------------------------------------------------------------

const BASE_SCHEMA = [
  { name: "TimeGenerated", type: "datetime" },
  { name: "SrcUserName", type: "string" },
  { name: "NeverSent", type: "string" },
];

const BASE_EVENT: Record<string, string> = { SrcUserName: "abby", TimeGenerated: "2026-08-31T12:00:00Z" };

function sample(event: Record<string, string>): TaggedSample {
  const content = JSON.stringify(event);
  return {
    logType: "AUDIT",
    format: "json",
    rawEvents: [content],
    parsed: parseSampleContent(content, { sourceName: "audit.json" }),
  };
}

async function renderFieldMappings(
  schema: { name: string; type: string }[] = BASE_SCHEMA,
  event: Record<string, string> = BASE_EVENT,
): Promise<HTMLElement> {
  const catalog: SchemaCatalog = { resolveSchema: async () => schema };
  let latest: GapReport[] = [];
  const { container } = render(
    <MappingReviewSection
      solutionName=""
      samples={[sample(event)]}
      catalog={catalog}
      onReportsChange={(next) => {
        latest = next;
      }}
    />,
  );
  const button = [...container.querySelectorAll("button")].find((b) => /analyze/i.test(b.textContent ?? ""));
  if (button === undefined) throw new Error("Analyze button not rendered");
  fireEvent.click(button);
  await waitFor(() => expect(latest.length).toBe(1));
  await waitFor(() => expect(container.querySelector(".mapping-review-grid tr.mapping-row-unmapped")).not.toBeNull());
  return container;
}

function bodyCells(container: HTMLElement): HTMLTableCellElement[] {
  return [...container.querySelectorAll<HTMLTableCellElement>(".mapping-review-grid tbody td")];
}

describe("DBT-192 - the stylesheet check itself", () => {
  it("flags a display:block rule on a td class, and passes table-cell and other elements", () => {
    const row = document.createElement("tr");
    row.innerHTML = '<td class="match-field-type">x</td><td>y</td>';
    const cells = [...row.cells];
    const rules = displayRules(
      ".match-field-type { display: block; } .x td:hover { display: flex } td.ok { display: table-cell } span.match-field-type { display: block } .y::after { display: block }",
    );
    expect(rules.map((r) => `${r.selector}=${r.display}`)).toEqual([
      ".match-field-type=block",
      ".x td=flex",
      "td.ok=table-cell",
      "span.match-field-type=block",
    ]);
    expect(offenders(cells, rules)).toEqual([".match-field-type -> block"]);
  });

  it("reads the display a block applies, not the first one it declares", () => {
    const rules = displayRules(
      ".a td { display: table-cell; display: block } .b td { display: block !important; display: table-cell }",
    );
    expect(rules.map((r) => `${r.selector}=${r.display}`)).toEqual([".a td=block", ".b td=block"]);
  });

  it("reads display declarations out of the real stylesheet", () => {
    // A parser that found nothing would make every check below pass.
    expect(RULES.find((r) => r.selector === ".match-kind")?.display).toBe("inline-block");
  });
});

describe("DBT-192 - no rule takes a mapping-table cell out of the table", () => {
  it("Field Mappings: every body cell, mapped and unmapped rows alike", async () => {
    const container = await renderFieldMappings();
    const cells = bodyCells(container);
    // Two mapped rows of seven, the unmapped header, one unmapped row of seven.
    expect(cells.length).toBe(22);
    const typed = cells.filter((td) => td.classList.contains("match-field-type"));
    // Two per mapped row (source and dest type), five on the unmapped row.
    expect(typed.length).toBe(9);
    expect(offenders(cells, RULES)).toEqual([]);
  });

  it("Field Mappings: an unmapped row's column name and type land in the Dest Field and dest Type columns", async () => {
    const container = await renderFieldMappings();
    const row = container.querySelector<HTMLTableRowElement>("tr.mapping-row-unmapped")!;
    expect([...row.cells].map((td) => td.textContent)).toEqual([
      "--",
      "--",
      "--",
      "NeverSent",
      "string",
      "none",
      "no source",
    ]);
    // Seven DOM cells only line up if all seven stay table cells.
    expect(offenders([...row.cells], RULES)).toEqual([]);
  });

  it("Field Mappings: every row action and every Example Value kind", async () => {
    // Cell and row classes carry variants (mapping-row-<action>,
    // mapping-example-value-<kind>); a display rule on one variant only
    // breaks the rows that have it, so each variant is rendered here.
    const container = await renderFieldMappings(
      [...BASE_SCHEMA, { name: "Blank", type: "string" }, { name: "Long", type: "string" }],
      { ...BASE_EVENT, Blank: "", Long: "x".repeat(FIELD_EXAMPLE_MAX_CHARS) },
    );
    const kinds = [...container.querySelectorAll(".mapping-review-grid td.mapping-example-value")].map(
      (td) => [...td.classList].find((c) => c.startsWith("mapping-example-value-"))!,
    );
    expect([...new Set(kinds)].sort()).toEqual([
      "mapping-example-value-empty",
      "mapping-example-value-none",
      "mapping-example-value-value",
    ]);
    expect(offenders(bodyCells(container), RULES)).toEqual([]);

    const row = () => container.querySelector<HTMLTableRowElement>('tr[data-source="SrcUserName"]')!;
    const seen: string[] = [];
    for (const action of ["keep", "rename", "coerce", "decode", "overflow", "drop"]) {
      fireEvent.change(row().cells[6].querySelector("select")!, { target: { value: action } });
      await waitFor(() => expect(row().className).toBe(`mapping-row mapping-row-${action}`));
      seen.push(...offenders(bodyCells(container), RULES).map((o) => `${action}: ${o}`));
    }
    expect(seen).toEqual([]);
  });

  it("Mapping Catalog: every body cell of a vendor's table", () => {
    const { container } = render(<MappingCatalogScreen />);
    const control = container.querySelector(".searchable-select-control");
    if (control === null) throw new Error("vendor picker not rendered");
    fireEvent.click(control);
    const first = container.querySelector(".searchable-select-option");
    if (first === null) throw new Error("no vendor options rendered");
    fireEvent.click(first);
    const cells = bodyCells(container);
    const rows = container.querySelectorAll(".mapping-review-grid tbody tr").length;
    expect(rows).toBeGreaterThan(0);
    expect(cells.length).toBe(rows * 4);
    expect(cells.filter((td) => td.classList.contains("match-field-type")).length).toBe(rows);
    expect(offenders(cells, RULES)).toEqual([]);
  });
});
