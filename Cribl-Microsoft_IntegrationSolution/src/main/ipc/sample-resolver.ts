// Sample Resolver Module
// Resolves raw vendor log samples for Cribl pack building using a tiered approach:
//   Tier 1: Elastic integrations test pipeline data (434+ vendors, raw vendor format)
//   Tier 2: Cribl packs sample data (20+ vendors, already in Cribl event envelope)
//   Tier 3: Synthesize from analytics rules KQL + vendor registry
//   Tier 4: User-uploaded samples (override)

import fs from 'fs';
import path from 'path';
import { BrowserWindow } from 'electron';
import { loadGitHubPat } from './auth';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedSample {
  tableName: string;
  format: string;         // json, cef, kv, syslog, csv, ndjson
  rawEvents: string[];    // Raw vendor event strings
  source: string;         // e.g., "elastic:cisco_asa/log" or "cribl:cribl-cisco-asa-cleanup"
  tier: 'sentinel-repo' | 'elastic' | 'cribl' | 'synthesized' | 'user';
  logType?: string;       // Sub-type (e.g., "traffic", "threat")
}

export interface ElasticRepoStatus {
  state: 'not_cloned' | 'cloning' | 'ready' | 'error';
  localPath: string;
  lastUpdated: number;
  packageCount: number;
  error: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ELASTIC_REPO_URL = 'https://github.com/elastic/integrations.git';
const ELASTIC_REPO_BRANCH = 'main';

// Cribl packs are small -- fetch individual sample files via raw GitHub URLs
const CRIBL_RAW_BASE = 'https://raw.githubusercontent.com/criblpacks';

// ---------------------------------------------------------------------------
// Solution -> Package Mapping
// ---------------------------------------------------------------------------

interface SampleSourceEntry {
  elasticPackage?: string;                     // Elastic integrations package name
  elasticDataStreams?: string[];                // Specific data streams to fetch (empty = all)
  criblPackRepo?: string;                      // Cribl packs GitHub repo name
  criblSampleFiles?: string[];                 // Known sample file names in data/samples/
  sentinelTable: string;                       // Primary Sentinel destination table
  sourceFormat?: string;                       // Expected vendor format
}

// Maps Sentinel Solution names to their sample data sources
const SOLUTION_SAMPLE_MAP: Record<string, SampleSourceEntry> = {
  'Windows Security Events': {
    elasticPackage: 'windows',
    elasticDataStreams: ['sysmon_operational', 'powershell', 'powershell_operational'],
    criblPackRepo: 'cribl-windows-events',
    sentinelTable: 'SecurityEvent',
    sourceFormat: 'json',
  },
  'Amazon Web Services': {
    elasticPackage: 'aws',
    elasticDataStreams: ['cloudtrail', 'guardduty', 'vpcflow'],
    criblPackRepo: 'cribl-aws-cloudtrail-logs',
    sentinelTable: 'AWSCloudTrail',
    sourceFormat: 'json',
  },
  'Microsoft 365': {
    elasticPackage: 'o365',
    elasticDataStreams: ['audit'],
    criblPackRepo: 'cribl-microsoft-graph-rest-io',
    sentinelTable: 'OfficeActivity',
    sourceFormat: 'json',
  },
  'Syslog': {
    elasticPackage: 'system',
    elasticDataStreams: ['syslog'],
    criblPackRepo: 'cribl-syslog-input',
    sentinelTable: 'Syslog',
    sourceFormat: 'syslog',
  },
  'Microsoft Entra ID': {
    elasticPackage: 'azure',
    elasticDataStreams: ['signinlogs', 'auditlogs', 'identity_protection'],
    sentinelTable: 'SigninLogs',
    sourceFormat: 'json',
  },
  'Azure Kubernetes Service': {
    elasticPackage: 'kubernetes',
    elasticDataStreams: ['audit_logs', 'container_logs'],
    sentinelTable: 'ContainerLog',
    sourceFormat: 'json',
  },
  'Cisco ASA': {
    elasticPackage: 'cisco_asa',
    elasticDataStreams: ['log'],
    criblPackRepo: 'cribl-cisco-asa-cleanup',
    sentinelTable: 'CommonSecurityLog',
    sourceFormat: 'syslog',
  },
  'CiscoASA': {
    elasticPackage: 'cisco_asa',
    elasticDataStreams: ['log'],
    criblPackRepo: 'cribl-cisco-asa-cleanup',
    sentinelTable: 'CommonSecurityLog',
    sourceFormat: 'syslog',
  },
  'Google Workspace': {
    elasticPackage: 'google_workspace',
    elasticDataStreams: ['login', 'admin', 'drive', 'saml'],
    criblPackRepo: 'cribl-google-workspace-rest-io',
    sentinelTable: 'GoogleWorkspace_CL',
    sourceFormat: 'json',
  },
  'GitHub Enterprise': {
    elasticPackage: 'github',
    elasticDataStreams: ['audit'],
    sentinelTable: 'GitHubAuditData',
    sourceFormat: 'json',
  },
  'Zscaler Internet Access': {
    elasticPackage: 'zscaler_zia',
    elasticDataStreams: ['web', 'firewall', 'dns', 'tunnel'],
    sentinelTable: 'CommonSecurityLog',
    sourceFormat: 'json',
  },
  'Okta Single Sign-On': {
    elasticPackage: 'okta',
    elasticDataStreams: ['system'],
    criblPackRepo: 'cribl-okta-rest',
    sentinelTable: 'Okta_CL',
    sourceFormat: 'json',
  },
  'CrowdStrike Falcon Endpoint Protection': {
    elasticPackage: 'crowdstrike',
    elasticDataStreams: ['fdr', 'falcon', 'alert'],
    criblPackRepo: 'cribl_crowdstrike',
    sentinelTable: 'CommonSecurityLog',
    sourceFormat: 'json',
  },
  'Microsoft Defender XDR': {
    elasticPackage: 'microsoft_defender_endpoint',
    elasticDataStreams: ['log'],
    sentinelTable: 'SecurityAlert',
    sourceFormat: 'json',
  },
  'Microsoft Exchange': {
    elasticPackage: 'exchange_server',
    elasticDataStreams: ['httpproxy', 'messagetracking'],
    sentinelTable: 'W3CIISLog',
    sourceFormat: 'csv',
  },
  'Suricata': {
    elasticPackage: 'suricata',
    elasticDataStreams: ['eve'],
    sentinelTable: 'CommonSecurityLog',
    sourceFormat: 'json',
  },
  'Cisco Secure Endpoint': {
    elasticPackage: 'cisco_secure_endpoint',
    elasticDataStreams: ['event'],
    sentinelTable: 'CommonSecurityLog',
    sourceFormat: 'json',
  },
  'PingID': {
    sentinelTable: 'PingID_CL',
    sourceFormat: 'json',
  },
  'PingFederate': {
    elasticPackage: 'ping_federate',
    elasticDataStreams: ['log'],
    sentinelTable: 'CommonSecurityLog',
    sourceFormat: 'json',
  },
  'CircleCI': {
    sentinelTable: 'CircleCI_CL',
    sourceFormat: 'json',
  },
  'PaperCut': {
    sentinelTable: 'Syslog',
    sourceFormat: 'syslog',
  },
  'Cisco Secure Application': {
    elasticPackage: 'cisco_duo',
    elasticDataStreams: ['admin'],
    sentinelTable: 'CommonSecurityLog',
    sourceFormat: 'json',
  },
  // Additional commonly mapped Solutions
  'Fortinet FortiGate': {
    elasticPackage: 'fortinet_fortigate',
    elasticDataStreams: ['log'],
    criblPackRepo: 'cribl-fortinet-fortigate-firewall',
    sentinelTable: 'CommonSecurityLog',
    sourceFormat: 'kv',
  },
  'Palo Alto Networks': {
    elasticPackage: 'panw',
    elasticDataStreams: ['panos'],
    criblPackRepo: 'cribl-palo-alto-networks',
    sentinelTable: 'CommonSecurityLog',
    sourceFormat: 'csv',
  },
};

// Fuzzy lookup: normalize solution name and check map, then try Elastic fuzzy match
function lookupSolution(solutionName: string): SampleSourceEntry | null {
  // Exact match
  if (SOLUTION_SAMPLE_MAP[solutionName]) return SOLUTION_SAMPLE_MAP[solutionName];
  // Case-insensitive match
  const lower = solutionName.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [key, val] of Object.entries(SOLUTION_SAMPLE_MAP)) {
    if (key.toLowerCase().replace(/[^a-z0-9]/g, '') === lower) return val;
  }
  // Substring match
  for (const [key, val] of Object.entries(SOLUTION_SAMPLE_MAP)) {
    const kl = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (kl.includes(lower) || lower.includes(kl)) return val;
  }
  // Word overlap match: split original name by separators and check for shared words
  const solWords = solutionName.toLowerCase().split(/[\s\-_]+/).filter((w) => w.length >= 3);
  for (const [key, val] of Object.entries(SOLUTION_SAMPLE_MAP)) {
    const keyWords = key.toLowerCase().split(/[\s\-_]+/).filter((w) => w.length >= 3);
    // Check if any solution word is contained in any key word or vice versa
    const shared = solWords.filter((sw) => keyWords.some((kw) => kw.includes(sw) || sw.includes(kw)));
    if (shared.length >= 1) return val;
  }
  return null;
}

