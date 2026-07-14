// Dev extraction script (porting-plan Unit 13, deliverable a) - NOT part of the
// core runtime. It lives OUTSIDE packages/core/src precisely because packages/core
// is zero-IO/zero-fetch; this script is the ONE place that touches the filesystem.
// Its committed output (src/assets/dcr-template-schemas.json) is what core imports
// statically at runtime (resolveJsonModule), so the shipped package stays fetch-free
// and air-gap-capable.
//
// WHAT IT DOES
//   1. Parses the 50 native Sentinel DCR ARM templates under
//      Azure/CustomDeploymentTemplates/DCR-Templates/SentinelNativeTables/
//      DataCollectionRules(NoDCE)/*.json, extracting
//      resources[].properties.streamDeclarations['Custom-{table}'].columns
//      (each {name, type}). The DCE and NoDCE column sets are IDENTICAL per table
//      (verified: 0 mismatches across all 50; e.g. CommonSecurityLog is 157 cols in
//      both), so only NoDCE is read.
//   2. Folds in the custom (_CL) table schemas under
//      Azure/CustomDeploymentTemplates/DCR-Automation/core/custom-table-schemas/*.json
//      (tables not yet in Azure - CrowdStrike, Cloudflare, sample app), reading their
//      bare { columns: [{name, type, description}] } shape.
//   3. Emits ONE compact asset { tableName: [{name, type}, ...] } with top-level keys
//      sorted for stable diffs; column ORDER within each table is preserved verbatim
//      (order is part of the DCR contract). System columns are NOT stripped here -
//      the asset mirrors the templates faithfully; the runtime SchemaCatalog applies
//      the SYSTEM_COLUMNS filter (matching legacy loadDcrTemplateSchemaPublic).
//
// COLUMN TYPES are stored VERBATIM (native templates already carry the DCR type
// vocabulary string/int/long/real/boolean/datetime/dynamic/guid). They are NOT run
// through schema-mapping.mapColumnType here: legacy loadDcrTemplateSchema returned raw
// types, and mapping would collapse guid->string, diverging from the deployed contract.
//
// REGENERATE (from packages/core):
//   node scripts/extract-dcr-template-schemas.mjs
// Commit the resulting src/assets/dcr-template-schemas.json.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
// scripts -> core -> packages -> soc-optimizationtoolkit -> repo root
const repoRoot = join(scriptDir, "..", "..", "..", "..");

const nativeDir = join(
  repoRoot,
  "Azure",
  "CustomDeploymentTemplates",
  "DCR-Templates",
  "SentinelNativeTables",
  "DataCollectionRules(NoDCE)",
);
const customDir = join(
  repoRoot,
  "Azure",
  "CustomDeploymentTemplates",
  "DCR-Automation",
  "core",
  "custom-table-schemas",
);
const outPath = join(scriptDir, "..", "src", "assets", "dcr-template-schemas.json");

/** Extract the Custom-{table} stream-declaration columns from one ARM template. */
function extractNativeColumns(filePath, tableName) {
  const template = JSON.parse(readFileSync(filePath, "utf-8"));
  const resources = Array.isArray(template.resources) ? template.resources : [];
  for (const resource of resources) {
    const streamDeclarations = resource?.properties?.streamDeclarations;
    if (!streamDeclarations) continue;
    const columns = streamDeclarations[`Custom-${tableName}`]?.columns;
    if (Array.isArray(columns)) {
      return columns.map((c) => ({ name: c.name, type: c.type }));
    }
  }
  return null;
}

const schemas = {};

// (1) native DCR templates
let nativeCount = 0;
for (const file of readdirSync(nativeDir).filter((f) => f.endsWith(".json")).sort()) {
  const tableName = basename(file, ".json");
  const columns = extractNativeColumns(join(nativeDir, file), tableName);
  if (!columns || columns.length === 0) {
    throw new Error(`No Custom-${tableName} stream declaration in ${file}`);
  }
  schemas[tableName] = columns;
  nativeCount += 1;
}

// (2) custom _CL table schemas (bare { columns } shape). Legacy default: missing
// type falls back to "string".
let customCount = 0;
for (const file of readdirSync(customDir).filter((f) => f.endsWith(".json")).sort()) {
  const schema = JSON.parse(readFileSync(join(customDir, file), "utf-8"));
  if (!Array.isArray(schema.columns)) continue;
  const tableName = schema.name || basename(file, ".json");
  schemas[tableName] = schema.columns.map((c) => ({
    name: c.name,
    type: c.type || "string",
  }));
  customCount += 1;
}

// Sort top-level table keys for stable diffs (column order preserved above).
const sorted = {};
for (const key of Object.keys(schemas).sort()) {
  sorted[key] = schemas[key];
}

writeFileSync(outPath, JSON.stringify(sorted, null, 2) + "\n", "utf-8");
console.log(
  `Wrote ${Object.keys(sorted).length} table schemas ` +
    `(${nativeCount} native + ${customCount} custom) to ${outPath}`,
);
