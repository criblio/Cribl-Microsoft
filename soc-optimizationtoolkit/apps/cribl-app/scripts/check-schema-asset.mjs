/**
 * Fail when the committed DCR template schema asset no longer matches its
 * inputs (DBT-67).
 *
 * THE DEFECT THIS EXISTS FOR IS THE SILENCE, not the drift. `extract-dcr-
 * template-schemas.mjs` generates `packages/core/src/assets/dcr-template-
 * schemas.json`, which core imports statically and which is one of the field
 * matcher's resolution tiers. On 2026-07-13 one of its two input directories
 * moved under `deprecated/` and the script's path was not updated, so it
 * crashed with ENOENT for seven weeks. Nobody noticed, because no test ran it
 * and no gate called it - the asset simply went stale, and stale meant it kept
 * declaring columns `guid` that the templates had since corrected to `string`
 * under ADR 0004.
 *
 * A generator whose output is committed needs a check that the two agree.
 * Otherwise the commit is a snapshot of whenever someone last remembered.
 *
 * WHY IT RE-RUNS THE GENERATOR rather than re-implementing the extraction: a
 * second copy of the parsing logic would drift from the first, which is the
 * failure this repo keeps filing cards about. The generator is the single
 * source; this only asks whether its output is what is checked in.
 *
 * LINE ENDINGS ARE NORMALISED BEFORE COMPARING, and that is not a nicety
 * (DBT-70). The first version compared raw bytes. The generator writes "\n";
 * with core.autocrlf=true git checks the committed asset out as "\r\n". So on
 * Windows every run reported a mismatch while listing ZERO differing tables -
 * the giveaway that the difference was not in the data. CI never saw it,
 * because the Linux runner checks out LF and both sides matched. That is
 * [[DBT-66]] exactly: a Windows-only break a green CI cannot see, shipped by
 * the very gate added to stop things going unnoticed.
 *
 * WHY THE LOGIC IS SPLIT FROM THE IO (DBT-69). This checker guards a gate, and
 * it was itself the only gate script with no test - so if it quietly stopped
 * detecting drift, the gate would read green while guarding nothing. That is
 * not hypothetical: DBT-70 above is exactly that failure, and a test on the
 * comparison would have caught it on the first Windows run. `compareAssets` is
 * pure over two strings and `checkSchemaAsset` takes its IO as arguments, so
 * both can be pinned without a repo, a generator subprocess or a filesystem.
 * See scripts/check-schema-asset.test.mjs.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "../../..");
const SCRIPT = join(ROOT, "packages", "core", "scripts", "extract-dcr-template-schemas.mjs");
const ASSET = join(ROOT, "packages", "core", "src", "assets", "dcr-template-schemas.json");

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

/** Compare CONTENT, not bytes - see the line-endings note in the header. */
const normalise = (text) => text.split(CR + LF).join(LF);

/** How many differing table names the failure message spells out before eliding. */
const NAMED_TABLE_LIMIT = 12;

export const GENERATOR_FAILED_MESSAGE =
  "check-schema-asset: the extractor FAILED TO RUN.\n\n" +
  "  This is exactly how the asset went stale for seven weeks (DBT-67):\n" +
  "  the generator crashed and nothing reported it. Fix the generator\n" +
  "  before trusting the committed asset.\n";

export const MATCHES_MESSAGE =
  "check-schema-asset: the committed asset matches a fresh extraction";

/**
 * Which tables actually differ, given both sides parse as the asset's shape.
 * A drift the parse cannot explain (whitespace, key order, a truncated write)
 * yields an EMPTY list next to a real mismatch - that combination is the
 * DBT-70 fingerprint, so it is reported rather than smoothed over.
 */
function differingTables(committed, regenerated) {
  const c = JSON.parse(committed);
  const r = JSON.parse(regenerated);
  const names = new Set([...Object.keys(c), ...Object.keys(r)]);
  return [...names].filter((n) => JSON.stringify(c[n]) !== JSON.stringify(r[n]));
}

/**
 * The whole comparison, pure over the two texts. Returns the message rather
 * than printing it so a test can assert what the failure actually SAYS - the
 * table names are the operator's only lead on what to regenerate.
 */
export function compareAssets({ committed, regenerated }) {
  if (normalise(regenerated) === normalise(committed)) {
    return { matches: true, changed: [], message: MATCHES_MESSAGE };
  }

  const changed = differingTables(committed, regenerated);
  const message =
    "check-schema-asset: the committed asset does NOT match a fresh extraction.\n\n" +
    "  The templates and the generated asset have diverged, which means the\n" +
    "  field matcher is resolving against a schema the templates no longer\n" +
    "  describe. Regenerate and commit:\n\n" +
    "    node packages/core/scripts/extract-dcr-template-schemas.mjs\n\n" +
    `  ${changed.length} table(s) differ: ${changed.slice(0, NAMED_TABLE_LIMIT).join(", ")}` +
    (changed.length > NAMED_TABLE_LIMIT ? ", ..." : "") +
    "\n";

  return { matches: false, changed, message };
}

/**
 * Run the generator, capture what it produces, then put the committed bytes
 * back. RESTORING IN A FINALLY MATTERS: a checker that leaves the tree dirty
 * when it fails is a checker people stop running - and the failing paths are
 * the ones where it is easiest to forget. The exit code is decided by the
 * caller precisely so this stays reachable; `process.exit` in here would skip
 * the finally and strand the regenerated file in the working tree.
 *
 * The committed text is written back VERBATIM, never normalised - normalising
 * on the way out would rewrite a CRLF checkout as LF and dirty the tree on
 * every Windows run, which is DBT-70 again wearing the other hat.
 */
export function checkSchemaAsset({ readAsset, writeAsset, runGenerator }) {
  const committed = readAsset();

  let regenerated;
  try {
    runGenerator();
    regenerated = readAsset();
  } catch (error) {
    return {
      ok: false,
      reason: "generator-failed",
      changed: [],
      message: GENERATOR_FAILED_MESSAGE,
      detail: String(error instanceof Error ? error.message : error),
    };
  } finally {
    writeAsset(committed);
  }

  const comparison = compareAssets({ committed, regenerated });
  return {
    ok: comparison.matches,
    reason: comparison.matches ? "matches" : "drift",
    changed: comparison.changed,
    message: comparison.message,
  };
}

function main() {
  const result = checkSchemaAsset({
    readAsset: () => readFileSync(ASSET, "utf-8"),
    writeAsset: (text) => writeFileSync(ASSET, text, "utf-8"),
    runGenerator: () => execFileSync(process.execPath, [SCRIPT], { cwd: ROOT, stdio: "pipe" }),
  });

  if (result.ok) {
    console.log(result.message);
    return;
  }

  console.error(result.message);
  if (result.detail) console.error(result.detail);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