// Async lookup that also tries fuzzy matching against the full Elastic package index
async function lookupSolutionAsync(solutionName: string): Promise<SampleSourceEntry | null> {
  const staticMatch = lookupSolution(solutionName);
  if (staticMatch) return staticMatch;

  // Try fuzzy matching against the cached Elastic package list
  const packageNames = await fetchElasticPackageNames();
  if (packageNames.length === 0) return null;

  const matched = fuzzyMatchElasticPackage(solutionName, packageNames);
  if (!matched) return null;

  // Discover available data streams for the matched package
  const streams = await discoverDataStreams(matched);

  return {
    elasticPackage: matched,
    elasticDataStreams: streams,
    sentinelTable: 'CommonSecurityLog',
    sourceFormat: 'json',
  };
}

// ---------------------------------------------------------------------------
// Elastic Package Index -- for fuzzy matching unmapped solutions
// ---------------------------------------------------------------------------

// Cache of all Elastic integration package names (~434 packages)
let cachedPackageNames: string[] = [];
let packageNamesFetchedAt = 0;
const PACKAGE_NAMES_TTL = 24 * 60 * 60 * 1000; // 24h

/** Fetch the list of all package directory names from the Elastic integrations repo. */
async function fetchElasticPackageNames(): Promise<string[]> {
  // Return cached if fresh
  if (cachedPackageNames.length > 0 && (Date.now() - packageNamesFetchedAt) < PACKAGE_NAMES_TTL) {
    return cachedPackageNames;
  }

  // Check local cache file
  const cacheFile = path.join(getElasticCacheDir(), 'package-index.json');
  if (fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      if (cached.fetchedAt && (Date.now() - cached.fetchedAt) < PACKAGE_NAMES_TTL && Array.isArray(cached.names)) {
        cachedPackageNames = cached.names;
        packageNamesFetchedAt = cached.fetchedAt;
        return cachedPackageNames;
      }
    } catch { /* re-fetch */ }
  }

  // Fetch from GitHub API
  try {
    const { net } = await import('electron');
    const { loadGitHubPat } = await import('./auth');
    const pat = loadGitHubPat();
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Cribl-Microsoft-Integration',
    };
    if (pat) headers['Authorization'] = `Bearer ${pat}`;

    const resp = await net.fetch(`${ELASTIC_API_BASE}/packages`, { headers });
    if (!resp.ok) return cachedPackageNames; // keep stale cache

    const entries: Array<{ name: string; type: string }> = await resp.json() as any;
    const names = entries.filter((e) => e.type === 'dir').map((e) => e.name).sort();

    // Save to cache
    cachedPackageNames = names;
    packageNamesFetchedAt = Date.now();
    try {
      fs.writeFileSync(cacheFile, JSON.stringify({ names, fetchedAt: Date.now() }));
    } catch { /* non-fatal */ }

    return names;
  } catch {
    return cachedPackageNames; // keep stale cache on error
  }
}

/** Discover available data stream names for an Elastic package. */
async function discoverDataStreams(packageName: string): Promise<string[]> {
  try {
    const { net } = await import('electron');
    const { loadGitHubPat } = await import('./auth');
    const pat = loadGitHubPat();
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Cribl-Microsoft-Integration',
    };
    if (pat) headers['Authorization'] = `Bearer ${pat}`;

    const resp = await net.fetch(`${ELASTIC_API_BASE}/packages/${packageName}/data_stream`, { headers });
    if (!resp.ok) return ['log']; // default fallback

    const entries: Array<{ name: string; type: string }> = await resp.json() as any;
    const streams = entries.filter((e) => e.type === 'dir').map((e) => e.name);
    return streams.length > 0 ? streams : ['log'];
  } catch {
    return ['log'];
  }
}

// Common suffixes to strip from Sentinel solution names for fuzzy matching
const STRIP_SUFFIXES = [
  'endpoint protection', 'security events', 'single sign-on', 'sign on',
  'internet access', 'secure endpoint', 'threat protection',
  'for microsoft sentinel', 'for sentinel', 'for azure',
  'solution', 'connector', 'integration',
];

/** Fuzzy match a Sentinel solution name to an Elastic integration package name. */
function fuzzyMatchElasticPackage(solutionName: string, packageNames: string[]): string | null {
  // Normalize solution name: lowercase, strip common suffixes, remove non-alphanumeric
  let normalized = solutionName.toLowerCase();
  for (const suffix of STRIP_SUFFIXES) {
    normalized = normalized.replace(new RegExp(`\\s*${suffix}\\s*`, 'gi'), ' ');
  }
  normalized = normalized.replace(/[^a-z0-9\s]/g, '').trim();
  const solWords = normalized.split(/\s+/).filter((w) => w.length >= 2);
  const solJoined = solWords.join('');

  let bestMatch: string | null = null;
  let bestScore = 0;

  for (const pkg of packageNames) {
    const pkgNorm = pkg.replace(/[_-]/g, '').toLowerCase();
    let score = 0;

    // Exact normalized match
    if (pkgNorm === solJoined) return pkg;

    // Check if package name is contained in solution name or vice versa
    if (solJoined.includes(pkgNorm) && pkgNorm.length >= 4) {
      score += pkgNorm.length * 2;
    } else if (pkgNorm.includes(solJoined) && solJoined.length >= 4) {
      score += solJoined.length * 2;
    }

    // Word overlap: how many solution words appear in the package name
    for (const word of solWords) {
      if (word.length >= 3 && pkgNorm.includes(word)) {
        score += word.length;
      }
    }

    // Package word overlap: split package by _ or - and check against solution
    const pkgWords = pkg.split(/[_-]/).filter((w) => w.length >= 3);
    for (const pw of pkgWords) {
      if (solJoined.includes(pw.toLowerCase())) {
        score += pw.length;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = pkg;
    }
  }

  // Require a minimum score to avoid false positives
  // Score of 6+ means at least a 3-letter word matched bidirectionally
  return bestScore >= 6 ? bestMatch : null;
}

// ---------------------------------------------------------------------------
// Elastic Integrations -- On-Demand Fetch (no git clone)
// Fetches test pipeline data per vendor from GitHub API, caches locally.
// The full repo is ~8GB and too large to clone. Instead we fetch only the
// specific vendor packages needed when the user browses samples.
// ---------------------------------------------------------------------------

const ELASTIC_RAW_BASE = 'https://raw.githubusercontent.com/elastic/integrations/main';
const ELASTIC_API_BASE = 'https://api.github.com/repos/elastic/integrations/contents';

let elasticStatus: ElasticRepoStatus = {
  state: 'ready', localPath: '', lastUpdated: 0, packageCount: 434, error: '',
};

function getElasticCacheDir(): string {
  const appData = process.env.APPDATA || process.env.HOME || '';
  const dir = path.join(appData, '.cribl-microsoft', 'elastic-samples');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function broadcastElasticStatus(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('elastic-repo:status', elasticStatus);
    }
  }
}

function getElasticStatusPath(): string {
  return path.join(getElasticCacheDir(), 'status.json');
}

function loadElasticStatus(): void {
  const statusPath = getElasticStatusPath();
  if (fs.existsSync(statusPath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
      elasticStatus = { ...elasticStatus, ...saved, state: saved.packageCount > 0 ? 'ready' : 'not_cloned' };
    } catch { /* defaults */ }
  }
}

function saveElasticStatus(): void {
  try {
    fs.writeFileSync(getElasticStatusPath(), JSON.stringify({
      lastUpdated: elasticStatus.lastUpdated,
      packageCount: elasticStatus.packageCount,
    }, null, 2));
  } catch { /* non-fatal */ }
}

export function isElasticRepoReady(): boolean {
  return elasticStatus.packageCount > 0;
}

