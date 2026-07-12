// Sentinel-DCR pack GENERATOR (dev-time only; the app never fetches at
// runtime). Wave A of docs/sentinel-repo-mapping-sources.md: the Azure-
// Sentinel repo's CCP connector DCRs carry Microsoft/vendor-maintained
// transformKql projections (vendor field -> destination column) - the exact
// transform Microsoft runs at ingestion, i.e. the most authoritative
// machine-readable field mapping that exists for these solutions.
//
// For each target solution, fetch its CCP DCR JSON(s) and tokenize every
// dataFlow's transformKql project/extend clauses into source -> destination
// pairs. Accepted right-hand shapes (everything else is skipped - lookup
// dicts, iff() logic, now(), constants):
//   Dest = source_field
//   Dest = toXxx(source_field)
//   Dest = column_ifexists('source_field', ...)
//   Dest = datetime(1970-01-01) + (source_field * 1ms)   (epoch-ms fields)
//
// Output: packages/core/src/assets/generated-sentinel-dcr-packs.json (never
// hand-edit; re-run this script). Declared AFTER hand packs and BEFORE the
// Elastic-mined packs in the registry - official DCR knowledge outranks
// fixture mining, hand verification outranks both.
//
// Usage: node scripts/generate-sentinel-dcr-packs.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "core",
  "src",
  "assets",
  "generated-sentinel-dcr-packs.json",
);

const RAW = "https://raw.githubusercontent.com/Azure/Azure-Sentinel/master/";
const API = "https://api.github.com/repos/Azure/Azure-Sentinel/contents/";

// Targets verified in docs/sentinel-repo-mapping-sources.md. `discover`
// lists a Data Connectors dir and takes `file` from every subdir matching
// `pattern`; `paths` are exact repo-relative DCR files.
const TARGETS = [
  {
    vendor: "Zscaler",
    keywords: ["zscaler"],
    solution: "Zscaler Internet Access",
    discover: {
      dir: "Solutions/Zscaler Internet Access/Data Connectors",
      pattern: /_ccp$/,
      file: "DCR.json",
    },
  },
  {
    vendor: "Palo Alto Cortex XDR",
    keywords: ["cortex xdr"],
    solution: "Palo Alto Cortex XDR CCP",
    paths: [
      "Solutions/Palo Alto Cortex XDR CCP/Data Connectors/CortexXDR_ccp/DCR.json",
    ],
  },
  {
    vendor: "Okta",
    keywords: ["okta"],
    solution: "Okta Single Sign-On",
    paths: [
      "Solutions/Okta Single Sign-On/Data Connectors/OktaNativePollerConnectorV2/OktaSSOv2_DCR.json",
    ],
  },
  {
    vendor: "SentinelOne",
    keywords: ["sentinelone", "sentinel one"],
    solution: "SentinelOne",
    paths: [
      "Solutions/SentinelOne/Data Connectors/SentinelOneV2_ccf/SentinelOneV2_DCR.json",
    ],
  },
  {
    vendor: "Netskope",
    keywords: ["netskope"],
    solution: "Netskopev2",
    paths: [
      "Solutions/Netskopev2/Data Connectors/NetskopeAlertsEvents_RestAPI_CCP/NetskopeAlertsEvents_DCR.json",
    ],
  },
  {
    vendor: "Cloudflare",
    keywords: ["cloudflare"],
    solution: "Cloudflare",
    paths: [
      "Solutions/Cloudflare/Data Connectors/CloudflareLog_CCF/CloudflareLog_DCR.json",
    ],
  },
  {
    vendor: "CrowdStrike",
    keywords: ["crowdstrike"],
    solution: "CrowdStrike Falcon Endpoint Protection",
    paths: [
      "Solutions/CrowdStrike Falcon Endpoint Protection/Data Connectors/CrowdStrikeS3FDR_ccp/DCR.json",
    ],
  },
];

async function getText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "soc-optimizationtoolkit-generator" },
  });
  if (!res.ok) return null;
  return res.text();
}

function encodePath(p) {
  return p.split("/").map(encodeURIComponent).join("/");
}

