/**
 * Guard the ONE remaining way to spell the empty-as-zero bug (DBT-61).
 *
 * The `Listing` type moved this whole defect class into the compiler: an ARM
 * lister returns rows-or-empty, so `${listing.length}` does not typecheck and
 * the empty case is a branch someone has to write on purpose. What the type
 * deliberately cannot stop is the escape hatch - `listingRows()` hands back a
 * plain array, and `listingRows(x).length` in a message is the original defect
 * spelled the long way.
 *
 * WHY A GREP WORKS HERE AND NOT BEFORE. The earlier attempt at a text checker
 * failed and was recorded as a negative result on DBT-61: the zero-claim is
 * COMPUTED, never literal, so there was no wrong sentence to match. That is
 * still true of the general case. It is NOT true of this one, because the
 * escape hatch has a single greppable name that nothing else uses. The type
 * makes the mistake hard; this makes the one remaining spelling loud.
 *
 * Deliberately narrow. It does not try to judge whether an unwrap is justified
 * - that judgement lives in the comment at each call site, and a checker that
 * guessed at it would either nag or lull. It matches counting.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "../../..");

const SEARCH_DIRS = ["packages/core/src", "packages/ui/src", "apps/cribl-app/src"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".vite"]);

/**
 * Counting an unwrapped listing. `listingRows(x).length`, and the same thing
 * reached through a variable is NOT matched - that is the limit of a text
 * checker and pretending otherwise would be the same overclaim this repo keeps
 * filing bugs about. The direct spelling is the one that reads as innocent.
 */
const COUNTING_THE_UNWRAP = /listingRows\s*\([^)]*\)\s*\.\s*length\b/;

/** Its own doc comments talk about the pattern; they are prose, not code. */
export function stripCommentsAndStrings(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*");
    })
    .join("\n");
}

export function findViolations(source, file) {
  const code = stripCommentsAndStrings(source);
  const out = [];
  code.split("\n").forEach((line, i) => {
    if (COUNTING_THE_UNWRAP.test(line)) {
      out.push({ file, line: i + 1, text: line.trim() });
    }
  });
  return out;
}

function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, acc);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

export function scanRepo(root = ROOT) {
  const findings = [];
  for (const dir of SEARCH_DIRS) {
    for (const file of walk(join(root, dir))) {
      const rel = relative(root, file).replace(/\\/g, "/");
      findings.push(...findViolations(readFileSync(file, "utf8"), rel));
    }
  }
  return findings;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const findings = scanRepo();
  if (findings.length === 0) {
    console.log("check-listings: no listing is counted through the escape hatch");
    process.exit(0);
  }
  console.error("check-listings: an unwrapped listing is being COUNTED.\n");
  console.error(
    "  `listingRows(x).length` is the empty-as-zero bug spelled the long way:\n" +
      "  an RBAC-filtered ARM list returns 200 with nothing, so that number is a\n" +
      "  0 that was never measured. Narrow on `x.kind` and say what empty means,\n" +
      "  or hand the listing to `listingCount(x, whenEmpty)` and write the\n" +
      "  assumption down. See docs/inventory-standard.md.\n",
  );
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.text}`);
  }
  process.exit(1);
}