// Fetch test pipeline files for a specific Elastic package + data stream.
// Caches results locally with 24h TTL.
async function fetchElasticTestFiles(
  packageName: string,
  dataStream: string,
): Promise<Array<{ fileName: string; content: string }>> {
  const cacheDir = path.join(getElasticCacheDir(), packageName, dataStream);
  const cacheMeta = path.join(cacheDir, '.fetched');

  // Check cache (24h TTL)
  if (fs.existsSync(cacheMeta)) {
    try {
      const fetched = fs.readFileSync(cacheMeta, 'utf-8');
      if (Date.now() - new Date(fetched).getTime() < 24 * 60 * 60 * 1000) {
        // Read cached files
        const files = fs.readdirSync(cacheDir)
          .filter((f) => f.endsWith('.log') || (f.endsWith('.json') && f !== '.fetched'));
        return files.map((f) => ({
          fileName: f,
          content: fs.readFileSync(path.join(cacheDir, f), 'utf-8'),
        }));
      }
    } catch { /* re-fetch */ }
  }

  // Fetch file listing from GitHub API
  try {
    const { net } = await import('electron');
    const apiUrl = `${ELASTIC_API_BASE}/packages/${packageName}/data_stream/${dataStream}/_dev/test/pipeline`;
    const listResp = await net.fetch(apiUrl, {
      headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'Cribl-Microsoft-Integration' },
    });

    if (!listResp.ok) return []; // data stream or test dir doesn't exist

    const entries: Array<{ name: string; type: string; download_url: string }> = await listResp.json() as any;
    const testFiles = entries.filter((e) =>
      e.type === 'file' && (
        e.name.endsWith('.log') ||
        (e.name.endsWith('.json') && !e.name.includes('-expected') && !e.name.includes('-config'))
      )
    );

    if (testFiles.length === 0) return [];

    // Download each test file
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    const results: Array<{ fileName: string; content: string }> = [];

    for (const file of testFiles) {
      try {
        const rawUrl = `${ELASTIC_RAW_BASE}/packages/${packageName}/data_stream/${dataStream}/_dev/test/pipeline/${file.name}`;
        const resp = await net.fetch(rawUrl);
        if (resp.ok) {
          const content = await resp.text();
          fs.writeFileSync(path.join(cacheDir, file.name), content);
          results.push({ fileName: file.name, content });
        }
      } catch { /* skip individual file failures */ }
    }

    // Update cache timestamp
    fs.writeFileSync(cacheMeta, new Date().toISOString());
    return results;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tier 1: Fetch Elastic Integrations Test Data (on demand)
// ---------------------------------------------------------------------------

async function fetchElasticSamples(
  packageName: string,
  dataStreams?: string[],
  sentinelTable?: string,
): Promise<ResolvedSample[]> {
  const results: ResolvedSample[] = [];
  const streams = dataStreams && dataStreams.length > 0 ? dataStreams : ['log'];

  for (const stream of streams) {
    const files = await fetchElasticTestFiles(packageName, stream);
    for (const file of files) {
      if (!file.content.trim()) continue;

      let events: string[] = [];
      const format = detectSampleFormat(file.content);

      events = parseElasticFileContent(file.content, file.fileName);

      // Unwrap nested event structures (Zscaler event:{}, Filebeat wrappers, etc.)
      events = unwrapElasticEvents(events);

      // Re-detect format after unwrapping (inner events may be different format)
      const finalFormat = events.length > 0 ? detectSampleFormat(events[0]) : format;

      if (events.length > 0) {
        results.push({
          tableName: sentinelTable || packageName,
          format: finalFormat,
          rawEvents: events.slice(0, 50),
          source: `elastic:${packageName}/${stream}/${file.fileName}`,
          tier: 'elastic',
          logType: stream,
        });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Tier 2: Fetch Cribl Pack Samples
// ---------------------------------------------------------------------------

// Cache directory for downloaded Cribl pack samples
function getCriblCacheDir(): string {
  const dir = path.join(getElasticCacheDir(), '..', 'cribl-packs-cache');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function fetchCriblSamples(repoName: string, sentinelTable: string): Promise<ResolvedSample[]> {
  const cacheDir = getCriblCacheDir();
  const repoCache = path.join(cacheDir, repoName);

  // Check cache (24h TTL)
  if (fs.existsSync(repoCache)) {
    const stat = fs.statSync(repoCache);
    if (Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000) {
      return readCachedCriblSamples(repoCache, repoName, sentinelTable);
    }
  }

  // Fetch sample file listing from GitHub API
  try {
    const { net } = await import('electron');
    const listUrl = `https://api.github.com/repos/criblpacks/${repoName}/contents/data/samples`;
    const listResp = await net.fetch(listUrl, {
      headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'Cribl-Microsoft-Integration' },
    });

    if (!listResp.ok) return [];

    const files: Array<{ name: string; download_url: string }> = await listResp.json() as any;
    const jsonFiles = files.filter((f) => f.name.endsWith('.json'));

    if (!fs.existsSync(repoCache)) fs.mkdirSync(repoCache, { recursive: true });

    // Download each sample file
    for (const file of jsonFiles) {
      const rawUrl = `${CRIBL_RAW_BASE}/${repoName}/main/data/samples/${file.name}`;
      try {
        const resp = await net.fetch(rawUrl);
        if (resp.ok) {
          const content = await resp.text();
          fs.writeFileSync(path.join(repoCache, file.name), content);
        }
      } catch { /* skip individual file failures */ }
    }

    // Update cache timestamp
    if (fs.existsSync(repoCache)) {
      const touchFile = path.join(repoCache, '.fetched');
      fs.writeFileSync(touchFile, new Date().toISOString());
    }

    return readCachedCriblSamples(repoCache, repoName, sentinelTable);
  } catch {
    return [];
  }
}

function readCachedCriblSamples(cacheDir: string, repoName: string, sentinelTable: string): ResolvedSample[] {
  const results: ResolvedSample[] = [];

  const files = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(cacheDir, file), 'utf-8');
      const parsed = JSON.parse(content);
      const events = Array.isArray(parsed) ? parsed : [parsed];

      // Cribl pack samples are in envelope format: { _raw, _time, source, sourcetype }
      const rawEvents: string[] = [];
      for (const evt of events.slice(0, 50)) {
        if (typeof evt === 'object' && evt._raw) {
          rawEvents.push(typeof evt._raw === 'string' ? evt._raw : JSON.stringify(evt._raw));
        } else {
          rawEvents.push(typeof evt === 'string' ? evt : JSON.stringify(evt));
        }
      }

      if (rawEvents.length > 0) {
        const format = detectSampleFormat(rawEvents[0]);
        results.push({
          tableName: sentinelTable,
          format,
          rawEvents,
          source: `cribl:${repoName}/${file}`,
          tier: 'cribl',
          logType: file.replace('.json', ''),
        });
      }
    } catch { /* skip */ }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Tier 3: Synthesize from Analytics Rules + Vendor Registry
// ---------------------------------------------------------------------------

async function synthesizeSamples(
  solutionName: string,
  entry: SampleSourceEntry,
): Promise<ResolvedSample[]> {
  try {
    const sentinelRepo = await import('./sentinel-repo');
    if (!sentinelRepo.isRepoReady()) return [];

    // Get analytics rules for this solution to extract field names and values
    const solutions = sentinelRepo.listSolutions();
    const solNameLower = solutionName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const match = solutions.find((s) => {
      const k = s.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      return k === solNameLower || k.includes(solNameLower) || solNameLower.includes(k);
    });

    if (!match) return [];

    const rules = sentinelRepo.listAnalyticRules(match.name);
    if (rules.length === 0) return [];

    // Extract field names from KQL queries
    const kqlFields = new Set<string>();
    const kqlValues = new Map<string, string[]>(); // field -> literal values from KQL

    for (const rule of rules) {
      // Collect field names from allExtractedFields
      for (const f of rule.allExtractedFields || []) {
        kqlFields.add(f);
      }

      // Parse literal values from where clauses in KQL
      const query = rule.query || '';
      // Pattern: where Field == "value" or where Field in ("a", "b")
      const eqMatches = query.matchAll(/where\s+(\w+)\s*==\s*"([^"]+)"/gi);
      for (const m of eqMatches) {
        const vals = kqlValues.get(m[1]) || [];
        vals.push(m[2]);
        kqlValues.set(m[1], vals);
      }
      const inMatches = query.matchAll(/where\s+(\w+)\s+in\s*\(([^)]+)\)/gi);
      for (const m of inMatches) {
        const vals = kqlValues.get(m[1]) || [];
        for (const v of m[2].matchAll(/"([^"]+)"/g)) {
          vals.push(v[1]);
        }
        kqlValues.set(m[1], vals);
      }
      const hasAnyMatches = query.matchAll(/where\s+(\w+)\s+has_any\s*\(([^)]+)\)/gi);
      for (const m of hasAnyMatches) {
        const vals = kqlValues.get(m[1]) || [];
        for (const v of m[2].matchAll(/"([^"]+)"/g)) {
          vals.push(v[1]);
        }
        kqlValues.set(m[1], vals);
      }
    }

    if (kqlFields.size === 0) return [];

    // Reverse-map Sentinel field names to vendor field names
    let reverseAlias: Map<string, Set<string>>;
    try {
      const fm = await import('./field-matcher');
      reverseAlias = (fm as any).REVERSE_ALIAS || new Map();
    } catch {
      reverseAlias = new Map();
    }

    // Build synthetic events using vendor field names
    const format = entry.sourceFormat || 'json';
    const events: string[] = [];
    const NUM_EVENTS = 5;

    for (let i = 0; i < NUM_EVENTS; i++) {
      const eventFields: Record<string, string> = {};

      for (const sentinelField of kqlFields) {
        // Get vendor field name via reverse alias
        const vendorNames = reverseAlias.get(sentinelField.toLowerCase());
        const fieldName = vendorNames ? [...vendorNames][0] : sentinelField;

        // Use KQL-extracted literal value if available, otherwise generate
        const literalValues = kqlValues.get(sentinelField);
        if (literalValues && literalValues.length > 0) {
          eventFields[fieldName] = literalValues[i % literalValues.length];
        } else {
          eventFields[fieldName] = generateSyntheticValue(sentinelField, i);
        }
      }

      // Serialize based on format
      events.push(serializeEvent(eventFields, format));
    }

    return [{
      tableName: entry.sentinelTable,
      format,
      rawEvents: events,
      source: `synthesized:${solutionName}`,
      tier: 'synthesized',
    }];
  } catch {
    return [];
  }
}

