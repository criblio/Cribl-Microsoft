// Sample Resolver Module
// Resolves raw vendor log samples for Cribl pack building using a tiered approach:
//   Tier 1: Elastic integrations test pipeline data (434+ vendors, raw vendor format)
//   Tier 2: Cribl packs sample data (20+ vendors, already in Cribl event envelope)
//   Tier 3: Synthesize from analytics rules KQL + vendor registry
//   Tier 4: User-uploaded samples (override)

import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { BrowserWindow } from 'electron';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedSample {
  tableName: string;
  format: string;         // json, cef, kv, syslog, csv, ndjson
  rawEvents: string[];    // Raw vendor event strings
  source: string;         // e.g., "elastic:cisco_asa/log" or "cribl:cribl-cisco-asa-cleanup"
  tier: 'elastic' | 'cribl' | 'synthesized' | 'user';
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

// Fuzzy lookup: normalize solution name and check map
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
  return null;
}

// ---------------------------------------------------------------------------
// Elastic Integrations Repo Management
// ---------------------------------------------------------------------------

let elasticStatus: ElasticRepoStatus = {
  state: 'not_cloned', localPath: '', lastUpdated: 0, packageCount: 0, error: '',
};

function getElasticDataDir(): string {
  const appData = process.env.APPDATA || process.env.HOME || '';
  const dir = path.join(appData, '.cribl-microsoft', 'elastic-integrations');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getElasticRepoDir(): string {
  return path.join(getElasticDataDir(), 'integrations');
}

function getElasticStatusPath(): string {
  return path.join(getElasticDataDir(), 'status.json');
}

function runGit(args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd,
      timeout: 600000,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, output: (stderr || err.message).trim() });
      else resolve({ ok: true, output: (stdout || '').trim() });
    });
  });
}

function runGitStreaming(
  args: string[], cwd: string, onOutput?: (data: string) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, { cwd, windowsHide: true });
    proc.stdout?.on('data', (data: Buffer) => onOutput?.(data.toString()));
    proc.stderr?.on('data', (data: Buffer) => onOutput?.(data.toString()));
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

function broadcastElasticStatus(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('elastic-repo:status', elasticStatus);
    }
  }
}

function loadElasticStatus(): void {
  const repoDir = getElasticRepoDir();
  const statusPath = getElasticStatusPath();

  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    elasticStatus = { state: 'not_cloned', localPath: repoDir, lastUpdated: 0, packageCount: 0, error: '' };
    return;
  }

  let saved = { lastUpdated: 0, packageCount: 0 };
  if (fs.existsSync(statusPath)) {
    try { saved = JSON.parse(fs.readFileSync(statusPath, 'utf-8')); } catch { /* defaults */ }
  }

  elasticStatus = {
    state: 'ready', localPath: repoDir,
    lastUpdated: saved.lastUpdated, packageCount: saved.packageCount, error: '',
  };
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
  return elasticStatus.state === 'ready';
}

export async function cloneElasticRepo(): Promise<boolean> {
  const dataDir = getElasticDataDir();
  const repoDir = getElasticRepoDir();

  if (fs.existsSync(repoDir)) {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }

  elasticStatus.state = 'cloning';
  elasticStatus.error = '';
  broadcastElasticStatus();

  const sendProgress = (data: string) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('elastic-repo:progress', data);
      }
    }
  };

  // Shallow clone with blob filter, sparse checkout of packages/ only
  sendProgress('Cloning Elastic integrations repository (sparse, packages only)...\n');
  const cloneOk = await runGitStreaming(
    ['clone', '--depth', '1', '--filter=blob:none', '--sparse',
     '--branch', ELASTIC_REPO_BRANCH, ELASTIC_REPO_URL, 'integrations'],
    dataDir,
    sendProgress,
  );

  if (!cloneOk) {
    elasticStatus.state = 'error';
    elasticStatus.error = 'Elastic integrations clone failed. Check network and git.';
    broadcastElasticStatus();
    return false;
  }

  // Sparse checkout: only packages/ directory
  sendProgress('Configuring sparse checkout for packages/ directory...\n');
  await runGit(['sparse-checkout', 'set', 'packages'], repoDir);

  // Count packages
  const pkgDir = path.join(repoDir, 'packages');
  if (fs.existsSync(pkgDir)) {
    const entries = fs.readdirSync(pkgDir, { withFileTypes: true });
    elasticStatus.packageCount = entries.filter((e) => e.isDirectory()).length;
  }

  elasticStatus.state = 'ready';
  elasticStatus.localPath = repoDir;
  elasticStatus.lastUpdated = Date.now();
  elasticStatus.error = '';
  saveElasticStatus();
  broadcastElasticStatus();

  sendProgress(`Clone complete. ${elasticStatus.packageCount} integration packages available.\n`);
  return true;
}

