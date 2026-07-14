// Vendor-pack GENERATOR (dev-time only; the app never fetches at runtime).
//
// For each curated vendor stream, downloads the elastic/integrations pipeline
// test fixture pair - the RAW vendor events (test-*.log, NDJSON vendors only)
// and Elastic's PARSED output (-expected.json, maintained by Elastic against
// the vendor's documentation). Mining: a raw field maps to an ECS field when
// their VALUES are equal across enough events and the pairing is dominant
// (>= MIN_VOTES votes and >= DOMINANCE of that raw field's candidate votes).
// The curated ECS_TO_CSL bridge then completes vendor field -> ECS field ->
// CommonSecurityLog column.
//
// Output: packages/core/src/assets/generated-vendor-packs.json (never
// hand-edit; re-run this script). Hand packs in vendor-mapping-packs.ts are
// declared first and win the per-source dedupe.
//
// Usage:
//   node scripts/generate-vendor-packs.mjs                 (curated targets, API)
//   node scripts/generate-vendor-packs.mjs --bulk <dir>    (EVERY package in a
//     local elastic/integrations checkout - see the sparse-clone recipe below)
//
// Bulk recipe (one-time, ~few minutes):
//   git clone --filter=blob:none --depth 1 https://github.com/elastic/integrations
//   git -C integrations ls-tree -r HEAD --name-only -- packages \
//     | grep -E "(_dev/test/pipeline/|^packages/[^/]+/manifest.yml$)" > paths.txt
//   git -C integrations restore --source=HEAD --pathspec-from-file=../paths.txt
//
// BULK SAFETY (no human review of hundreds of packs): on top of the vote
// thresholds, every candidate mapping onto a TYPED column must have sample
// values that LOOK like that column's type (IPs for *IP columns, 0-65535
// integers for *Port, hex digests for FileHash, MACs, URL-ish strings) -
// this kills the value-collision artifact class the curated runs caught by
// hand (srv_dport -> source.port etc.).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages/core/src/assets/generated-vendor-packs.json",
);

// NDJSON-raw vendors only (KV/CSV vendors need the vendor parser to pair
// values; their knowledge lives in the hand-curated aliases instead).
const TARGETS = [
  { pkg: "zscaler_zia", streams: ["web", "firewall", "dns", "tunnel"], vendor: "Zscaler", keywords: ["zscaler"] },
  { pkg: "crowdstrike", streams: ["fdr", "falcon", "alert"], vendor: "CrowdStrike", keywords: ["crowdstrike"] },
  { pkg: "suricata", streams: ["eve"], vendor: "Suricata", keywords: ["suricata"] },
  { pkg: "cisco_secure_endpoint", streams: ["event"], vendor: "Cisco Secure Endpoint", keywords: ["cisco secure endpoint", "secure endpoint"] },
  { pkg: "cisco_duo", streams: ["admin"], vendor: "Cisco Duo", keywords: ["cisco duo", "duo security", "cisco secure application"] },
  // Broader coverage (2026-07-12): additional NDJSON security vendors from
  // the Elastic index. Unknown streams 404 and are skipped harmlessly;
  // streams that mine nothing produce no pack.
  { pkg: "sentinel_one", streams: ["activity", "alert", "threat", "agent"], vendor: "SentinelOne", keywords: ["sentinelone", "sentinel one"] },
  { pkg: "netskope", streams: ["alerts", "events"], vendor: "Netskope", keywords: ["netskope"] },
  { pkg: "cloudflare_logpush", streams: ["http_request", "firewall_event", "dns"], vendor: "Cloudflare", keywords: ["cloudflare"] },
  { pkg: "carbon_black_cloud", streams: ["alert", "endpoint_event", "watchlist_hit"], vendor: "VMware Carbon Black", keywords: ["carbon black", "carbonblack"] },
  { pkg: "panw_cortex_xdr", streams: ["alerts", "incidents"], vendor: "Palo Alto Cortex XDR", keywords: ["cortex xdr", "cortex"] },
];