function generateSyntheticValue(fieldName: string, index: number): string {
  const fl = fieldName.toLowerCase();
  if (fl.includes('ip') || fl.includes('address') || fl === 'src' || fl === 'dst') {
    return fl.includes('src') || fl.includes('source')
      ? `10.${10 + index}.${1 + index}.${100 + index}`
      : `52.${168 + index}.${1 + index}.${50 + index}`;
  }
  if (fl.includes('port') || fl === 'spt' || fl === 'dpt') {
    return String(1024 + index * 1000);
  }
  if (fl.includes('user') || fl.includes('account')) return ['admin', 'jsmith', 'svc-monitor', 'jane.doe', 'backup-svc'][index % 5];
  if (fl.includes('action') || fl === 'act') return ['Allow', 'Deny', 'Drop', 'Accept', 'Block'][index % 5];
  if (fl.includes('protocol') || fl === 'proto') return ['TCP', 'UDP', 'HTTPS', 'DNS', 'ICMP'][index % 5];
  if (fl.includes('severity') || fl.includes('level')) return ['Low', 'Medium', 'High', 'Critical', 'Informational'][index % 5];
  if (fl.includes('time') || fl.includes('timestamp') || fl === 'rt') return new Date(Date.now() - index * 60000).toISOString();
  if (fl.includes('host') || fl.includes('computer') || fl.includes('device')) return `srv-${['web', 'app', 'db', 'fw', 'proxy'][index % 5]}-0${index + 1}.contoso.com`;
  if (fl.includes('process') || fl.includes('command')) return ['cmd.exe', 'powershell.exe', 'svchost.exe', 'explorer.exe', 'rundll32.exe'][index % 5];
  if (fl.includes('url') || fl.includes('request')) return `https://app.contoso.com/api/v${index + 1}/resource`;
  if (fl.includes('event') && fl.includes('id')) return String(4624 + index);
  return `value_${fieldName}_${index}`;
}

function serializeEvent(fields: Record<string, string>, format: string): string {
  switch (format) {
    case 'json':
      return JSON.stringify(fields);
    case 'cef': {
      const ext = Object.entries(fields)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      return `CEF:0|Synthetic|Product|1.0|100|Synthetic Event|5|${ext}`;
    }
    case 'kv':
      return Object.entries(fields)
        .map(([k, v]) => `${k}=${v.includes(' ') ? `"${v}"` : v}`)
        .join(' ');
    case 'syslog': {
      const msg = Object.entries(fields)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      return `<134>1 ${new Date().toISOString()} synthetic.host app - - - ${msg}`;
    }
    case 'csv':
      return Object.values(fields).join(',');
    default:
      return JSON.stringify(fields);
  }
}

// ---------------------------------------------------------------------------
// Format Detection
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Log Type Discriminator -- splits multi-type sample files into per-type entries
// ---------------------------------------------------------------------------

// PAN-OS DeviceEventClassID to human-readable log type name
const PANOS_LOG_TYPES: Record<string, string> = {
  '1': 'TRAFFIC', '2': 'THREAT', '3': 'WILDFIRE',
  '10': 'CONFIG', '12': 'SYSTEM', '15': 'HIP-MATCH',
  '16': 'IP-TAG', '17': 'USER-ID', '20': 'GLOBALPROTECT',
  '21': 'AUTHENTICATION', '22': 'DECRYPTION', '23': 'TUNNEL-INSPECTION',
  '100': 'HIPMATCH', '256': 'CORRELATION',
  '1100': 'URL-FILTERING', '1200': 'DATA-FILTERING',
  '2000': 'SCTP', '2048': 'IPTAG', '4096': 'USERID',
  '8192': 'GTP',
};

// Discriminator fields used to split a single file into multiple log types.
const DISCRIMINATOR_FIELDS = [
  'event_simpleName',   // CrowdStrike FDR
  'type',               // PAN-OS (TRAFFIC, THREAT, SYSTEM, etc.)
  'subtype',            // PAN-OS secondary discriminator
  'DeviceEventClassID', // CEF standard
  'Activity',           // CEF/Sentinel
  'eventType',          // Okta, generic
  'EventType',          // Azure
  'log_type',           // Fortinet
  'logType',            // Generic
  'category',           // Cloudflare, generic
  'dataset',            // Cloudflare Logpush
  'sourcetype',         // Splunk-style
  'action',             // Firewall logs
];

interface SplitSample {
  logType: string;
  rawEvents: string[];
  format: string;
  eventCount: number;
}

/**
 * Split raw events by discriminator field into per-log-type groups.
 * If no discriminator is found, returns a single group with the fallback logType.
 */
/**
 * Quick KV parser: extracts key=value and key="quoted value" pairs from a line.
 * Used for discriminator detection, not full field parsing.
 */
function parseKvLine(line: string): Record<string, string> {
  const fields: Record<string, string> = {};
  // Strip syslog priority prefix if present (e.g., <190>)
  const cleaned = line.replace(/^<\d+>/, '');
  // Match key=value and key="quoted value" pairs
  const re = /(\w+)=(?:"([^"]*)"|([\S]*))/g;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    fields[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return fields;
}

function splitSamplesByLogType(rawEvents: string[], fallbackLogType: string, format: string): SplitSample[] {
  // Parse events into objects for field inspection
  const eventObjects: Array<Record<string, unknown>> = [];
  for (const raw of rawEvents) {
    try { eventObjects.push(JSON.parse(raw)); } catch {
      // Try KV parsing for formats like Fortinet (date=2019-05-10 type="traffic" ...)
      if (/\w+=/.test(raw)) {
        const kvFields = parseKvLine(raw);
        if (Object.keys(kvFields).length >= 3) {
          eventObjects.push(kvFields);
        }
      }
    }
  }

  // If we couldn't parse any events, try CSV-style parsing (PAN-OS CSV logs)
  if (eventObjects.length === 0 && rawEvents.length > 0) {
    // Check if CSV with a known type field in position
    // PAN-OS CSV: field[3] is the log type (TRAFFIC, THREAT, CONFIG, etc.)
    const firstLine = rawEvents[0];
    if (firstLine.includes(',') && !firstLine.startsWith('{')) {
      const groups = new Map<string, string[]>();
      for (const line of rawEvents) {
        const fields = line.split(',');
        // PAN-OS CSV: type is typically at index 3
        let logType = (fields[3] || '').trim().toUpperCase();
        if (!logType || logType.length > 30) logType = fallbackLogType;
        if (!groups.has(logType)) groups.set(logType, []);
        groups.get(logType)!.push(line);
      }
      if (groups.size > 1 || (groups.size === 1 && !groups.has(fallbackLogType))) {
        return [...groups.entries()].map(([logType, events]) => ({
          logType,
          rawEvents: events,
          format,
          eventCount: events.length,
        }));
      }
    }
    return [{ logType: fallbackLogType, rawEvents, format, eventCount: rawEvents.length }];
  }

  if (eventObjects.length === 0) {
    return [{ logType: fallbackLogType, rawEvents, format, eventCount: rawEvents.length }];
  }

  // Find the best discriminator field
  let discriminator = '';
  for (const field of DISCRIMINATOR_FIELDS) {
    const values = new Set<string>();
    for (const evt of eventObjects) {
      if (evt[field] !== undefined && evt[field] !== null && evt[field] !== '') {
        values.add(String(evt[field]));
      }
    }
    if (values.size >= 2 || (values.size === 1 && DISCRIMINATOR_FIELDS.indexOf(field) < 6)) {
      discriminator = field;
      break;
    }
  }

  if (!discriminator) {
    // Try filename-based type from the fallback (e.g., "test-panw-panos-traffic-sample" -> "TRAFFIC")
    return [{ logType: fallbackLogType, rawEvents, format, eventCount: rawEvents.length }];
  }

  // Split by discriminator
  const groups = new Map<string, string[]>();
  for (let i = 0; i < eventObjects.length; i++) {
    let val = String(eventObjects[i][discriminator] || 'unknown');
    // Map PAN-OS numeric IDs to names
    if (discriminator === 'DeviceEventClassID' && PANOS_LOG_TYPES[val]) {
      val = PANOS_LOG_TYPES[val];
    }
    // Clean up
    val = val.replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '_').replace(/^_+|_+$/g, '') || 'default';
    if (!groups.has(val)) groups.set(val, []);
    groups.get(val)!.push(rawEvents[i] || JSON.stringify(eventObjects[i]));
  }

  return [...groups.entries()].map(([logType, events]) => ({
    logType: logType.toUpperCase(),
    rawEvents: events,
    format,
    eventCount: events.length,
  }));
}