export async function updateElasticRepo(): Promise<boolean> {
  const repoDir = getElasticRepoDir();
  if (!fs.existsSync(path.join(repoDir, '.git'))) return false;

  elasticStatus.state = 'cloning'; // reuse cloning state for updates
  broadcastElasticStatus();

  const pullOk = await runGit(['pull', '--depth', '1'], repoDir);

  if (pullOk.ok) {
    elasticStatus.state = 'ready';
    elasticStatus.lastUpdated = Date.now();
    saveElasticStatus();
  } else {
    elasticStatus.state = 'ready'; // don't break on failed update
  }
  broadcastElasticStatus();
  return pullOk.ok;
}

// ---------------------------------------------------------------------------
// Tier 1: Read Elastic Integrations Test Data
// ---------------------------------------------------------------------------

function readElasticSamples(packageName: string, dataStreams?: string[]): ResolvedSample[] {
  if (!isElasticRepoReady()) return [];

  const pkgDir = path.join(getElasticRepoDir(), 'packages', packageName);
  if (!fs.existsSync(pkgDir)) return [];

  const results: ResolvedSample[] = [];

  // Find data_stream directories
  const dsDir = path.join(pkgDir, 'data_stream');
  if (!fs.existsSync(dsDir)) return [];

  const streams = fs.readdirSync(dsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const targetStreams = dataStreams && dataStreams.length > 0
    ? streams.filter((s) => dataStreams.includes(s))
    : streams;

  for (const stream of targetStreams) {
    const pipelineDir = path.join(dsDir, stream, '_dev', 'test', 'pipeline');
    if (!fs.existsSync(pipelineDir)) continue;

    const testFiles = fs.readdirSync(pipelineDir)
      .filter((f) => f.endsWith('.log') || (f.endsWith('.json') && !f.includes('-expected') && !f.includes('-config')));

    for (const testFile of testFiles) {
      try {
        const content = fs.readFileSync(path.join(pipelineDir, testFile), 'utf-8');
        if (!content.trim()) continue;

        // Parse raw events: one per line for .log, JSON array for .json
        let events: string[] = [];
        const format = detectSampleFormat(content);

        if (testFile.endsWith('.json')) {
          try {
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed)) {
              events = parsed.map((e) => typeof e === 'string' ? e : JSON.stringify(e));
            } else {
              events = [content.trim()];
            }
          } catch {
            events = content.trim().split('\n').filter(Boolean);
          }
        } else {
          // .log files: one event per line (or multi-line syslog blocks)
          events = content.trim().split('\n').filter(Boolean);
        }

        if (events.length > 0) {
          results.push({
            tableName: packageName,
            format,
            rawEvents: events.slice(0, 50), // Cap at 50 events per file
            source: `elastic:${packageName}/${stream}/${testFile}`,
            tier: 'elastic',
            logType: stream,
          });
        }
      } catch { /* skip unreadable files */ }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Tier 2: Fetch Cribl Pack Samples
// ---------------------------------------------------------------------------

// Cache directory for downloaded Cribl pack samples
function getCriblCacheDir(): string {
  const dir = path.join(getElasticDataDir(), '..', 'cribl-packs-cache');
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
  tier: 'elastic' | 'cribl' | 'synthesized';
  source: string;       // Human-readable source label
  logType: string;      // Data stream / log type name
  format: string;       // Detected format
  eventCount: number;   // Number of events in this sample
  fileName: string;     // Original file name
}

export async function listAvailableSamples(solutionName: string): Promise<AvailableSample[]> {
  const entry = lookupSolution(solutionName);
  const results: AvailableSample[] = [];

  // Tier 2: Cribl packs (list cached or fetch metadata)
  if (entry?.criblPackRepo) {
    const criblSamples = await fetchCriblSamples(entry.criblPackRepo, entry.sentinelTable);
    for (const s of criblSamples) {
      results.push({
        id: s.source,
        tier: 'cribl',
        source: `Cribl Pack: ${entry.criblPackRepo}`,
        logType: s.logType || 'default',
        format: s.format,
        eventCount: s.rawEvents.length,
        fileName: s.source.split('/').pop() || s.source,
      });
    }
  }

  // Tier 1: Elastic integrations
  if (entry?.elasticPackage && isElasticRepoReady()) {
    const elasticSamples = readElasticSamples(entry.elasticPackage, entry.elasticDataStreams);
    for (const s of elasticSamples) {
      results.push({
        id: s.source,
        tier: 'elastic',
        source: `Elastic: ${entry.elasticPackage}`,
        logType: s.logType || 'default',
        format: s.format,
        eventCount: s.rawEvents.length,
        fileName: s.source.split('/').pop() || s.source,
      });
    }
  }

  // Tier 3: Synthesized (always available as fallback)
  if (entry) {
    results.push({
      id: `synthesized:${solutionName}`,
      tier: 'synthesized',
      source: 'Synthesized from analytics rules',
      logType: entry.sentinelTable,
      format: entry.sourceFormat || 'json',
      eventCount: 5,
      fileName: `${solutionName}_synthetic.json`,
    });
  }

  return results;
}

// Load full sample content for specific IDs selected by the user
export async function loadSelectedSamples(
  solutionName: string,
  selectedIds: string[],
): Promise<ResolvedSample[]> {
  const entry = lookupSolution(solutionName);
  const results: ResolvedSample[] = [];
  const idSet = new Set(selectedIds);

  // Collect all available samples with content
  const allSamples: ResolvedSample[] = [];

  if (entry?.criblPackRepo) {
    const cribl = await fetchCriblSamples(entry.criblPackRepo, entry.sentinelTable);
    allSamples.push(...cribl);
  }
  if (entry?.elasticPackage && isElasticRepoReady()) {
    const elastic = readElasticSamples(entry.elasticPackage, entry.elasticDataStreams);
    allSamples.push(...elastic);
  }

  // Filter to only selected IDs
  for (const s of allSamples) {
    if (idSet.has(s.source)) {
      results.push(s);
    }
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
    const elasticSamples = readElasticSamples(entry.elasticPackage, entry.elasticDataStreams);
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

// Auto-clone or update the Elastic repo if stale (>12h since last update).
// Called from the app startup sequence alongside the Sentinel repo auto-update.
// Returns true if a clone or update was performed, false if skipped (already fresh).
export async function autoUpdateElasticRepo(): Promise<boolean> {
  const twelveHours = 12 * 60 * 60 * 1000;

  if (elasticStatus.state === 'not_cloned') {
    // First run: clone the repo
    const ok = await cloneElasticRepo();
    if (ok) {
      console.log(`[elastic-repo] Clone complete: ${elasticStatus.packageCount} packages`);
    } else {
      console.error(`[elastic-repo] Clone failed: ${elasticStatus.error}`);
    }
    return ok;
  }

  if (elasticStatus.state === 'ready' && (Date.now() - elasticStatus.lastUpdated) > twelveHours) {
    const ok = await updateElasticRepo();
    if (ok) {
      console.log('[elastic-repo] Update complete');
    } else {
      console.error('[elastic-repo] Update failed');
    }
    return ok;
  }

  // Already fresh
  return false;
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
    return listAvailableSamples(solutionName);
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