// Curated ECS -> CommonSecurityLog bridge. Every value is a REAL CSL column.
// Deliberately excludes ambiguous paths (host.name may be the reporting
// sensor or the visited host depending on the integration).
const ECS_TO_CSL = {
  "source.ip": "SourceIP",
  "client.ip": "SourceIP",
  "source.port": "SourcePort",
  "client.port": "SourcePort",
  "destination.ip": "DestinationIP",
  "server.ip": "DestinationIP",
  "destination.port": "DestinationPort",
  "server.port": "DestinationPort",
  "source.nat.ip": "SourceTranslatedAddress",
  "source.nat.port": "SourceTranslatedPort",
  "destination.nat.ip": "DestinationTranslatedAddress",
  "destination.nat.port": "DestinationTranslatedPort",
  "source.bytes": "SentBytes",
  "destination.bytes": "ReceivedBytes",
  "source.mac": "SourceMACAddress",
  "destination.mac": "DestinationMACAddress",
  "http.request.method": "RequestMethod",
  "http.response.status_code": "EventOutcome",
  "url.original": "RequestURL",
  "url.full": "RequestURL",
  "url.domain": "DestinationHostName",
  "user_agent.original": "RequestClientApplication",
  "http.request.referrer": "RequestContext",
  "user.name": "SourceUserName",
  "user.email": "SourceUserName",
  "source.user.name": "SourceUserName",
  "destination.user.name": "DestinationUserName",
  "event.action": "DeviceAction",
  "network.transport": "Protocol",
  "network.protocol": "ApplicationProtocol",
  "network.application": "ApplicationProtocol",
  "dns.question.name": "DestinationDnsDomain",
  "file.name": "FileName",
  "file.path": "FilePath",
  "file.size": "FileSize",
  "file.hash.sha256": "FileHash",
  "process.pid": "SourceProcessId",
  "process.name": "ProcessName",
  "event.id": "ExternalID",
  "event.reason": "Reason",
  "message": "Message",
  "event.severity": "LogSeverity",
  "observer.ingress.interface.name": "DeviceInboundInterface",
  "observer.egress.interface.name": "DeviceOutboundInterface",
};

const MIN_VOTES = 3;
const DOMINANCE = 0.8;
// Source fields whose VALUE TYPE varies per event (a hash in one record, an
// IP or domain in the next) - mining sees only the fixture's variant, so a
// mapping would be wrong for the others. Reviewed per generation run.
const SOURCE_BLOCKLIST = new Set([
  "IOCValue",
  "ioc_value",
  // SentinelOne: free-text description that only INCIDENTALLY equals
  // file.path in the fixtures - prose would land in FilePath.
  "secondaryDescription",
]);
// TYPED-COLUMN validators: a candidate mapping onto one of these columns
// only counts a vote when the shared VALUE looks like the column's type.
const isIp = (v) =>
  /^\d{1,3}(\.\d{1,3}){3}$/.test(v) || /^[0-9a-fA-F:]+:[0-9a-fA-F:]*$/.test(v);
const isPort = (v) => /^\d{1,5}$/.test(v) && Number(v) <= 65535;
const isHash = (v) => /^[0-9a-fA-F]{32,128}$/.test(v);
const isMac = (v) => /^[0-9a-fA-F]{2}([:-][0-9a-fA-F]{2}){5}$/.test(v);
const isUrlish = (v) => v.includes("/") || v.includes(".");
const DEST_VALIDATORS = {
  SourceIP: isIp,
  DestinationIP: isIp,
  SourceTranslatedAddress: isIp,
  DestinationTranslatedAddress: isIp,
  DeviceAddress: isIp,
  SourcePort: isPort,
  DestinationPort: isPort,
  SourceTranslatedPort: isPort,
  DestinationTranslatedPort: isPort,
  FileHash: isHash,
  SourceMACAddress: isMac,
  DestinationMACAddress: isMac,
  RequestURL: isUrlish,
  DestinationDnsDomain: isUrlish,
  DestinationHostName: isUrlish,
  SentBytes: (v) => /^\d+$/.test(v),
  ReceivedBytes: (v) => /^\d+$/.test(v),
  FileSize: (v) => /^\d+$/.test(v),
  SourceProcessId: (v) => /^\d+$/.test(v),
};
function valuePassesValidator(destName, value) {
  const validator = DEST_VALIDATORS[destName];
  return validator === undefined || validator(String(value));
}