/**
 * Extract a human-readable log type from an Elastic test filename.
 * "test-panw-panos-traffic-sample.log" -> "traffic"
 * "test-panw-panos-inc-other-sample.log" -> "inc-other"
 */
function logTypeFromFilename(fileName: string, packageName: string): string {
  let name = fileName
    .replace(/\.[^.]+$/, '')           // remove extension
    .replace(/^test[-_]/, '')          // remove "test-" prefix
    .replace(/[-_]sample$/, '');       // remove "-sample" suffix
  // Remove package name prefix (e.g., "panw-panos-")
  const pkgParts = packageName.split(/[_-]/);
  for (const part of pkgParts) {
    name = name.replace(new RegExp(`^${part}[-_]?`, 'i'), '');
  }
  return name || 'default';
}

// ---------------------------------------------------------------------------
// PAN-OS CSV Header Mapping
// PAN-OS logs are CSV without headers. The column order is documented by
// Palo Alto per log type. We apply the correct headers so downstream
// field mapping can work with named fields instead of _0, _1, _2.
// Ref: https://docs.paloaltonetworks.com/pan-os/11-0/pan-os-admin/monitoring/use-syslog-for-monitoring/syslog-field-descriptions
// ---------------------------------------------------------------------------

const PANOS_CSV_HEADERS: Record<string, string[]> = {
  TRAFFIC: [
    'future_use1','receive_time','serial','type','subtype','future_use2','generated_time',
    'src','dst','natsrc','natdst','rule','srcuser','dstuser','app','vsys','from','to',
    'inbound_if','outbound_if','logset','future_use3','sessionid','repeatcnt','sport','dport',
    'natsport','natdport','flags','proto','action','bytes','bytes_sent','bytes_received',
    'packets','start','elapsed','category','future_use4','seqno','actionflags','srcloc',
    'dstloc','future_use5','pkts_sent','pkts_received','session_end_reason',
    'dg_hier_level_1','dg_hier_level_2','dg_hier_level_3','dg_hier_level_4',
    'vsys_name','device_name','action_source','src_uuid','dst_uuid','tunnelid_imsi',
    'monitortag_imei','parent_session_id','parent_start_time','tunnel','assoc_id',
    'chunks','chunks_sent','chunks_received','rule_uuid','http2_connection',
    'link_change_count','policy_id','link_switches','sdwan_cluster','sdwan_device_type',
    'sdwan_cluster_type','sdwan_site','dynusergroup_name','xff','src_category',
    'src_profile','src_model','src_vendor','src_osfamily','src_osversion','src_host',
    'src_mac','dst_category','dst_profile','dst_model','dst_vendor','dst_osfamily',
    'dst_osversion','dst_host','dst_mac','container_id','pod_namespace','pod_name',
    'src_edl','dst_edl','hostid','serialnumber','domain_edl','src_dag','dst_dag',
    'session_owner','high_res_timestamp','a_slice_service_type','a_slice_differentiator',
    'application_subcategory','application_category','application_technology',
    'application_risk','application_characteristic','application_container',
    'tunneled_app','application_saas','application_sanctioned_state',
  ],
  THREAT: [
    'future_use1','receive_time','serial','type','subtype','future_use2','generated_time',
    'src','dst','natsrc','natdst','rule','srcuser','dstuser','app','vsys','from','to',
    'inbound_if','outbound_if','logset','future_use3','sessionid','repeatcnt','sport','dport',
    'natsport','natdport','flags','proto','action','misc','threatid','category','severity',
    'direction','seqno','actionflags','srcloc','dstloc','future_use4','contenttype',
    'pcap_id','filedigest','cloud','url_idx','user_agent','filetype','xff',
    'referer','sender','subject','recipient','reportid','dg_hier_level_1',
    'dg_hier_level_2','dg_hier_level_3','dg_hier_level_4','vsys_name','device_name',
    'future_use5','src_uuid','dst_uuid','http_method','tunnel_id_imsi',
    'monitortag_imei','parent_session_id','parent_start_time','tunnel',
    'thr_category','contentver','future_use6','assoc_id','ppid','http_headers',
    'url_category_list','rule_uuid','http2_connection','dynusergroup_name',
    'xff_ip','src_category','src_profile','src_model','src_vendor','src_osfamily',
    'src_osversion','src_host','src_mac','dst_category','dst_profile','dst_model',
    'dst_vendor','dst_osfamily','dst_osversion','dst_host','dst_mac','container_id',
    'pod_namespace','pod_name','src_edl','dst_edl','hostid','serialnumber',
    'domain_edl','src_dag','dst_dag','partial_hash','high_res_timestamp',
    'reason','justification','nssai_sst','subcategory_of_app','category_of_app',
    'technology_of_app','risk_of_app','characteristic_of_app','container_of_app',
    'tunneled_app','saas_of_app','sanctioned_state_of_app',
  ],
  SYSTEM: [
    'future_use1','receive_time','serial','type','subtype','future_use2','generated_time',
    'vsys','eventid','object','future_use3','future_use4','module','severity','opaque',
    'seqno','actionflags','dg_hier_level_1','dg_hier_level_2','dg_hier_level_3',
    'dg_hier_level_4','vsys_name','device_name','future_use5','high_res_timestamp',
  ],
  CONFIG: [
    'future_use1','receive_time','serial','type','subtype','future_use2','generated_time',
    'host','vsys','cmd','admin','client','result','path','before_change_detail',
    'after_change_detail','seqno','actionflags','dg_hier_level_1','dg_hier_level_2',
    'dg_hier_level_3','dg_hier_level_4','vsys_name','device_name','future_use3',
    'high_res_timestamp',
  ],
  GLOBALPROTECT: [
    'future_use1','receive_time','serial','type','subtype','future_use2','generated_time',
    'vsys','eventid','stage','auth_method','tunnel_type','srcuser','srcregion','machinename',
    'public_ip','public_ipv6','private_ip','private_ipv6','hostid','serialnumber',
    'client_ver','client_os','client_os_ver','repeatcnt','reason','error','opaque',
    'status','location','login_duration','connect_method','error_code','portal',
    'seqno','actionflags','selection_type','response_time','priority','attempted_gateways',
    'gateway','dg_hier_level_1','dg_hier_level_2','dg_hier_level_3','dg_hier_level_4',
    'vsys_name','device_name','vsys_id','high_res_timestamp',
  ],
  AUTHENTICATION: [
    'future_use1','receive_time','serial','type','subtype','future_use2','generated_time',
    'vsys','ip','user','normalize_user','object','authpolicy','repeatcnt','authid',
    'vendor','logset','serverprofile','desc','clienttype','event','factorno',
    'seqno','actionflags','dg_hier_level_1','dg_hier_level_2','dg_hier_level_3',
    'dg_hier_level_4','vsys_name','device_name','vsys_id','authproto',
    'rule_uuid','high_res_timestamp','src_category','src_profile','src_model',
    'src_vendor','src_osfamily','src_osversion','src_host','src_mac',
    'region','future_use3','user_agent','session_id',
  ],
  DECRYPTION: [
    'future_use1','receive_time','serial','type','subtype','future_use2','generated_time',
    'src','dst','natsrc','natdst','rule','srcuser','dstuser','app','vsys','from','to',
    'inbound_if','outbound_if','logset','future_use3','sessionid','repeatcnt','sport','dport',
    'natsport','natdport','flags','proto','action','tunnel','src_uuid','dst_uuid',
    'rule_uuid','policy_name','elliptic_curve','error_index','root_status',
    'chain_status','proxy_type','cert_serial_number','fingerprint','not_before',
    'not_after','cert_version','cert_size','cn_length','issuer_cn_length',
    'root_cn_length','sni_length','cert_flags','subject_cn','issuer_cn','root_cn',
    'sni','error','container_id','pod_namespace','pod_name',
    'src_edl','dst_edl','src_dag','dst_dag','seqno','actionflags',
    'dg_hier_level_1','dg_hier_level_2','dg_hier_level_3','dg_hier_level_4',
    'vsys_name','device_name','high_res_timestamp',
  ],
  'HIP-MATCH': [
    'future_use1','receive_time','serial','type','subtype','future_use2','generated_time',
    'srcuser','vsys','machinename','os','src','matchname','repeatcnt','matchtype',
    'future_use3','future_use4','seqno','actionflags','dg_hier_level_1',
    'dg_hier_level_2','dg_hier_level_3','dg_hier_level_4','vsys_name','device_name',
    'vsys_id','srcipv6','hostid','serialnumber','mac','high_res_timestamp',
  ],
};

