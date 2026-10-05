/**
 * DBT-125: no project history in what an operator reads on Sentinel
 * Integration - no card ids, no measurement dates, no plan units. The
 * pack-wiring hint carried "verified 2026-09-04" until this gate existed;
 * those belong in code comments, where this repo already keeps them.
 *
 * It reads SOURCE, not a rendered page, because most of this copy only
 * appears after an action (an analysis, a capture, a deploy) that a unit test
 * cannot reach. Two kinds of string are collected from every module the page
 * renders: every InfoTip text literal, and every JSX text run. Comments are
 * stripped first - that is where history is supposed to live.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { describeViolations, findHistoryInCopy } from "../../components/copy-rules";
import type { CopyEntry } from "../../components/copy-rules";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The modules Sentinel Integration renders, relative to packages/ui/src. */
export const INTEGRATE_COPY_FILES = [
  "screens/integrate/integrate-screen.tsx",
  "screens/solution-browser/solution-browser.tsx",
  "screens/samples/log-type-recommendation.tsx",
  "screens/samples/sample-source-picker.tsx",
  "screens/samples/sample-intake-section.tsx",
  "screens/samples/capture-panel.tsx",
  "screens/samples/lake-panel.tsx",
  "screens/samples/csv-header-dialog.tsx",
  "screens/samples/csv-column-mapper.tsx",
  "screens/mapping-review/mapping-review-section.tsx",
  "screens/mapping-review/identity-block.tsx",
  "screens/mapping-review/overflow-triage-block.tsx",
  "screens/pipeline-preview/pipeline-preview-section.tsx",
  "screens/rule-coverage/rule-coverage-section.tsx",
  "screens/content-install/content-install-section.tsx",
  "screens/azure-targeting/azure-targeting-screen.tsx",
  "screens/role-assignment/role-assignment-section.tsx",
  "onboarding/recent-runs.tsx",
  "components/numbered-section.tsx",
];

/** Comments out, line breaks kept, so a failure names the real line. */
function stripComments(source: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, "");
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^\s*\/\/.*$/gm, "");
}

/** InfoTip text literals and JSX text runs, with a file:line for each. */
export function collectCopy(file: string): CopyEntry[] {
  const source = stripComments(readFileSync(join(SRC, file), "utf8"));
  const lineOf = (index: number) => source.slice(0, index).split("\n").length;
  const out: CopyEntry[] = [];
  // A tip's text is often an EXPRESSION - a ternary per state, a template, a
  // concatenation - so read every string literal inside text={...}, matching
  // braces, rather than only text="..." (the first version missed the very
  // ternary this gate was written for).
  for (const m of source.matchAll(/text=/g)) {
    const at = (m.index ?? 0) + 5;
    let body: string;
    if (source[at] === "{") {
      let depth = 0;
      let i = at;
      for (; i < source.length; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}" && --depth === 0) break;
      }
      body = source.slice(at + 1, i);
    } else {
      body = source.slice(at, source.indexOf(source[at] ?? '"', at + 1) + 1);
    }
    for (const lit of body.matchAll(/(["`])((?:(?!\1)[^\\]|\\.)*)\1/g)) {
      out.push({ where: `${file}:${lineOf(m.index ?? 0)} (tip)`, text: lit[2] ?? "" });
    }
  }
  for (const m of source.matchAll(/>([^<>{}]+)</g)) {
    const text = (m[1] ?? "").replace(/\s+/g, " ").trim();
    // A JSX text run reads as words; a TS generic or an arrow body does not.
    if (!/[A-Za-z]{2,} [A-Za-z]/.test(text) || /=>|;|\bconst\b|\buseState\b/.test(text)) {
      continue;
    }
    out.push({ where: `${file}:${lineOf(m.index ?? 0)}`, text });
  }
  return out;
}

describe("Sentinel Integration copy carries no project history (DBT-125)", () => {
  it("collects a real amount of copy, so the gate cannot pass by reading nothing", () => {
    const tips = INTEGRATE_COPY_FILES.flatMap(collectCopy).filter((e) =>
      e.where.endsWith("(tip)"),
    );
    // Measured when the gate landed; a collapse to a handful means the
    // collector broke, not that the copy got cleaner.
    expect(tips.length).toBeGreaterThanOrEqual(40);
  });

  it.each(INTEGRATE_COPY_FILES)("%s", (file) => {
    const violations = findHistoryInCopy(collectCopy(file), { allowIds: ["ASIM"] });
    expect(violations, describeViolations(violations)).toEqual([]);
  });
});
