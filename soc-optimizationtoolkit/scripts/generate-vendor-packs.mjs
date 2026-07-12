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
// Usage: node scripts/generate-vendor-packs.mjs

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
    if (!Array.isArray(expDocs)) continue;
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
          if (!votes.has(src)) votes.set(src, new Map());
          const m = votes.get(src);
          m.set(ecsKey, (m.get(ecsKey) ?? 0) + 1);
        }
      }
    }
  }
  // Accept dominant pairings.
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
    for (const m of mined) {
      const key = m.sourceName.toLowerCase();
      const existing = bySource.get(key);
      if (!existing || m.votes > existing.votes) bySource.set(key, m);
    }
    console.log(`${target.pkg}/${stream}: ${mined.length} mined`);
  }
  const mappings = [...bySource.values()]
    .sort((a, b) => a.sourceName.localeCompare(b.sourceName))
    .map(({ sourceName, destName, ecs }) => ({ sourceName, destName, ecs }));
  if (mappings.length === 0) continue;
  packs.push({
    id: `generated-${target.pkg}`,
    vendor: target.vendor,
    solutionKeywords: target.keywords,
    provenance: `Generated from elastic/integrations ${target.pkg} pipeline fixtures (vendor->ECS) + curated ECS->CommonSecurityLog bridge`,
    mappings,
  });
}

fs.writeFileSync(OUT, JSON.stringify(packs, null, 1) + "\n");
console.log(`\nwrote ${packs.length} packs -> ${OUT}`);
for (const p of packs) console.log(`  ${p.id}: ${p.mappings.length} mappings`);