/**
 * Parse a PAN-OS syslog+CSV line into a named-field object.
 * Strips the syslog header, identifies the log type from field[3],
 * and applies the appropriate CSV column headers.
 */
function parsePanosLine(line: string): { logType: string; fields: Record<string, string> } | null {
  // Strip syslog header: "Nov 30 16:09:08 PA-220 " or "<14>Nov 30 ..." prefix
  // PAN-OS CSV starts with "1," (future_use1 is always 1)
  const csvStart = line.indexOf('1,');
  if (csvStart < 0) return null;
  const csv = line.slice(csvStart);
  const values = csv.split(',');
  if (values.length < 7) return null;

  // Field[3] is the log type (TRAFFIC, THREAT, SYSTEM, CONFIG, etc.)
  const logType = (values[3] || '').toUpperCase().trim();
  const headers = PANOS_CSV_HEADERS[logType];

  const fields: Record<string, string> = {};
  if (headers) {
    for (let i = 0; i < Math.min(headers.length, values.length); i++) {
      const name = headers[i];
      const val = values[i] || '';
      // Skip empty values and future_use placeholder fields
      if (val && !name.startsWith('future_use')) {
        fields[name] = val;
      }
    }
  } else {
    // Unknown log type -- use the first fields with generic names but include the type
    fields['type'] = logType;
    for (let i = 0; i < Math.min(20, values.length); i++) {
      if (values[i]) fields[`field_${i}`] = values[i];
    }
  }

  return { logType, fields };
}

/**
 * Check if raw events look like PAN-OS syslog+CSV format.
 * PAN-OS lines contain "1,<date>,<serial>,<TYPE>," pattern.
 */
function isPanosFormat(rawEvents: string[]): boolean {
  if (rawEvents.length === 0) return false;
  // Check first non-empty line for PAN-OS pattern
  const first = rawEvents.find((l) => l.trim()) || '';
  return /1,\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2},\d+,(TRAFFIC|THREAT|SYSTEM|CONFIG|GLOBALPROTECT|AUTHENTICATION|DECRYPTION|HIP-MATCH|CORRELATION|GTP|SCTP|TUNNEL|USERID|IPTAG|HIPMATCH|WILDFIRE|URL|DATA)/i.test(first);
}

/**
 * Convert PAN-OS syslog+CSV raw events into JSON objects with named fields.
 * Returns the converted events and the detected log type.
 */
function convertPanosToJson(rawEvents: string[]): { events: string[]; logType: string } {
  const results: string[] = [];
  let detectedType = '';
  for (const line of rawEvents) {
    const parsed = parsePanosLine(line);
    if (parsed) {
      if (!detectedType) detectedType = parsed.logType;
      results.push(JSON.stringify(parsed.fields));
    }
  }
  return { events: results.length > 0 ? results : rawEvents, logType: detectedType };
}

/**
 * Check if raw events have self-describing named fields.
 * Returns false for raw CSV (produces _0,_1,_2), syslog-wrapped CSV,
 * or any format that doesn't carry field names in the data itself.
 * Returns true for JSON, KV, CEF, LEEF, or CSV with a header row.
 */
function hasNamedFields(rawEvents: string[], format: string): boolean {
  // CEF and LEEF always have named fields in the extension
  if (format === 'cef' || format === 'leef') return true;
  // KV (key=value) always has named fields
  if (format === 'kv') return true;

  // For JSON/NDJSON: check if field names are meaningful (not _0, _1, etc.)
  if (format === 'json' || format === 'ndjson') {
    const first = rawEvents.find((e) => e.trim());
    if (!first) return false;
    try {
      const obj = JSON.parse(first);
      if (typeof obj !== 'object' || obj === null) return false;
      const keys = Object.keys(obj);
      // If most keys are numeric indices (_0, _1) or just numbers, it's a headerless CSV parse
      const numericKeys = keys.filter((k) => /^_?\d+$/.test(k));
      return numericKeys.length < keys.length * 0.5; // less than half numeric = has named fields
    } catch {
      return false;
    }
  }

  // For CSV: check if first line looks like a header row (non-numeric, non-date values)
  if (format === 'csv') {
    const first = rawEvents.find((e) => e.trim());
    if (!first) return false;
    const fields = first.split(',').map((f) => f.trim().replace(/^["']|["']$/g, ''));
    // A header row has mostly alphabetic field names
    const alphaFields = fields.filter((f) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(f));
    return alphaFields.length >= fields.length * 0.5;
  }

  // Syslog: check if it's syslog-wrapped CSV (PAN-OS style) vs structured syslog (key=value)
  if (format === 'syslog' || format === 'unknown') {
    const first = rawEvents.find((e) => e.trim()) || '';
    // PAN-OS syslog+CSV: we have header mappings for this, so it counts as named
    if (isPanosFormat(rawEvents)) return true;
    // If the line contains key=value pairs after the syslog header, it has named fields
    if (/\w+=\S/.test(first)) return true;
    // CEF inside syslog
    if (first.includes('CEF:')) return true;
    // Otherwise it's raw syslog without structure -- no named fields
    return false;
  }

  return false;
}

/**
 * Unwrap nested event structures common in Elastic test samples.
 * Many vendors wrap the actual event data inside an envelope:
 *   - Zscaler: {"version":"v11","sourcetype":"zscalernss-web","event":{...fields...}}
 *   - Filebeat: {"@timestamp":"...","message":"...raw log line...","log":{}}
 *   - Wrapper arrays: {"events":[{...},{...}]}
 *
 * This function extracts the inner event data so field mapping works on
 * the actual vendor fields (action, host, src, etc.) instead of the wrapper.
 */
function unwrapElasticEvents(rawEvents: string[]): string[] {
  const unwrapped: string[] = [];

  for (const raw of rawEvents) {
    try {
      const obj = JSON.parse(raw);
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
        unwrapped.push(raw);
        continue;
      }

      // Pattern 1: {"events":[...]} array wrapper -- expand to individual events
      if (Array.isArray(obj.events)) {
        for (const evt of obj.events) {
          if (typeof evt === 'object' && evt !== null) {
            const inner = extractInnerEvent(evt);
            if (inner === null && typeof evt.message === 'string') {
              // Filebeat envelope -- use the raw message string directly
              unwrapped.push(evt.message);
            } else if (inner) {
              unwrapped.push(JSON.stringify(inner));
            } else {
              unwrapped.push(JSON.stringify(evt));
            }
          } else {
            unwrapped.push(typeof evt === 'string' ? evt : JSON.stringify(evt));
          }
        }
        continue;
      }

      // Pattern 2: Envelope with inner event object or raw message string
      const inner = extractInnerEvent(obj);
      if (inner === null && typeof obj.message === 'string') {
        // Filebeat envelope -- use the raw message string directly
        unwrapped.push(obj.message as string);
      } else if (inner) {
        unwrapped.push(JSON.stringify(inner));
      } else {
        unwrapped.push(raw);
      }
    } catch {
      unwrapped.push(raw); // not JSON, keep as-is
    }
  }

  return unwrapped;
}

/**
 * Extract the inner event from a wrapper object.
 * Looks for common wrapper patterns and returns the most field-rich object.
 * Returns null if the inner event is a raw string (syslog/CSV) that should
 * be used as-is instead of a JSON object.
 */
function extractInnerEvent(obj: Record<string, unknown>): Record<string, unknown> | null {
  // Common wrapper fields that contain the actual event data as an object
  const objectWrapperFields = ['event', 'data', 'result', 'payload'];

  for (const field of objectWrapperFields) {
    const val = obj[field];
    if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      const innerKeys = Object.keys(val as Record<string, unknown>);
      const outerKeys = Object.keys(obj).filter((k) => k !== field);
      // Use inner if it has more fields than the outer (it's the real data)
      if (innerKeys.length > outerKeys.length) {
        return val as Record<string, unknown>;
      }
    }
  }

  // Check for Filebeat envelope: the real event is in the "message" string field.
  // This is common for PAN-OS, Cisco ASA, and other syslog-based vendors where
  // Filebeat wraps the raw log line in a JSON envelope.
  if (typeof obj.message === 'string' && obj.message.length > 10) {
    const msg = obj.message as string;
    // Check if the message is itself JSON (some vendors embed JSON in message)
    try {
      const parsed = JSON.parse(msg);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch { /* not JSON -- it's a raw log line */ }
    // Return null to signal the caller to use the raw message string directly
    return null;
  }

  // No obvious wrapper -- remove noisy Filebeat/ECS fields
  const cleaned = { ...obj };
  const noiseFields = ['@timestamp', 'log', 'tags', 'input', 'agent', 'ecs', 'host',
    'fileset', 'service', 'observer', '_metadata'];
  let removed = 0;
  for (const noise of noiseFields) {
    if (noise in cleaned && typeof cleaned[noise] === 'object') {
      delete cleaned[noise];
      removed++;
    }
  }
  if (removed > 0 && Object.keys(cleaned).length >= 3) {
    return cleaned;
  }

  return obj;
}

/**
 * Parse Elastic test file content into individual event strings.
 * Handles multiple formats found across the Elastic integrations repo:
 *   1. NDJSON: one JSON object per line (most common)
 *   2. JSON array: [{"event":...}, {"event":...}]
 *   3. Pretty-printed JSON: multi-line objects separated by newlines
 *   4. Concatenated pretty-printed objects: {...}\n{...}
 *   5. Wrapper object: {"events":[...]}
 *   6. Plain text: syslog, CEF, KV, CSV (one event per line)
 */
function parseElasticFileContent(content: string, fileName: string): string[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  // Try 1: JSON array (starts with [ )
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((e) => typeof e === 'string' ? e : JSON.stringify(e));
      }
    } catch { /* not a valid JSON array */ }
  }

  // Try 2: Single JSON object (may have wrapper like {"events":[...]} )
  if (trimmed.startsWith('{') && fileName.endsWith('.json')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.events && Array.isArray(parsed.events)) {
        return parsed.events.map((e: unknown) => typeof e === 'string' ? e : JSON.stringify(e));
      }
      return [JSON.stringify(parsed)];
    } catch { /* not a single JSON object -- try other approaches */ }
  }

  // Try 3: NDJSON or concatenated pretty-printed JSON
  if (trimmed.startsWith('{')) {
    // First try simple line split (true NDJSON)
    const lines = trimmed.split('\n').filter((l) => l.trim());
    let allJson = true;
    const ndjsonEvents: string[] = [];
    for (const line of lines) {
      const l = line.trim();
      if (!l) continue;
      try {
        JSON.parse(l);
        ndjsonEvents.push(l);
      } catch {
        allJson = false;
        break;
      }
    }
    if (allJson && ndjsonEvents.length > 0) return ndjsonEvents;

    // Not simple NDJSON -- try splitting on top-level object boundaries
    // Pattern: lines that start with '{' at column 0 begin a new object
    const chunks = trimmed.split(/\n(?=\{)/);
    const prettyEvents: string[] = [];
    for (const chunk of chunks) {
      try {
        const obj = JSON.parse(chunk.trim());
        prettyEvents.push(JSON.stringify(obj));
      } catch { /* skip unparseable chunks */ }
    }
    if (prettyEvents.length > 0) return prettyEvents;
  }

  // Try 4: Plain text (syslog, CEF, KV, CSV) -- one event per line
  return trimmed.split('\n').filter((l) => l.trim());
}

