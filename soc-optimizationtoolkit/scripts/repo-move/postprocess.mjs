// The setup commit for the new repository (DBT-132). Run by extract.sh inside
// the filtered clone; never run it in the source repository.
//
//   node postprocess.mjs <out-dir> <stage-dir> <source-head>
//
// What it does, and why each part exists:
//   - writes the repository root: .gitattributes, LICENSE and the .claude
//     hooks/skills copied as they are; NOTICE retitled; .gitignore and
//     README.md from root/ here; CLAUDE.md COMPOSED from the source CLAUDE.md
//     (the binding sections verbatim, so they cannot be a stale snapshot) plus
//     the new-repository sections in root/CLAUDE.parts.md;
//   - removes the DCR-template schema extractor, its check and the CI step:
//     their source (Azure/CustomDeploymentTemplates/DCR-Templates) stays in
//     the old repository, and the committed schema asset ships frozen;
//   - copies the CI workflow without that step.
// Every edit asserts the text it replaces, so a source that has moved on fails
// the extraction loudly instead of producing a half-edited repository.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [out, stage, sourceHead] = process.argv.slice(2);
if (!out || !stage || !sourceHead) {
  console.error("usage: postprocess.mjs <out-dir> <stage-dir> <source-head>");
  process.exit(2);
}
const HERE = dirname(fileURLToPath(import.meta.url));
const APP = "soc-optimizationtoolkit";

function read(p) {
  return readFileSync(p, "utf8");
}
function write(p, text) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}
function replaceOnce(text, from, to, where) {
  if (!text.includes(from)) {
    throw new Error(`${where}: expected text not found - the source moved on:\n${from}`);
  }
  return text.replace(from, to);
}

// --- copied as they are ---------------------------------------------------
for (const f of [".gitattributes", "LICENSE"]) {
  write(join(out, f), read(join(stage, f)));
}
cpSync(join(stage, ".claude"), join(out, ".claude"), { recursive: true });

// --- NOTICE, retitled -----------------------------------------------------
write(
  join(out, "NOTICE"),
  replaceOnce(read(join(stage, "NOTICE")), "Cribl-Microsoft Integration", "SOC Optimization Toolkit", "NOTICE"),
);

// --- .gitignore and README from root/ ---------------------------------------
write(join(out, ".gitignore"), read(join(HERE, "root", "gitignore")));
write(join(out, "README.md"), read(join(HERE, "root", "README.md")));

// --- QUICK_START.md, its links into the old repository made absolute -------
// The install guide belongs to the app. Its links to the DCR templates, the old
// README's sections and deprecated/ point at things that stay behind, so they
// become links into criblio/Cribl-Microsoft. Each is asserted, not pattern-
// matched, so a link added later fails the extraction instead of breaking.
const OLD = "https://github.com/criblio/Cribl-Microsoft";
let quick = read(join(stage, "QUICK_START.md"));
for (const [from, to] of [
  ["](README.md#choosing-a-path)", `](${OLD}#choosing-a-path)`],
  ["](README.md#the-manual-option)", `](${OLD}#the-manual-option)`],
  [
    "](Azure/CustomDeploymentTemplates/DCR-Templates/SentinelNativeTables/)",
    `](${OLD}/tree/main/Azure/CustomDeploymentTemplates/DCR-Templates/SentinelNativeTables/)`,
  ],
  ["](deprecated/README.md)", `](${OLD}/blob/main/deprecated/README.md)`],
]) {
  quick = replaceOnce(quick, from, to, "QUICK_START.md");
}
write(join(out, "QUICK_START.md"), quick);

// --- CLAUDE.md, composed ----------------------------------------------------
// Sections taken VERBATIM from the source, by heading. These are the binding
// rules; composing at extraction time keeps them current.
const VERBATIM = [
  "## CRITICAL: Code Style Rules",
  "## The board is the source of truth for work",
  "## Git Workflow",
  "## Documentation Standards",
  "## Shared standards",
];
const source = read(join(stage, "CLAUDE.md"));
function section(heading) {
  const start = source.split("\n").findIndex((l) => l.startsWith(heading));
  if (start === -1) throw new Error(`CLAUDE.md: no section "${heading}" in the source`);
  const lines = source.split("\n");
  let end = start + 1;
  while (end < lines.length && !/^## /.test(lines[end])) end++;
  return lines.slice(start, end).join("\n").trimEnd();
}
const parts = read(join(HERE, "root", "CLAUDE.parts.md"));
let claude = parts;
for (const heading of VERBATIM) {
  const marker = `<!-- VERBATIM: ${heading} -->`;
  claude = replaceOnce(claude, marker, section(heading), "CLAUDE.parts.md");
}
write(join(out, "CLAUDE.md"), claude.trimEnd() + "\n");

// --- the schema extractor and its check stay behind ---------------------------
for (const f of [
  `${APP}/packages/core/scripts/extract-dcr-template-schemas.mjs`,
  `${APP}/apps/cribl-app/scripts/check-schema-asset.mjs`,
  `${APP}/apps/cribl-app/scripts/check-schema-asset.test.mjs`,
]) {
  if (!existsSync(join(out, f))) throw new Error(`expected ${f} in the extract`);
  rmSync(join(out, f));
}
for (const [file, line] of [
  [`${APP}/package.json`, `    "check-schema-asset": "npm run check-schema-asset --workspace apps/cribl-app",\n`],
  [`${APP}/apps/cribl-app/package.json`, `    "check-schema-asset": "node scripts/check-schema-asset.mjs",\n`],
]) {
  write(join(out, file), replaceOnce(read(join(out, file)), line, "", file));
}

// The two places that describe the removed extractor as present.
const readmePath = join(out, APP, "README.md");
write(
  readmePath,
  replaceOnce(
    read(readmePath),
    "`check-board`, `check-listings`, `check-classnames`, `check-schema-asset` and",
    "`check-board`, `check-listings`, `check-classnames` and",
    "soc-optimizationtoolkit/README.md",
  ),
);
const catalogPath = join(out, APP, "packages/core/src/domain/field-matcher/bundled-schema-catalog.ts");
write(
  catalogPath,
  replaceOnce(
    read(catalogPath),
    " * path stays fetch-free. Regenerate the asset with\n" +
      " * `node scripts/extract-dcr-template-schemas.mjs` (see that script's header).\n",
    " * path stays fetch-free. The asset is FROZEN in this repository: the DCR\n" +
      " * templates it was extracted from, and the extractor, stayed in\n" +
      " * criblio/Cribl-Microsoft when the app moved (DBT-132).\n",
    "bundled-schema-catalog.ts",
  ),
);

// --- CI, without the schema step -------------------------------------------
const ci = read(join(stage, ".github/workflows/soc-toolkit-ci.yml"));
const schemaStep =
  "      # DBT-67. The extractor that generates a committed core asset crashed for\n" +
  "      # seven weeks and nothing reported it, because no test ran it and no gate\n" +
  "      # called it. This runs it.\n" +
  "      - name: Check schema asset\n" +
  "        run: npm run check-schema-asset --workspace apps/cribl-app\n\n";
write(join(out, ".github/workflows/soc-toolkit-ci.yml"), replaceOnce(ci, schemaStep, "", "soc-toolkit-ci.yml"));

console.log(`postprocess: root written, schema extractor removed (source ${sourceHead.slice(0, 7)})`);