/** Split a KQL stage's argument list on TOP-LEVEL commas. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = "";
  for (const ch of text) {
    if (quote !== null) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== "") parts.push(cur);
  return parts;
}

const IDENT = "[A-Za-z_][A-Za-z0-9_]*";
const RHS_PATTERNS = [
  new RegExp(`^(${IDENT})$`), // bare identifier
  new RegExp(`^to\\w+\\(\\s*(${IDENT})\\s*\\)$`), // toXxx(field)
  new RegExp(`^column_ifexists\\(\\s*'(${IDENT})'`), // column_ifexists('field',...)
  // datetime(1970-01-01) + (field * 1ms)  - epoch-ms conversion
  new RegExp(`^datetime\\([^)]*\\)\\s*\\+\\s*\\(\\s*(${IDENT})\\s*\\*\\s*1ms\\s*\\)$`),
];

/** Extract dest<-source pairs from one transformKql string. */
export function minePairsFromTransform(transformKql) {
  const pairs = [];
  for (const stage of transformKql.split("|")) {
    const trimmed = stage.trim();
    const m = trimmed.match(/^(project-rename|project|extend)\s+([\s\S]+)$/);
    if (m === null) continue;
    for (const item of splitTopLevel(m[2])) {
      const eq = item.match(
        new RegExp(`^\\s*(${IDENT})\\s*=\\s*([\\s\\S]+?)\\s*$`),
      );
      if (eq === null) continue;
      const dest = eq[1];
      const rhs = eq[2];
      for (const pattern of RHS_PATTERNS) {
        const hit = rhs.match(pattern);
        if (hit !== null) {
          if (hit[1].toLowerCase() !== dest.toLowerCase()) {
            pairs.push({ sourceName: hit[1], destName: dest });
          }
          break;
        }
      }
    }
  }
  return pairs;
}

function stripStream(outputStream) {
  return String(outputStream ?? "").replace(/^(Custom|Microsoft)-/, "");
}

function dataFlowsOf(dcrJson) {
  const flows = [];
  // Three ARM shapes in the wild: a template with `resources`, a bare DCR
  // resource object, and a top-level ARRAY of DCR resources.
  const resources = Array.isArray(dcrJson)
    ? dcrJson
    : Array.isArray(dcrJson?.resources)
      ? dcrJson.resources
      : [dcrJson];
  for (const resource of resources) {
    const props = resource?.properties ?? resource;
    for (const flow of props?.dataFlows ?? []) {
      if (typeof flow?.transformKql === "string") flows.push(flow);
    }
  }
  return flows;
}

async function resolveDcrPaths(target) {
  if (target.paths !== undefined) return target.paths;
  const listing = await getText(API + encodePath(target.discover.dir));
  if (listing === null) return [];
  const entries = JSON.parse(listing);
  return entries
    .filter((e) => e.type === "dir" && target.discover.pattern.test(e.name))
    .map((e) => `${target.discover.dir}/${e.name}/${target.discover.file}`);
}

async function main() {
  const packs = [];
  for (const target of TARGETS) {
    const dcrPaths = await resolveDcrPaths(target);
    const bySource = new Map();
    let flowsSeen = 0;
    for (const dcrPath of dcrPaths) {
      const text = await getText(RAW + encodePath(dcrPath));
      if (text === null) {
        console.warn(`  MISS ${dcrPath}`);
        continue;
      }
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        console.warn(`  UNPARSEABLE ${dcrPath}`);
        continue;
      }
      const bundle = path.basename(path.dirname(dcrPath));
      for (const flow of dataFlowsOf(json)) {
        flowsSeen++;
        const table = stripStream(flow.outputStream);
        for (const pair of minePairsFromTransform(flow.transformKql)) {
          const key = pair.sourceName.toLowerCase();
          if (!bySource.has(key)) {
            bySource.set(key, {
              sourceName: pair.sourceName,
              destName: pair.destName,
              doc: `Sentinel solution DCR (${bundle} -> ${table}): ${pair.sourceName} projected to ${pair.destName}`,
            });
          }
        }
      }
    }
    const mappings = [...bySource.values()].sort((a, b) =>
      a.sourceName.localeCompare(b.sourceName),
    );
    if (mappings.length === 0) {
      console.warn(`SKIP ${target.vendor}: nothing mined`);
      continue;
    }
    packs.push({
      id: `sentinel-dcr-${target.vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      vendor: target.vendor,
      solutionKeywords: target.keywords,
      provenance: `Microsoft Sentinel solution DCR transform (${target.solution})`,
      docUrl: `https://github.com/Azure/Azure-Sentinel/tree/master/Solutions/${encodeURIComponent(target.solution)}/Data%20Connectors`,
      mappings,
    });
    console.log(
      `${target.vendor}: ${mappings.length} mappings from ${dcrPaths.length} DCR file(s), ${flowsSeen} flow(s)`,
    );
  }
  packs.sort((a, b) => a.id.localeCompare(b.id));
  const json = JSON.stringify(packs, null, 1) + "\n";
  fs.writeFileSync(OUT, json);
  const total = packs.reduce((sum, p) => sum + p.mappings.length, 0);
  console.log(
    `\nwrote ${packs.length} packs / ${total} mappings (${Math.round(json.length / 1024)} KiB) -> ${OUT}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