// Values too generic to vote with (they collide across unrelated fields).
const isTrivial = (v) =>
  v === null ||
  v === undefined ||
  String(v).length < 2 ||
  ["0", "1", "true", "false", "-", "none", "None", "unknown"].includes(String(v));

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": "soc-toolkit-packgen" } });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res.text();
}

function flatten(obj, prefix = "", out = {}) {
  if (obj === null || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix === "" ? k : `${prefix}.${k}`;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else if (Array.isArray(v) && v.length === 1 && typeof v[0] !== "object")
      out[key] = v[0];
    else if (!Array.isArray(v)) out[key] = v;
  }
  return out;
}

// Strip the integration's raw-event wrapper prefix ("event." for zscaler,
// "crowdstrike." etc.) so mined source names match what the app's parser
// discovers after unwrap.
function rawFieldName(key) {
  return key.replace(/^(event|json)\./, "");
}

async function mineStream(pkg, stream) {
  const base = `https://api.github.com/repos/elastic/integrations/contents/packages/${pkg}/data_stream/${stream}/_dev/test/pipeline`;
  const listing = JSON.parse(await get(base));
  const pairs = [];
  for (const item of listing) {
    if (item.type !== "file" || !item.name.endsWith(".log")) continue;
    const expected = listing.find((e) => e.name === `${item.name}-expected.json`);
    if (!expected) continue;
    pairs.push([item, expected]);
  }
  // votes: rawField -> ecsField -> count
  const votes = new Map();
  for (const [rawFile, expFile] of pairs) {
    let rawLines, expDocs;
    try {
      rawLines = (await get(rawFile.download_url)).trim().split("\n");
      const parsedExpected = JSON.parse(await get(expFile.download_url));
      expDocs = parsedExpected.expected ?? parsedExpected;
    } catch {
      continue;
    }
    mineDocPairs(rawLines, expDocs, votes);
  }
  return acceptVotes(votes);
}

/** Vote over one raw/expected fixture pair (shared by API and bulk modes). */
function mineDocPairs(rawLines, expDocs, votes) {
  if (!Array.isArray(expDocs)) return;
  {
    const n = Math.min(rawLines.length, expDocs.length);
    for (let i = 0; i < n; i++) {
      let rawObj;
      try {
        rawObj = JSON.parse(rawLines[i]);
      } catch {
        continue; // non-NDJSON raw line
      }
      const raw = flatten(rawObj);
      const exp = flatten(expDocs[i] ?? {});
      // Value -> ECS paths (skip values appearing in too many ECS paths)
      const byValue = new Map();
      for (const [ecsKey, ecsVal] of Object.entries(exp)) {
        if (isTrivial(ecsVal)) continue;
        const v = String(ecsVal);
        if (!byValue.has(v)) byValue.set(v, []);
        byValue.get(v).push(ecsKey);
      }
      for (const [rawKey, rawVal] of Object.entries(raw)) {
        if (isTrivial(rawVal)) continue;
        const ecsKeys = byValue.get(String(rawVal));
        if (!ecsKeys || ecsKeys.length > 3) continue;
        const src = rawFieldName(rawKey);
        if (src.includes(".")) continue; // nested raw structures: skip
        if (SOURCE_BLOCKLIST.has(src)) continue;
        for (const ecsKey of ecsKeys) {
          if (!(ecsKey in ECS_TO_CSL)) continue;
          if (!valuePassesValidator(ECS_TO_CSL[ecsKey], rawVal)) continue;
          if (!votes.has(src)) votes.set(src, new Map());
          const m = votes.get(src);
          m.set(ecsKey, (m.get(ecsKey) ?? 0) + 1);
        }
      }
    }
  }
}