function detectSampleFormat(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith('CEF:')) return 'cef';
  if (trimmed.startsWith('LEEF:')) return 'leef';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  if (trimmed.startsWith('<') && trimmed.includes('>')) return 'syslog';
  if (/^\w+=/.test(trimmed)) return 'kv';
  // Check for syslog date prefix
  if (/^[A-Z][a-z]{2}\s+\d/.test(trimmed)) return 'syslog';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Sample Listing (metadata only, no content) -- for UI selection
// ---------------------------------------------------------------------------

export interface AvailableSample {
  id: string;           // Unique identifier for selection (e.g., "elastic:cisco_asa/log/test-cisco-asa.log")
  tier: 'sentinel-repo' | 'elastic' | 'cribl' | 'synthesized';
  source: string;       // Human-readable source label
  logType: string;      // Data stream / log type name
  format: string;       // Detected format
  eventCount: number;   // Number of events in this sample
  fileName: string;     // Original file name
  preview?: string[];   // First 2-3 raw event lines for UI display
}

export async function listAvailableSamples(solutionName: string): Promise<AvailableSample[]> {
  // Use async lookup so fuzzy Elastic matching is available
  const entry = await lookupSolutionAsync(solutionName);
  const results: AvailableSample[] = [];

  // Tier 0: Sentinel repo samples (only shown if the solution actually has sample data)
  try {
    const { findSentinelRepoSamples } = await import('./default-samples');
    const repoResult = await findSentinelRepoSamples(solutionName);
    if (repoResult.success && repoResult.samples.length > 0) {
      const seenLogTypes = new Set<string>();
      for (const s of repoResult.samples) {
        if (s.preIngested) continue;
        // Deduplicate by logType -- keep the first (highest event count) per type
        const dedupeKey = `${s.logType}`;
        if (seenLogTypes.has(dedupeKey)) continue;
        seenLogTypes.add(dedupeKey);
        const id = `sentinel-repo:${s.logType}:${s.source}`;
        results.push({
          id,
          tier: 'sentinel-repo',
          source: `Sentinel Repo: ${s.source}`,
          logType: s.logType,
          format: s.format,
          eventCount: s.eventCount,
          fileName: s.source,
          preview: (s.rawEvents || []).slice(0, 3),
        });
      }
    }
  } catch { /* Sentinel repo not available or no samples -- continue with Elastic */ }

  // Tier 1: Elastic integrations -- split each file by log type discriminator
  // Only include samples with self-describing formats (JSON, KV, CEF, LEEF, CSV with headers).
  // Raw CSV without headers or syslog-wrapped CSV produces _0,_1,_2 field names which are
  // useless for pipeline field mapping.
  if (entry?.elasticPackage) {
    try {
      const elasticSamples = await fetchElasticSamples(entry.elasticPackage, entry.elasticDataStreams);
      for (const s of elasticSamples) {
        const fileName = s.source.split('/').pop() || s.source;
        const fileLogType = logTypeFromFilename(fileName, entry.elasticPackage);
        const splits = splitSamplesByLogType(s.rawEvents, fileLogType, s.format);
        for (const split of splits) {
          // Check if events have named fields (not _0, _1, _2)
          if (!hasNamedFields(split.rawEvents, split.format)) continue;
          results.push({
            id: `${s.source}:${split.logType}`,
            tier: 'elastic',
            source: `Elastic: ${entry.elasticPackage}`,
            logType: split.logType,
            format: split.format,
            eventCount: split.eventCount,
            fileName,
            preview: split.rawEvents.slice(0, 3),
          });
        }
      }
    } catch (err) { console.error('[sample-resolver] Elastic fetch failed:', err instanceof Error ? err.message : err); }
  }

  return results;
}

