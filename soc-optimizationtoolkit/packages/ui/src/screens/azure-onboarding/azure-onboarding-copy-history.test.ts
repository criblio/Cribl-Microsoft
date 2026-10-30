/**
 * No project history in what an operator reads on Azure Native Source
 * Onboarding: no card ids, no dates, no plan units (standards/info-affordances.md,
 * the same gate as integrate-copy-history.test.ts).
 *
 * It reads SOURCE, because most of this copy appears only after an Azure read
 * or a deploy. Broader than the Integrate gate on purpose: after comments are
 * stripped it takes EVERY string literal and template body in the screen
 * files listed below, plus every JSX text run - this screen's tips and messages are
 * mostly named constants and template strings, and a collector that read only
 * `text=` attributes would see almost none of them. Class names and ARM paths
 * come along too; neither has the shape of an id, a date or a phase.
 *
 * The strings azure-onboarding-state.ts returns, and core's availability
 * reasons, are gated by azure-onboarding-state.test.ts.
 *
 * The collector is local rather than imported from the Integrate gate:
 * importing a test module would register its suites in this file.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { describeViolations, findHistoryInCopy } from "../../components/copy-rules";
import type { CopyEntry } from "../../components/copy-rules";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The modules the screen renders, relative to this directory. */
export const AZURE_ONBOARDING_COPY_FILES = [
  "azure-onboarding-screen.tsx",
  "eventhub-prerequisite-section.tsx",
  "defender-export-section.tsx",
  // The How-to, Validate, Cribl source and dataflow sections the screen composes.
  "howto/howto-panel.tsx",
  "howto/source-chooser.tsx",
  "howto/plan-values-form.tsx",
  "howto/step-list.tsx",
  "howto/step-dialog.tsx",
  "validate/validate-panel.tsx",
  "cribl-source/cribl-source-panel.tsx",
  "dataflow/onboarding-dataflow.tsx",
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

describe("Azure Native Source Onboarding copy carries no project history", () => {
  it("collects a real amount of copy, so the gate cannot pass by reading nothing", () => {
    const all = AZURE_ONBOARDING_COPY_FILES.flatMap(collect);
    // Measured when the gate landed (well over 100 literals and 10 JSX runs);
    // a collapse means the collector broke, not that the copy got cleaner.
    expect(all.length).toBeGreaterThanOrEqual(100);
    expect(all.filter((e) => e.where.endsWith("(jsx)")).length).toBeGreaterThanOrEqual(10);
    // The section tips and the shell-gap message are among what it reads.
    const texts = all.map((e) => e.text);
    expect(texts.some((t) => t.startsWith("Every source on this page sends to an Event Hub"))).toBe(true);
    expect(texts.some((t) => t.startsWith("This build of the app has no storage"))).toBe(true);
    // The four sections the How-to path adds, and their (i) text, are read too.
    for (const title of ["Dataflow", "How to set it up yourself", "Check the Azure configuration", "Cribl Stream source"]) {
      expect(texts).toContain(title);
    }
    expect(texts.some((t) => t.startsWith("For each source you would rather set up in Azure yourself"))).toBe(true);
    expect(texts.some((t) => t.startsWith("Reads the Azure side of every chosen source"))).toBe(true);
    expect(texts.some((t) => t.startsWith("The app creates the Cribl source for each lane"))).toBe(true);
  });

  it("the rule finds history when it is there (the gate can fail)", () => {
    const planted: CopyEntry[] = [{ where: "planted", text: "Arrives with AZR-18, measured 2026-10-21" }];
    expect(findHistoryInCopy(planted).length).toBe(2);
  });

  it.each(AZURE_ONBOARDING_COPY_FILES)("%s", (file) => {
    const violations = findHistoryInCopy(collect(file));
    expect(violations, describeViolations(violations)).toEqual([]);
  });
});
