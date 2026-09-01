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
 * (DBT-70). The first version compared raw bytes. The generator writes "
";
 * with core.autocrlf=true git checks the committed asset out as "
". So on
 * Windows every run reported a mismatch while listing ZERO differing tables -
 * the giveaway that the difference was not in the data. CI never saw it,
 * because the Linux runner checks out LF and both sides matched. That is
 * [[DBT-66]] exactly: a Windows-only break a green CI cannot see, shipped by
 * the very gate added to stop things going unnoticed.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const SCRIPT = join(ROOT, "packages", "core", "scripts", "extract-dcr-template-schemas.mjs");
const ASSET = join(ROOT, "packages", "core", "src", "assets", "dcr-template-schemas.json");

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

function main() {
  const committed = readFileSync(ASSET, "utf-8");

  // Run the generator, capture what it produces, then put the committed bytes
  // back. Restoring in a finally block matters: a checker that leaves the tree
  // dirty when it fails is a checker people stop running.
  let regenerated;
  try {
    execFileSync(process.execPath, [SCRIPT], { cwd: ROOT, stdio: "pipe" });
    regenerated = readFileSync(ASSET, "utf-8");
  } catch (error) {
    writeFileSync(ASSET, committed, "utf-8");
    console.error(
      "check-schema-asset: the extractor FAILED TO RUN.\n\n" +
        "  This is exactly how the asset went stale for seven weeks (DBT-67):\n" +
        "  the generator crashed and nothing reported it. Fix the generator\n" +
        "  before trusting the committed asset.\n",
    );
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
    return;
  } finally {
    writeFileSync(ASSET, committed, "utf-8");
  }

  // Compare CONTENT, not bytes - see the line-endings note in the header.
  const normalise = (text) => text.split(CR + LF).join(LF);
  if (normalise(regenerated) === normalise(committed)) {
    console.log("check-schema-asset: the committed asset matches a fresh extraction");
    return;
  }

  const c = JSON.parse(committed);
  const r = JSON.parse(regenerated);
  const names = new Set([...Object.keys(c), ...Object.keys(r)]);
  const changed = [...names].filter(
    (n) => JSON.stringify(c[n]) !== JSON.stringify(r[n]),
  );

  console.error(
    "check-schema-asset: the committed asset does NOT match a fresh extraction.\n\n" +
      "  The templates and the generated asset have diverged, which means the\n" +
      "  field matcher is resolving against a schema the templates no longer\n" +
      "  describe. Regenerate and commit:\n\n" +
      "    node packages/core/scripts/extract-dcr-template-schemas.mjs\n\n" +
      `  ${changed.length} table(s) differ: ${changed.slice(0, 12).join(", ")}` +
      (changed.length > 12 ? ", ..." : "") +
      "\n",
  );
  process.exit(1);
}

main();