// Load full sample content for specific IDs selected by the user
export async function loadSelectedSamples(
  solutionName: string,
  selectedIds: string[],
): Promise<ResolvedSample[]> {
  const entry = await lookupSolutionAsync(solutionName);
  const results: ResolvedSample[] = [];
  const idSet = new Set(selectedIds);

  // Handle sentinel-repo selections
  const sentinelIds = selectedIds.filter((id) => id.startsWith('sentinel-repo:'));
  if (sentinelIds.length > 0) {
    try {
      const { findSentinelRepoSamples } = await import('./default-samples');
      const repoResult = await findSentinelRepoSamples(solutionName);
      if (repoResult.success) {
        for (const s of repoResult.samples) {
          const sampleId = `sentinel-repo:${s.logType}:${s.source}`;
          if (idSet.has(sampleId)) {
            results.push({
              tableName: s.logType,
              format: s.format,
              rawEvents: s.rawEvents || [],
              source: `sentinel-repo:${s.source}`,
              tier: 'sentinel-repo' as any,
              logType: s.logType,
            });
          }
        }
      }
    } catch { /* Sentinel repo not available */ }
  }

  // Collect Elastic samples -- split by log type discriminator to match browse IDs
  if (entry?.elasticPackage) {
    try {
      const elastic = await fetchElasticSamples(entry.elasticPackage, entry.elasticDataStreams);
      for (const s of elastic) {
        const fileName = s.source.split('/').pop() || s.source;
        const fileLogType = logTypeFromFilename(fileName, entry.elasticPackage);
        const splits = splitSamplesByLogType(s.rawEvents, fileLogType, s.format);
        for (const split of splits) {
          const splitId = `${s.source}:${split.logType}`;
          if (idSet.has(splitId)) {
            // Convert PAN-OS syslog+CSV to JSON with named fields
            let finalEvents = split.rawEvents;
            let finalFormat = split.format;
            if (isPanosFormat(split.rawEvents)) {
              const converted = convertPanosToJson(split.rawEvents);
              finalEvents = converted.events;
              finalFormat = 'json';
            }
            results.push({
              tableName: s.tableName,
              format: finalFormat,
              rawEvents: finalEvents,
              source: splitId,
              tier: 'elastic',
              logType: split.logType,
            });
          }
        }
      }
    } catch { /* skip */ }
  }

  // Collect Cribl samples
  if (entry?.criblPackRepo) {
    try {
      const cribl = await fetchCriblSamples(entry.criblPackRepo, entry.sentinelTable);
      for (const s of cribl) {
        if (idSet.has(s.source)) {
          results.push(s);
        }
      }
    } catch { /* skip */ }
  }

  // Handle synthesized if selected
  if (entry && idSet.has(`synthesized:${solutionName}`)) {
    const synth = await synthesizeSamples(solutionName, entry);
    results.push(...synth);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main Resolution Function
// ---------------------------------------------------------------------------

export async function resolveSamples(
  solutionName: string,
  userSamples?: Array<{ logType: string; content: string; fileName: string }>,
): Promise<ResolvedSample[]> {
  // Tier 4: User-uploaded samples take highest priority
  if (userSamples && userSamples.length > 0) {
    const results: ResolvedSample[] = [];
    for (const sample of userSamples) {
      const format = detectSampleFormat(sample.content);
      let events: string[];
      if (format === 'json') {
        try {
          const parsed = JSON.parse(sample.content);
          events = Array.isArray(parsed)
            ? parsed.map((e) => typeof e === 'string' ? e : JSON.stringify(e))
            : [sample.content.trim()];
        } catch {
          events = sample.content.trim().split('\n').filter(Boolean);
        }
      } else {
        events = sample.content.trim().split('\n').filter(Boolean);
      }
      results.push({
        tableName: sample.logType || solutionName,
        format,
        rawEvents: events.slice(0, 100),
        source: `user:${sample.fileName}`,
        tier: 'user',
        logType: sample.logType,
      });
    }
    return results;
  }

  const entry = lookupSolution(solutionName);
  if (!entry) {
    // No mapping -- try synthesis only
    return synthesizeSamples(solutionName, {
      sentinelTable: 'CommonSecurityLog',
      sourceFormat: 'json',
    });
  }

  // Tier 2: Cribl packs (preferred when available -- already in envelope format)
  if (entry.criblPackRepo) {
    const criblSamples = await fetchCriblSamples(entry.criblPackRepo, entry.sentinelTable);
    if (criblSamples.length > 0) return criblSamples;
  }

  // Tier 1: Elastic integrations
  if (entry.elasticPackage && isElasticRepoReady()) {
    const elasticSamples = await fetchElasticSamples(entry.elasticPackage, entry.elasticDataStreams);
    if (elasticSamples.length > 0) return elasticSamples;
  }

  // Tier 3: Synthesize
  return synthesizeSamples(solutionName, entry);
}

// ---------------------------------------------------------------------------
// Initialization & Auto-Update
// ---------------------------------------------------------------------------

// Initialize on module load
loadElasticStatus();

// Prefetch Elastic test data for all mapped vendors.
// Downloads only the test pipeline files (~few KB each) via GitHub raw URLs.
// No git clone needed -- total download is typically under 5MB for all 22 mapped vendors.
export async function prefetchElasticSamples(): Promise<boolean> {
  // PAT required: fetching for ~20 mapped vendors with multiple data streams each
  // requires ~50+ API calls, exceeding the 60/hr unauthenticated limit quickly.
  const pat = loadGitHubPat();
  if (!pat) {
    elasticStatus.state = 'error';
    elasticStatus.error = 'GitHub Personal Access Token required. Add one on the Repositories page before fetching.';
    broadcastElasticStatus();
    return false;
  }

  elasticStatus.state = 'cloning';
  elasticStatus.error = '';
  broadcastElasticStatus();

  const entries = Object.values(SOLUTION_SAMPLE_MAP).filter((e) => e.elasticPackage);
  const uniquePackages = new Map<string, string[]>();
  for (const e of entries) {
    if (e.elasticPackage && !uniquePackages.has(e.elasticPackage)) {
      uniquePackages.set(e.elasticPackage, e.elasticDataStreams || ['log']);
    }
  }

  // Count total units of work = sum of (packages * streams per package)
  let totalWork = 0;
  for (const streams of uniquePackages.values()) totalWork += streams.length;

  const sendFetchProgress = (done: number, total: number) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('elastic-repo:fetch-progress', {
          done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0,
        });
      }
    }
  };
  sendFetchProgress(0, totalWork);

  let totalSampleFiles = 0;
  let packagesWithData = 0;
  let totalStreams = 0;
  let completed = 0;
  let lastPct = -1;
  for (const [pkg, streams] of uniquePackages) {
    let pkgHasData = false;
    for (const stream of streams) {
      try {
        const files = await fetchElasticTestFiles(pkg, stream);
        if (files.length > 0) {
          pkgHasData = true;
          totalStreams++;
          totalSampleFiles += files.length;
        }
      } catch { /* skip */ }
      completed++;
      const pct = totalWork > 0 ? Math.floor((completed / totalWork) * 100) : 100;
      if (pct !== lastPct || completed === totalWork) {
        lastPct = pct;
        sendFetchProgress(completed, totalWork);
      }
    }
    if (pkgHasData) packagesWithData++;
  }

  elasticStatus.state = 'ready';
  // packageCount field is reused to store total sample files for display purposes
  elasticStatus.packageCount = totalSampleFiles;
  elasticStatus.lastUpdated = Date.now();
  elasticStatus.error = '';
  saveElasticStatus();
  broadcastElasticStatus();

  console.log(`[elastic-repo] Prefetched ${totalSampleFiles} sample files (${totalStreams} streams across ${packagesWithData} packages)`);
  return totalSampleFiles > 0;
}

// Auto-prefetch Elastic samples if stale (>12h) or never fetched.
// Called from app startup sequence.
export async function autoUpdateElasticRepo(): Promise<boolean> {
  const twelveHours = 12 * 60 * 60 * 1000;

  if (elasticStatus.packageCount === 0 || (Date.now() - elasticStatus.lastUpdated) > twelveHours) {
    return prefetchElasticSamples();
  }

  // Already fresh
  return false;
}

// Alias for IPC handler compatibility
export async function cloneElasticRepo(): Promise<boolean> {
  return prefetchElasticSamples();
}

export async function updateElasticRepo(): Promise<boolean> {
  return prefetchElasticSamples();
}

export function initSampleResolver(): void {
  loadElasticStatus();
}

export function getElasticRepoStatus(): ElasticRepoStatus {
  return { ...elasticStatus };
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

export function registerSampleResolverHandlers(ipcMain: import('electron').IpcMain): void {
  // Query Elastic repo status
  ipcMain.handle('elastic-repo:status', async () => {
    loadElasticStatus();
    return elasticStatus;
  });

  // Clear a transient error state. Called after the user adds a GitHub PAT so that
  // prior "PAT required" errors don't linger in the UI.
  ipcMain.handle('elastic-repo:reset-error', async () => {
    if (elasticStatus.state === 'error') {
      loadElasticStatus(); // recompute state based on filesystem
    }
    elasticStatus.error = '';
    broadcastElasticStatus();
    return elasticStatus;
  });

  // Manually trigger clone/update
  ipcMain.handle('elastic-repo:clone', async () => {
    if (elasticStatus.state === 'not_cloned' || elasticStatus.state === 'error') {
      return cloneElasticRepo();
    }
    return updateElasticRepo();
  });

  // List available samples for a solution (without loading content).
  // Returns metadata the UI can present for user selection.
  ipcMain.handle('samples:list-available', async (_event, { solutionName }: { solutionName: string }) => {
    try {
      return await listAvailableSamples(solutionName);
    } catch (err) {
      console.error('[sample-resolver] listAvailableSamples error:', err instanceof Error ? err.message : err);
      return [];
    }
  });

  // Load the content for specific selected samples by their source IDs.
  ipcMain.handle('samples:load-selected', async (_event, {
    solutionName, selectedIds,
  }: {
    solutionName: string;
    selectedIds: string[];
  }) => {
    return loadSelectedSamples(solutionName, selectedIds);
  });
}