/** Accept dominant pairings out of a vote map. */
function acceptVotes(votes) {
  const mappings = [];
  for (const [src, m] of votes) {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const [bestEcs, bestVotes] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    if (bestVotes < MIN_VOTES || bestVotes / total < DOMINANCE) continue;
    mappings.push({
      sourceName: src,
      destName: ECS_TO_CSL[bestEcs],
      ecs: bestEcs,
      votes: bestVotes,
    });
  }
  return mappings;
}

/** Fold one stream's mined mappings into a per-pack source map (max votes wins). */
function foldMined(bySource, mined) {
  for (const m of mined) {
    const key = m.sourceName.toLowerCase();
    const existing = bySource.get(key);
    if (!existing || m.votes > existing.votes) bySource.set(key, m);
  }
}

// The exact tree every pack was mined from - a durable documentation
// reference for the per-table "Vendor mapping documentation" line (each
// package page cites the vendor's own docs and holds the fixture pairs).
const FIXTURES_COMMIT = "96400ccea7056b462c1baad1c2cbffe7fb961bf4";

function packFromSources(pkg, vendor, keywords, bySource, minMappings) {
  const mappings = [...bySource.values()]
    .sort((a, b) => a.sourceName.localeCompare(b.sourceName))
    .map(({ sourceName, destName, ecs }) => ({ sourceName, destName, ecs }));
  if (mappings.length < minMappings) return null;
  return {
    id: `generated-${pkg}`,
    vendor,
    solutionKeywords: keywords,
    provenance: `Generated from elastic/integrations ${pkg} pipeline fixtures (vendor->ECS) + curated ECS->CommonSecurityLog bridge`,
    docUrl: `https://github.com/elastic/integrations/tree/${FIXTURES_COMMIT}/packages/${pkg}`,
    mappings,
  };
}

function writePacks(packs) {
  packs.sort((a, b) => a.id.localeCompare(b.id));
  const json = JSON.stringify(packs, null, 1) + "\n";
  fs.writeFileSync(OUT, json);
  const mappingTotal = packs.reduce((sum, p) => sum + p.mappings.length, 0);
  console.log(
    `\nwrote ${packs.length} packs / ${mappingTotal} mappings (${Math.round(json.length / 1024)} KiB) -> ${OUT}`,
  );
  for (const p of packs) console.log(`  ${p.id}: ${p.mappings.length} mappings`);
}

// ---------------------------------------------------------------------------
// Curated API mode (default): the hand-picked TARGETS via the GitHub API.
// ---------------------------------------------------------------------------
async function runCurated() {
  const packs = [];
  for (const target of TARGETS) {
    const bySource = new Map();
    for (const stream of target.streams) {
      let mined;
      try {
        mined = await mineStream(target.pkg, stream);
      } catch (err) {
        console.error(`SKIP ${target.pkg}/${stream}: ${err.message}`);
        continue;
      }
      foldMined(bySource, mined);
      console.log(`${target.pkg}/${stream}: ${mined.length} mined`);
    }
    const pack = packFromSources(target.pkg, target.vendor, target.keywords, bySource, 1);
    if (pack !== null) packs.push(pack);
  }
  writePacks(packs);
}

// ---------------------------------------------------------------------------
// Bulk mode (--bulk <dir>): EVERY package in a local checkout. Keywords come
// from the curated TARGETS where known, else from the package manifest title
// (over-generic vendor prefixes widen to the first two title words).
// ---------------------------------------------------------------------------
const GENERIC_FIRST_WORDS = new Set([
  "microsoft", "google", "amazon", "aws", "azure", "cisco", "palo", "the",
  "elastic", "vmware", "ibm", "oracle",
]);

function manifestMeta(manifestText) {
  const title = /^title:\s*["']?([^"'\n]+)["']?\s*$/m.exec(manifestText)?.[1]?.trim() ?? "";
  const categories = [...manifestText.matchAll(/^\s*-\s*([a-z_]+)\s*$/gm)].map((m) => m[1]);
  return { title, categories };
}

