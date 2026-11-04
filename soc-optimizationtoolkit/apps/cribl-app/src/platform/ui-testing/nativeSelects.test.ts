/**
 * DBT-249: every dropdown is the filterable SearchableSelect, never a native <select>.
 *
 * Standard: claude-kit standards/capra-ui.md - "Dropdowns have a filter box". The matcher
 * (nativeSelects.ts) is the kit's reference copy, recorded in .claude-kit.json. This test is the
 * app's own version of the kit's copy-me template (not a copy, so it is not synced): it scans BOTH
 * source roots that render UI - packages/ui/src and this app's src - where the template scans one.
 *
 * Why it exists: the rule used to live only in searchable-select.tsx's header comment, and by
 * 2026-11 there were 36 native selects in 22 files. ALLOW stays empty unless a file truly cannot use
 * the combobox, with the reason beside its entry.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findNativeSelects, formatNativeSelects, type SourceFile } from "./nativeSelects";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLKIT = join(HERE, "..", "..", "..", "..", "..");
const ROOTS = [join(TOOLKIT, "packages", "ui", "src"), join(TOOLKIT, "apps", "cribl-app", "src")];

const ALLOW: string[] = [
  // 'packages/ui/src/path/to/file.tsx', // why it cannot use the combobox
];

function walk(dir: string, out: SourceFile[] = []): SourceFile[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) {
      out.push({ path: relative(TOOLKIT, full).replace(/\\/g, "/"), text: readFileSync(full, "utf8") });
    }
  }
  return out;
}

const FILES = ROOTS.flatMap((r) => walk(r));

describe("dropdowns have a filter box (DBT-249)", () => {
  it("reads real source files from both roots", () => {
    // If a walk stopped finding anything, the check below would pass by scanning nothing.
    expect(FILES.filter((f) => f.path.startsWith("packages/ui/src/")).length).toBeGreaterThan(50);
    expect(FILES.some((f) => f.path === "apps/cribl-app/src/App.tsx")).toBe(true);
    expect(FILES.some((f) => f.path === "packages/ui/src/components/searchable-select.tsx")).toBe(true);
  });

  it("no component renders a native <select>", () => {
    const uses = findNativeSelects(FILES, ALLOW);
    expect(uses, formatNativeSelects(uses)).toEqual([]);
  });
});
