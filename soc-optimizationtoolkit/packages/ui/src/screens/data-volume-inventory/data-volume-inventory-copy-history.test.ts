/**
 * No project history in what an operator reads on the Data Volume Inventory:
 * no card ids, no dates, no plan units (standards/info-affordances.md, the
 * same gate as azure-onboarding-copy-history.test.ts).
 *
 * It reads SOURCE, because almost all of this copy appears only after an
 * Azure read: after comments are stripped it takes every string literal and
 * template body in the screen files listed below, plus every JSX text run.
 * KQL and ARM paths come along too; neither has the shape of an id, a date or
 * a phase. Test files and the test fixture are not screen copy and are left out.
 *
 * The collector is local rather than imported from another gate: importing a
 * test module would register its suites in this file.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { describeViolations, findHistoryInCopy } from "../../components/copy-rules";
import type { CopyEntry } from "../../components/copy-rules";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The modules the screen renders, relative to this directory. */
export const DATA_VOLUME_INVENTORY_COPY_FILES = [
  "workspace-inventory-panel.tsx",
  "workspace-inventory-state.ts",
  "window-summary-strip.tsx",
  "allowance-cards.tsx",
  "allowance-state.ts",
  "allowance-chart.tsx",
  "by-source-view.tsx",
  "format-mb.ts",
];

/** Comments out, line breaks kept, so a failure names the real line. */
function stripComments(source: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, "");
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^\s*\/\/.*$/gm, "");
}

/** A double-quoted or template literal; group 2 is its body. */
const LITERAL = /(["`])((?:(?!\1)[^\\]|\\.)*)\1/g;

/** Every string literal and JSX text run, with a file:line for each. */
function collect(file: string): CopyEntry[] {
  const source = stripComments(readFileSync(join(HERE, file), "utf8"));
  const lineOf = (index: number) => source.slice(0, index).split("\n").length;
  const out: CopyEntry[] = [];
  for (const m of source.matchAll(LITERAL)) {
    const text = m[2] ?? "";
    if (text.trim() !== "") out.push({ where: `${file}:${lineOf(m.index ?? 0)}`, text });
  }
  for (const m of source.matchAll(/>([^<>{}]+)</g)) {
    const text = (m[1] ?? "").replace(/\s+/g, " ").trim();
    if (!/[A-Za-z]{2,} [A-Za-z]/.test(text) || /=>|;|\bconst\b/.test(text)) continue;
    out.push({ where: `${file}:${lineOf(m.index ?? 0)} (jsx)`, text });
  }
  return out;
}

describe("Data Volume Inventory copy carries no project history", () => {
  it("collects a real amount of copy, so the gate cannot pass by reading nothing", () => {
    const all = DATA_VOLUME_INVENTORY_COPY_FILES.flatMap(collect);
    // Measured when the gate landed (several hundred literals, dozens of JSX
    // runs); a collapse means the collector broke, not that the copy got cleaner.
    expect(all.length).toBeGreaterThanOrEqual(200);
    expect(all.filter((e) => e.where.endsWith("(jsx)")).length).toBeGreaterThanOrEqual(10);
    const texts = all.map((e) => e.text);
    // The window totals strip's tips and the card's window line are among what it reads.
    expect(texts.some((t) => t.startsWith("Billable over the window minus the allowance over the window"))).toBe(true);
    expect(texts.some((t) => t.startsWith("Each grant's daily figure from licence counts"))).toBe(true);
    expect(texts.some((t) => t.startsWith("Defender for Servers P2 machines not known - "))).toBe(true);
  });

  it("the rule finds history when it is there (the gate can fail)", () => {
    const planted: CopyEntry[] = [{ where: "planted", text: "Totals arrive with MIG-33, measured 2026-11-11" }];
    expect(findHistoryInCopy(planted).length).toBe(2);
  });

  it.each(DATA_VOLUME_INVENTORY_COPY_FILES)("%s", (file) => {
    const violations = findHistoryInCopy(collect(file));
    expect(violations, describeViolations(violations)).toEqual([]);
  });
});