function keywordsFromTitle(title) {
  const lower = title.toLowerCase().trim();
  if (lower === "") return [];
  const words = lower.split(/\s+/);
  const keywords = [lower];
  if (words.length > 0 && words[0].length >= 4) {
    keywords.push(GENERIC_FIRST_WORDS.has(words[0]) && words.length > 1 ? `${words[0]} ${words[1]}` : words[0]);
  }
  return [...new Set(keywords)];
}

async function runBulk(rootDir) {
  const curatedByPkg = new Map(TARGETS.map((t) => [t.pkg, t]));
  const packagesDir = path.join(rootDir, "packages");
  const packs = [];
  const skipped = { noPipeline: 0, notSecurity: 0, nothingMined: 0 };
  for (const pkg of fs.readdirSync(packagesDir).sort()) {
    const pkgDir = path.join(packagesDir, pkg);
    const manifestPath = path.join(pkgDir, "manifest.yml");
    if (!fs.existsSync(manifestPath)) continue;
    const { title, categories } = manifestMeta(fs.readFileSync(manifestPath, "utf8"));
    const curated = curatedByPkg.get(pkg);
    // Scope to security-relevant packages unless curated: the bundle ships
    // this asset, and an observability pack's mappings are dead weight.
    const securityish = categories.some((c) =>
      ["security", "network", "edr_xdr", "iam", "firewall_security", "email_security",
       "web", "proxy_security", "vpn_security", "network_security", "cloudsecurity_cdn",
       "dns_security", "threat_intel", "siem", "auditd", "authentication"].includes(c),
    );
    if (!curated && !securityish) {
      skipped.notSecurity++;
      continue;
    }
    const dataStreamDir = path.join(pkgDir, "data_stream");
    if (!fs.existsSync(dataStreamDir)) {
      skipped.noPipeline++;
      continue;
    }
    const bySource = new Map();
    let sawFixtures = false;
    for (const stream of fs.readdirSync(dataStreamDir)) {
      const pipelineDir = path.join(dataStreamDir, stream, "_dev", "test", "pipeline");
      if (!fs.existsSync(pipelineDir)) continue;
      const files = fs.readdirSync(pipelineDir);
      const votes = new Map();
      for (const file of files) {
        if (!file.endsWith(".log")) continue;
        const expectedName = `${file}-expected.json`;
        if (!files.includes(expectedName)) continue;
        sawFixtures = true;
        let rawLines, expDocs;
        try {
          rawLines = fs.readFileSync(path.join(pipelineDir, file), "utf8").trim().split("\n");
          const parsedExpected = JSON.parse(fs.readFileSync(path.join(pipelineDir, expectedName), "utf8"));
          expDocs = parsedExpected.expected ?? parsedExpected;
        } catch {
          continue;
        }
        mineDocPairs(rawLines, expDocs, votes);
      }
      foldMined(bySource, acceptVotes(votes));
    }
    if (!sawFixtures) {
      skipped.noPipeline++;
      continue;
    }
    const vendor = curated?.vendor ?? title.replace(/\s+(logs?|integration|events?)$/i, "").trim();
    const keywords = curated?.keywords ?? keywordsFromTitle(title);
    if (vendor === "" || keywords.length === 0) continue;
    // Bulk packs need >= 2 evidence-backed mappings to earn bundle weight.
    const pack = packFromSources(pkg, vendor, keywords, bySource, curated ? 1 : 2);
    if (pack !== null) packs.push(pack);
    else skipped.nothingMined++;
  }
  console.log(
    `bulk: ${packs.length} packs; skipped ${skipped.notSecurity} non-security, ${skipped.noPipeline} without fixtures, ${skipped.nothingMined} below the evidence bar`,
  );
  writePacks(packs);
}

const bulkAt = process.argv.indexOf("--bulk");
if (bulkAt >= 0) {
  const dir = process.argv[bulkAt + 1];
  if (!dir) throw new Error("--bulk requires the checkout directory");
  await runBulk(dir);
} else {
  await runCurated();
}
