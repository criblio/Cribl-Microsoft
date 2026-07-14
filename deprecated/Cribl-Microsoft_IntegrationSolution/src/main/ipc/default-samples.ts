// Default Sample Generator
// Produces realistic sample log files for any vendor log type using the
// vendor research knowledge base and field-level heuristic generation.
//
// Used when a customer doesn't have real data yet (not onboarded to Cribl,
// or can't get samples from the team managing that vendor's technology).
//
// For each vendor, discovers all log types and their fields, then generates
// N events per log type with contextually appropriate values.

import { IpcMain } from 'electron';
import crypto from 'crypto';
import { performVendorResearch, listRegisteredVendors, VendorResearchResult } from './vendor-research';
import { getAllDynamicEntries } from './registry-sync';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GeneratedSample {
  logTypeId: string;
  logTypeName: string;
  vendor: string;
  eventCount: number;
  fields: Array<{ name: string; type: string }>;
  events: Array<Record<string, unknown>>;
  rawEvents: string[];       // JSON-stringified events for pack sample files
  timestampField: string;
}

export interface VendorSampleSet {
  vendor: string;
  displayName: string;
  logTypes: GeneratedSample[];
  totalEvents: number;
  totalFields: number;
}

// ---------------------------------------------------------------------------
// Field Value Generators (contextually appropriate by name + type)
// ---------------------------------------------------------------------------

const ipPool = {
  internal: ['10.0.1.50', '10.0.2.100', '10.1.0.25', '192.168.1.100', '172.16.0.10', '10.10.5.200'],
  external: ['52.168.44.12', '104.21.35.198', '20.190.159.3', '40.126.32.68', '13.107.42.14', '151.101.1.140'],
  dns: ['8.8.8.8', '1.1.1.1', '208.67.222.222', '9.9.9.9'],
};

const hosts = ['srv-web-01', 'dc-ad-02', 'fw-edge-01', 'proxy-dmz-01', 'app-api-03', 'db-sql-01', 'wks-user-42'];
const users = ['jsmith', 'admin', 'svc-monitor', 'jane.doe', 'SYSTEM', 'backup-svc', 'apiuser01', 'kthompson'];
const domains = ['contoso.com', 'corp.fabrikam.net', 'internal.local', 'prod.company.io'];
const urls = ['/api/v2/data', '/login', '/health', '/admin/settings', '/static/app.js', '/search?q=test', '/api/auth/token'];
const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  'curl/7.88.1',
  'python-requests/2.31.0',
  'Go-http-client/2.0',
];
const httpMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'];
const protocols = ['TCP', 'UDP', 'HTTPS', 'DNS', 'ICMP', 'SSH', 'TLS', 'HTTP'];
const severities = ['Low', 'Medium', 'High', 'Critical', 'Informational'];
const actions = ['Allow', 'Deny', 'Drop', 'Block', 'Reset', 'Alert', 'Log'];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function randomTimestamp(baseMs: number, offsetRangeMs: number): string {
  return new Date(baseMs + Math.floor(Math.random() * offsetRangeMs)).toISOString();
}

function generateValue(name: string, type: string, eventIdx: number): unknown {
  const lower = name.toLowerCase();
  const baseTime = new Date('2025-06-15T14:00:00Z').getTime();
  const offset = eventIdx * 30000; // 30s between events

  // Datetime
  if (type === 'datetime' || lower.includes('time') || lower.includes('date') || lower === 'timestamp') {
    return randomTimestamp(baseTime + offset, 60000);
  }

  // Boolean
  if (type === 'boolean') return Math.random() > 0.5;

  // Numeric
  if (type === 'int' || type === 'long' || type === 'real') {
    if (lower.includes('port')) return randomInt(1, 65535);
    if (lower.includes('pid') || lower.includes('processid')) return randomInt(100, 65535);
    if (lower.includes('severity') || lower.includes('level')) return randomInt(0, 7);
    if (lower.includes('size') || lower.includes('bytes') || lower.includes('length')) return randomInt(64, 500000);
    if (lower.includes('count') || lower.includes('total')) return randomInt(1, 1000);
    if (lower.includes('duration') || lower.includes('elapsed')) return randomInt(1, 30000);
    if (lower.includes('code') || lower.includes('status')) return pick([200, 201, 301, 400, 403, 404, 500]);
    if (lower.includes('id') && !lower.includes('guid')) return randomInt(1000, 999999);
    if (type === 'real') return Math.round(Math.random() * 100 * 100) / 100;
    return randomInt(0, 10000);
  }

  // Dynamic/object
  if (type === 'dynamic') {
    if (lower.includes('metadata') || lower.includes('context')) return { key1: 'value1', key2: randomInt(1, 100) };
    if (lower.includes('location') || lower.includes('geo')) return { city: 'Seattle', state: 'WA', country: 'US' };
    if (lower.includes('evidence') || lower.includes('detail')) return [{ type: 'process', name: 'cmd.exe' }];
    return {};
  }

  // String fields by name heuristics
  if (lower.includes('ip') && !lower.includes('mac') && !lower.includes('descript')) {
    if (lower.includes('source') || lower.includes('src') || lower.includes('client') || lower.includes('local')) return pick(ipPool.internal);
    if (lower.includes('dest') || lower.includes('dst') || lower.includes('remote') || lower.includes('origin')) return pick(ipPool.external);
    if (lower.includes('dns') || lower.includes('resolver')) return pick(ipPool.dns);
    return pick([...ipPool.internal, ...ipPool.external]);
  }
  if (lower.includes('mac')) return Array.from({ length: 6 }, () => randomInt(0, 255).toString(16).padStart(2, '0')).join(':').toUpperCase();
  if (lower.includes('host') || lower.includes('computer') || lower.includes('machine')) return `${pick(hosts)}.${pick(domains)}`;
  if (lower.includes('user') || lower.includes('account') || lower.includes('identity') || lower.includes('actor')) return pick(users);
  if (lower.includes('domain') || lower.includes('realm')) return pick(domains);
  if (lower.includes('url') || lower.includes('uri') || lower.includes('href')) return `https://${pick(domains)}${pick(urls)}`;
  if (lower.includes('path') && !lower.includes('file')) return pick(urls);
  if (lower.includes('useragent') || lower.includes('user_agent')) return pick(userAgents);
  if (lower.includes('method') && (lower.includes('request') || lower.includes('http'))) return pick(httpMethods);
  if (lower.includes('protocol') || lower.includes('proto')) return pick(protocols);
  if (lower.includes('action') || lower.includes('deviceaction')) return pick(actions);
  if (lower.includes('severity') || lower.includes('priority') || lower.includes('level')) return pick(severities);
  if (lower.includes('category') || lower.includes('class') || lower.includes('type')) return pick(['Security', 'Network', 'Application', 'System', 'Authentication', 'Audit']);
  if (lower.includes('facility')) return pick(['auth', 'authpriv', 'local0', 'kern', 'daemon', 'syslog']);
  if (lower.includes('message') || lower.includes('description') || lower.includes('summary')) {
    return pick([
      'User authentication successful', 'Connection established to remote host',
      'Firewall rule applied: Allow TCP 443', 'Process started by SYSTEM',
      'File access audit: read operation', 'Policy violation detected',
      'Certificate validation passed', 'Session timeout for idle connection',
    ]);
  }
  if (lower.includes('guid') || lower.includes('uuid') || lower.includes('correlationid') || lower.includes('requestid') || lower.includes('rayid')) {
    return [crypto.randomBytes(4), crypto.randomBytes(2), crypto.randomBytes(2), crypto.randomBytes(2), crypto.randomBytes(6)]
      .map((b) => b.toString('hex')).join('-');
  }
  if (lower.includes('hash') || lower.includes('sha') || lower.includes('md5')) return crypto.randomBytes(type.includes('sha') || lower.includes('sha256') ? 32 : 16).toString('hex');
  if (lower.includes('vendor') || lower.includes('product')) {
    return lower.includes('vendor')
      ? pick(['Microsoft', 'Palo Alto Networks', 'CrowdStrike', 'Fortinet', 'Cisco', 'Cloudflare'])
      : pick(['Defender', 'PAN-OS', 'Falcon', 'FortiGate', 'ASA', 'WAF']);
  }
  if (lower.includes('version')) return `${randomInt(1, 12)}.${randomInt(0, 9)}.${randomInt(0, 99)}`;
  if (lower.includes('country') || lower.includes('region')) return pick(['US', 'GB', 'DE', 'JP', 'AU', 'CA', 'FR', 'SG']);
  if (lower.includes('zone') || lower.includes('intf') || lower.includes('interface')) return pick(['trust', 'untrust', 'dmz', 'internal', 'external', 'mgmt']);
  if (lower.includes('name') && (lower.includes('query') || lower.includes('dns'))) return pick(['example.com', 'api.contoso.com', 'login.microsoft.com', 'cdn.cloudflare.net']);
  if (lower.includes('process') || lower.includes('program') || lower.includes('app')) return pick(['svchost.exe', 'python3', 'nginx', 'java', 'powershell.exe', 'sshd']);
  if (lower.includes('file') && lower.includes('name')) return pick(['audit.log', 'system.evtx', 'data.xlsx', 'config.yaml', 'payload.exe']);

  // Generic string fallback
  return `sample_${name}_${randomInt(1, 999)}`;
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

function generateEventsForLogType(
  fields: Array<{ name: string; type: string; description?: string }>,
  eventCount: number,
): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (let i = 0; i < eventCount; i++) {
    const event: Record<string, unknown> = {};
    for (const field of fields) {
      event[field.name] = generateValue(field.name, field.type, i);
    }
    events.push(event);
  }
  return events;
}

// Generate samples for a single vendor using vendor research data
async function generateVendorSamples(
  vendorName: string,
  eventsPerLogType: number = 25,
): Promise<VendorSampleSet | null> {
  const research = await performVendorResearch(vendorName);
  if (!research || research.logTypes.length === 0) return null;

  const logTypes: GeneratedSample[] = [];

  for (const lt of research.logTypes) {
    if (lt.fields.length === 0) continue;

    const events = generateEventsForLogType(lt.fields, eventsPerLogType);
    const rawEvents = events.map((e) => JSON.stringify(e));

    // Detect timestamp field
    const tsField = lt.fields.find((f) =>
      f.type === 'datetime' || /time|date|timestamp/i.test(f.name)
    );

    logTypes.push({
      logTypeId: lt.id,
      logTypeName: lt.name,
      vendor: vendorName,
      eventCount: events.length,
      fields: lt.fields.map((f) => ({ name: f.name, type: f.type })),
      events,
      rawEvents,
      timestampField: tsField?.name || 'TimeGenerated',
    });
  }

  return {
    vendor: research.vendor,
    displayName: research.displayName,
    logTypes,
    totalEvents: logTypes.reduce((s, lt) => s + lt.eventCount, 0),
    totalFields: logTypes.reduce((s, lt) => s + lt.fields.length, 0),
  };
}

// List all vendors that have enough field data to generate samples
async function listVendorsWithSampleCapability(): Promise<Array<{
  vendor: string;
  displayName: string;
  logTypeCount: number;
  fieldCount: number;
  source: 'curated' | 'dynamic';
}>> {
  const results: Array<{
    vendor: string; displayName: string; logTypeCount: number; fieldCount: number; source: 'curated' | 'dynamic';
  }> = [];
  const seen = new Set<string>();

  // Curated vendors (have detailed field data)
  for (const v of listRegisteredVendors()) {
    const key = v.vendor.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      const research = await performVendorResearch(v.vendor);
      if (research && research.logTypes.length > 0) {
        const fieldCount = research.logTypes.reduce((s, lt) => s + lt.fields.length, 0);
        if (fieldCount > 0) {
          results.push({
            vendor: v.vendor, displayName: v.displayName,
            logTypeCount: research.logTypes.length, fieldCount,
            source: 'curated',
          });
        }
      }
    } catch { /* skip */ }
  }

  // Dynamic entries with fields
  for (const entry of getAllDynamicEntries()) {
    const key = entry.vendor.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const fieldCount = entry.logTypes.reduce((s, lt) => s + lt.fields.length, 0);
    if (fieldCount > 5) { // Only include if there's meaningful field data
      results.push({
        vendor: entry.vendor, displayName: entry.displayName,
        logTypeCount: entry.logTypes.length, fieldCount,
        source: 'dynamic',
      });
    }
  }

  return results.sort((a, b) => b.fieldCount - a.fieldCount);
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

export function registerDefaultSampleHandlers(ipcMain: IpcMain) {
  // List vendors that can generate default samples
  ipcMain.handle('samples:available-vendors', async () => {
    return listVendorsWithSampleCapability();
  });

  // Generate default samples for a vendor
  ipcMain.handle('samples:generate-defaults', async (_event, {
    vendorName, eventsPerLogType,
  }: { vendorName: string; eventsPerLogType?: number }) => {
    return generateVendorSamples(vendorName, eventsPerLogType || 25);
  });

  // List pre-built vendor sample libraries from packs/vendor-samples/
  ipcMain.handle('samples:list-libraries', async () => {
    const fs = require('fs');
    const path = require('path');
    // Find the vendor-samples directory (in repo or relative to app)
    const candidates = [
      path.join(__dirname, '..', '..', '..', 'packs', 'vendor-samples'),
      path.join(process.cwd(), 'packs', 'vendor-samples'),
    ];
    // Also check linked repo
    try {
      const appPaths = require('./app-paths');
      const repoRoot = appPaths.getLinkedRepo?.() || '';
      if (repoRoot) {
        candidates.push(path.join(repoRoot, 'Cribl-Microsoft_IntegrationSolution', 'packs', 'vendor-samples'));
      }
    } catch (e) { /* skip */ }

    for (const dir of candidates) {
      if (!fs.existsSync(dir)) continue;
      const vendors = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e: any) => e.isDirectory())
        .map((e: any) => {
          const vendorDir = path.join(dir, e.name);
          const files = fs.readdirSync(vendorDir).filter((f: string) => f.endsWith('.json'));
          const totalEvents = files.reduce((sum: number, f: string) => {
            try {
              const content = fs.readFileSync(path.join(vendorDir, f), 'utf8');
              return sum + content.split('\n').filter((l: string) => l.trim()).length;
            } catch (err) { return sum; }
          }, 0);
          return {
            vendor: e.name,
            path: vendorDir,
            files: files.map((f: string) => ({
              name: f,
              logType: f.replace(/\.json$/, '').replace(/^[A-Za-z]+_/, '').replace(/_CL$/, ''),
              path: path.join(vendorDir, f),
            })),
            totalFiles: files.length,
            totalEvents,
          };
        });
      return vendors;
    }
    return [];
  });

  // Load a specific vendor sample file and return its content
  ipcMain.handle('samples:load-library-file', async (_event, { filePath }: { filePath: string }) => {
    const fs = require('fs');
    if (!fs.existsSync(filePath)) return { success: false, error: 'File not found' };
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return { success: true, content };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Search the local Azure-Sentinel repo clone for sample data matching a
  // solution name. Scans Sample Data/, Sample Data/CEF/, Sample Data/Syslog/,
  // and vendor-specific subdirectories for JSON/CSV/NDJSON files whose names
  // fuzzy-match the solution. Returns parsed + tagged samples ready for the
  // pipeline builder.
  ipcMain.handle('samples:sentinel-repo-samples', async (_event, {
    solutionName,
  }: { solutionName: string }) => {
    return findSentinelRepoSamples(solutionName);
  });
}

// ---------------------------------------------------------------------------
// Sentinel Repo Sample Search (extracted for reuse by sample-resolver)
// ---------------------------------------------------------------------------

export async function findSentinelRepoSamples(solutionName: string): Promise<{
  success: boolean;
  samples: Array<{
    vendor: string; logType: string; format: string;
    eventCount: number; fieldCount: number; rawEvents: string[];
    timestampField: string; source: string;
    fields: Array<{ name: string; type: string; sampleValues: string[] }>;
    preIngested?: boolean;
  }>;
  skippedPreIngested: number;
  filesSearched: number;
  message: string;
  error?: string;
}> {
    const fs = require('fs');
    const path = require('path');
    const { parseSampleContent } = await import('./sample-parser');
    const { sentinelRepoDir } = await import('./app-paths');

    // Sample Data can live in two places:
    //   1. Solutions/<name>/Sample Data/ (per-solution, fetched by sentinel-repo.ts)
    //   2. Sample Data/ at repo root (only available if full repo was cloned via git)
    // We search both locations, preferring the per-solution directory.
    const repoBase = path.join(sentinelRepoDir(), 'Azure-Sentinel');
    const solutionsDir = path.join(repoBase, 'Solutions');
    const repoRootSampleData = path.join(repoBase, 'Sample Data');

    // Find the solution's own Sample Data directory by matching the solution name
    let solutionSampleDirs: string[] = [];
    if (fs.existsSync(solutionsDir)) {
      const solLower = solutionName.toLowerCase().replace(/[^a-z0-9]/g, '');
      const solWords = solutionName.toLowerCase().split(/[\s\-_]+/).filter((w) => w.length >= 3);
      try {
        const allSolutions = fs.readdirSync(solutionsDir, { withFileTypes: true })
          .filter((e: any) => e.isDirectory());
        for (const sol of allSolutions) {
          const dirLower = sol.name.toLowerCase().replace(/[^a-z0-9]/g, '');
          const dirWords = sol.name.toLowerCase().split(/[\s\-_]+/).filter((w: string) => w.length >= 3);
          // Match: exact, substring, or word overlap
          const isMatch = dirLower === solLower
            || dirLower.includes(solLower) || solLower.includes(dirLower)
            || solWords.some((sw: string) => dirWords.some((dw: string) => dw.includes(sw) || sw.includes(dw)));
          if (isMatch) {
            const sdDir = path.join(solutionsDir, sol.name, 'Sample Data');
            if (fs.existsSync(sdDir)) solutionSampleDirs.push(sdDir);
          }
        }
      } catch { /* skip */ }
    }

    // Use repo root Sample Data as fallback (full git clone only)
    const sampleRoot = solutionSampleDirs.length > 0
      ? solutionSampleDirs[0]
      : repoRootSampleData;

    if (!fs.existsSync(sampleRoot) && solutionSampleDirs.length === 0) {
      return { success: false, samples: [], skippedPreIngested: 0, filesSearched: 0, message: '', error: 'No sample data directory found for this solution.' };
    }

    // Load the solution's defined custom tables from Data Connectors.
    // This tells us exactly which tables the solution uses, so we can
    // limit sample loading to only those tables instead of every matching file.
    const solutionTables = new Set<string>();
    try {
      const { listSolutions, listConnectorFiles, readRepoFile } = await import('./sentinel-repo');
      const solutions = listSolutions();
      const solLower = solutionName.toLowerCase().replace(/[^a-z0-9]/g, '');
      const solMatch = solutions.find((s) => {
        const k = s.name.toLowerCase().replace(/[^a-z0-9]/g, '');
        return k === solLower || k.includes(solLower) || solLower.includes(k);
      });
      if (solMatch) {
        // Scan Data Connectors for CustomTables directories
        const connFiles = listConnectorFiles(solMatch.name);
        for (const f of connFiles) {
          if (f.path.includes('CustomTables') && f.name.endsWith('.json')) {
            solutionTables.add(f.name.replace('.json', ''));
          }
        }
      }
    } catch { /* non-fatal */ }
    // If solution has defined tables, we'll use them to limit discriminator splits
    const hasSolutionTables = solutionTables.size > 0;

    // Build search keywords from solution name
    // "CrowdStrike Falcon Endpoint Protection" -> ["crowdstrike", "falcon", "crowdstrikefalcon"]
    // "Palo Alto Networks" -> ["paloalto", "palo"]
    // Short words (<4 chars) like "pan", "os", "ai" are excluded from substring
    // matching to avoid false positives (e.g., "pan" matching "Company").
    const words = solutionName.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
    const keywords = words.filter((w) => w.length >= 4);
    // Add concatenated forms: "crowdstrikefalcon", "paloalto"
    if (words.length >= 2) keywords.push(words.slice(0, 2).join(''));
    if (words.length >= 3) keywords.push(words.slice(0, 3).join(''));
    keywords.push(words.join(''));

    // Vendor abbreviations and alternate names. Maps a keyword found in the
    // solution name to additional search terms for matching sample filenames.
    // Covers common vendor name variations, product names, and file prefixes
    // used in the Azure-Sentinel Sample Data directory.
    const ABBREVIATIONS: Record<string, string[]> = {
      // Firewall / Network Security
      'palo': ['paloalto', 'panos', 'cdlevent', 'paloaltopanos', 'paloaltonetworks'],
      'fortinet': ['fortigate', 'fortinet', 'forti', 'fortindr'],
      'checkpoint': ['checkpoint', 'cbs'],
      'sonicwall': ['sonicwall'],
      'watchguard': ['watchguard', 'firebox'],
      'juniper': ['juniper', 'srx'],
      'barracuda': ['barracuda', 'barracudawaf'],
      'sophos': ['sophos'],

      // Endpoint / EDR
      'crowdstrike': ['crowdstrike', 'falcon', 'cs', 'fdr'],
      'symantec': ['symantec', 'broadcom', 'sep'],
      'trend': ['trendmicro', 'trend', 'apexone'],
      'mcafee': ['mcafee', 'trellix', 'epo', 'nsp'],
      'cylance': ['cylance', 'cylanceprotect', 'blackberry'],
      'morphisec': ['morphisec'],
      'kaspersky': ['kaspersky', 'kasperskysc'],
      'fireeye': ['fireeye', 'mandiant', 'trellix'],
      'carbon': ['carbonblack', 'carbon', 'vmwarecarbon'],

      // Cloud / SaaS
      'cisco': ['cisco', 'meraki', 'asa', 'ise', 'firepower', 'stealthwatch', 'ucs', 'wsa', 'aci', 'seg'],
      'microsoft': ['microsoft', 'azure', 'defender', 'sentinel', 'copilot', 'aad', 'purview'],
      'zscaler': ['zscaler', 'zpa', 'zia'],
      'cloudflare': ['cloudflare', 'cf'],
      'okta': ['okta', 'auth0'],
      'netskope': ['netskope'],

      // Infrastructure / VM
      'vmware': ['vmware', 'esxi', 'vsphere', 'sase', 'sdwan', 'veco'],
      'citrix': ['citrix', 'citrixanalytics', 'adc'],
      'pulse': ['pulse', 'pulseconnect', 'ivanti'],
      'infoblox': ['infoblox', 'nios', 'cdc'],
      'forescout': ['forescout'],

      // SIEM / Observability
      'darktrace': ['darktrace', 'aia'],
      'vectra': ['vectra', 'vectrastream', 'aivectra'],
      'dynatrace': ['dynatrace'],
      'cribl': ['cribl'],
      'gitlab': ['gitlab', 'githubscan'],

      // IoT / OT
      'armis': ['armis'],
      'claroty': ['claroty', 'clarotydome'],
      'nozomi': ['nozomi'],
      'cynerio': ['cynerio'],
      'phosphorus': ['phosphorus'],

      // Identity / Access
      'forgerock': ['forgerock'],
      'securid': ['securid', 'rsa'],
      'delinea': ['delinea', 'thycotic'],
      'ping': ['pingfederate', 'ping'],

      // Data Protection
      'varonis': ['varonis'],
      'digital': ['digitalguardian'],
      'egress': ['egress', 'egressdefend'],
      'commvault': ['commvault', 'securityiq'],
      'talon': ['talon'],

      // Threat Intel
      'intel471': ['intel471'],
      'doppel': ['doppel'],
      'arista': ['arista', 'awake'],
      'illumio': ['illumio'],
      'mimecast': ['mimecast'],

      // Mobile / Remote
      'jamf': ['jamf', 'jamfprotect'],
      'samsung': ['samsung', 'knox'],
      'nordpass': ['nordpass'],
      'garrison': ['garrison', 'ultra'],
      'knowbe4': ['knowbe4', 'defend'],

      // Other
      'wiz': ['wiz'],
      'perimeter81': ['perimeter81'],
      'onapsis': ['onapsis'],
      'ossec': ['ossec', 'wazuh'],
      'akamai': ['akamai'],
      'apache': ['apache', 'httpserver', 'tomcat'],
      'oracle': ['oracle', 'weblogic'],
      'wirex': ['wirex'],
      'tenable': ['tenable'],
      'veeam': ['veeam'],
      'abnormal': ['abnormal'],
      'prancer': ['prancer'],
      'valence': ['valence'],
      'sevco': ['sevco'],
      'salem': ['salemcyber', 'salem'],
      'ridge': ['ridgesecurity', 'ridge'],
    };
    for (const [key, abbrs] of Object.entries(ABBREVIATIONS)) {
      if (words.some((w) => abbrs.includes(w) || w.includes(key))) {
        keywords.push(...abbrs);
      }
    }
    const uniqueKeywords = [...new Set(keywords)];

    // File name patterns to exclude (false positives from unrelated solutions)
    const EXCLUDE_PATTERNS = [
      /prismacloud/i,     // PrismaCloud != PAN-OS
      /prisma\s*cloud/i,
      /sanitized/i,       // Redacted/sanitized audit files
      /\.schema\./i,      // Schema definition files
    ];

    // Scan directories for matching files. The Sample Data directory has
    // files at the top level, plus CEF/, Syslog/, Custom/, ASIM/, and
    // vendor-specific subdirectories. ASIM/ contains _RawLogs.txt files
    // with actual raw CEF data (important for CEF-based vendors).
    const excludeDirs = new Set(['Event', 'Feeds', 'PublicFeeds',
      'SecurityEvent', 'ThreatIntelligence', 'Media', 'Sample Data']);
    const searchDirs = [
      sampleRoot,
      path.join(sampleRoot, 'CEF'),
      path.join(sampleRoot, 'Syslog'),
      path.join(sampleRoot, 'Custom'),
      path.join(sampleRoot, 'ASIM'),
    ];
    // Scan all subdirectories (vendor-specific folders at top level and under Custom/)
    const scanSubdirs = (parent: string) => {
      try {
        const entries = fs.readdirSync(parent, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !excludeDirs.has(entry.name)) {
            searchDirs.push(path.join(parent, entry.name));
          }
        }
      } catch { /* skip */ }
    };
    scanSubdirs(sampleRoot);
    scanSubdirs(path.join(sampleRoot, 'Custom'));

    const matchedFiles: Array<{ filePath: string; fileName: string; score: number }> = [];

    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      let files: string[];
      try { files = fs.readdirSync(dir); } catch { continue; }

      for (const file of files) {
        if (!/\.(json|csv|txt|ndjson)$/i.test(file)) continue;
        // Skip schema files, README, and ingested logs (pre-processed)
        if (/schema|readme|_schema/i.test(file)) continue;
        // Skip false positive patterns (PrismaCloud files when searching PAN-OS, etc.)
        if (EXCLUDE_PATTERNS.some((re) => re.test(file))) continue;

        // Also check if the parent directory matches an exclusion pattern
        const dirName = path.basename(dir);
        if (EXCLUDE_PATTERNS.some((re) => re.test(dirName))) continue;

        const fileLower = file.toLowerCase().replace(/[^a-z0-9]/g, '');
        let score = 0;
        for (const kw of uniqueKeywords) {
          // Skip short keywords (<4 chars) for substring matching to avoid
          // false positives like "pan" matching "Company" or "cs" matching "docs"
          if (kw.length < 4) continue;
          if (fileLower.includes(kw)) {
            score += kw.length; // Longer keyword matches score higher
          }
        }
        if (score > 0) {
          matchedFiles.push({ filePath: path.join(dir, file), fileName: file, score });
        }
      }
    }

    // Also check the local packs/vendor-samples directory
    const localVendorSamples = [
      path.join(__dirname, '..', '..', '..', 'packs', 'vendor-samples'),
    ];
    try {
      const { getLinkedRepo } = await import('./app-paths');
      const repo = getLinkedRepo();
      if (repo) {
        localVendorSamples.push(
          path.join(repo, 'Cribl-Microsoft_IntegrationSolution', 'packs', 'vendor-samples')
        );
      }
    } catch { /* skip */ }

    for (const vendorDir of localVendorSamples) {
      if (!fs.existsSync(vendorDir)) continue;
      try {
        const vendorFolders = fs.readdirSync(vendorDir, { withFileTypes: true });
        for (const folder of vendorFolders) {
          if (!folder.isDirectory()) continue;
          const folderLower = folder.name.toLowerCase().replace(/[^a-z0-9]/g, '');
          let folderScore = 0;
          for (const kw of uniqueKeywords) {
            if (folderLower.includes(kw)) folderScore += kw.length * 2; // Boost local samples
          }
          if (folderScore === 0) continue;
          const vendorFiles = fs.readdirSync(path.join(vendorDir, folder.name));
          for (const f of vendorFiles) {
            if (!f.endsWith('.json')) continue;
            matchedFiles.push({
              filePath: path.join(vendorDir, folder.name, f),
              fileName: f,
              score: folderScore + 10, // Boost curated vendor samples
            });
          }
        }
      } catch { /* skip */ }
    }

    // Filter weak matches (score < 8) to reduce false positives from partial
    // keyword overlap (e.g., "paloalto" matching PrismaCloud subdirectory files)
    const strongMatches = matchedFiles.filter((f) => f.score >= 8);

    if (strongMatches.length === 0) {
      return { success: true, samples: [], message: `No sample data found for "${solutionName}" in Sentinel repo.` };
    }

    // Sort by score (best matches first), take top 20 files
    strongMatches.sort((a, b) => b.score - a.score);
    const topFiles = strongMatches.slice(0, 20);

    // Parse each file and build tagged samples
    const samples: Array<{
      vendor: string; logType: string; format: string;
      eventCount: number; fieldCount: number; rawEvents: string[];
      timestampField: string; source: string; fields: Array<{ name: string; type: string; sampleValues: string[] }>;
      preIngested: boolean;  // true if data is already in Sentinel schema format
    }> = [];

    // Sentinel schema fingerprint: fields that only appear in post-ingestion data.
    // If a sample has 3+ of these, it's already been transformed into the Sentinel
    // table schema and is NOT raw vendor data. Raw CEF has src/dst/spt/dpt/act,
    // while ingested data has SourceIP/DestinationIP/SourcePort/DeviceAction.
    const SENTINEL_SCHEMA_MARKERS = new Set([
      'SourceIP', 'DestinationIP', 'SourcePort', 'DestinationPort',
      'DeviceAction', 'ApplicationProtocol', 'DestinationHostName',
      'SourceTranslatedAddress', 'DestinationTranslatedAddress',
      'DeviceCustomString1', 'DeviceCustomString2', 'DeviceCustomString3',
      'DeviceCustomNumber1', 'DeviceCustomNumber2',
      'SourceUserName', 'DestinationUserName', 'AdditionalExtensions',
      'ExternalID', 'CommunicationDirection', 'DeviceAddress',
      'FlexString1', 'FlexString2', 'MaliciousIP',
      'ThreatConfidence', 'ThreatDescription', 'IndicatorThreatType',
    ]);
    const detectPreIngested = (fields: string[]): boolean => {
      let hits = 0;
      for (const f of fields) {
        if (SENTINEL_SCHEMA_MARKERS.has(f)) hits++;
        if (hits >= 3) return true;
      }
      return false;
    };

    // PAN-OS DeviceEventClassID to human-readable log type name mapping.
    // These numeric IDs appear in CEF-formatted PAN-OS sample data.
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
    // Order matters -- earlier fields are preferred.
    const DISCRIMINATORS = [
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

    for (const { filePath, fileName } of topFiles) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        if (!content.trim()) continue;

        const parsed = parseSampleContent(content, fileName);
        if (parsed.eventCount === 0) continue;

        // Preserve original raw lines from the file for CEF/LEEF/syslog formats.
        // parseSampleContent converts these to JSON objects, but the pack needs
        // the original raw lines in _raw for the pipeline serde to process.
        const originalRawLines = content.trim().split('\n').filter((l) => l.trim());
        const isCefOrLeef = parsed.format === 'cef' || parsed.format === 'leef' || parsed.format === 'syslog';

        // Try to find a discriminator field to split events by log type
        let discriminator = '';
        const eventObjects: Array<Record<string, unknown>> = [];
        for (const rawStr of parsed.rawEvents) {
          try { eventObjects.push(JSON.parse(rawStr)); } catch { /* skip */ }
        }

        if (eventObjects.length > 0) {
          for (const field of DISCRIMINATORS) {
            const values = new Set<string>();
            for (const evt of eventObjects) {
              if (evt[field] !== undefined && evt[field] !== null && evt[field] !== '') {
                values.add(String(evt[field]));
              }
            }
            // A good discriminator has 2+ distinct values, or is a known type field
            // with 1 value (single-type file)
            if (values.size >= 2 || (values.size === 1 && DISCRIMINATORS.indexOf(field) < 6)) {
              discriminator = field;
              break;
            }
          }
        }

        if (discriminator && eventObjects.length > 0) {
          // Split events by discriminator value into separate log types.
          // For CEF/LEEF, pair each parsed object with its original raw line.
          const groups = new Map<string, Array<{ evt: Record<string, unknown>; rawLine: string }>>();
          for (let i = 0; i < eventObjects.length; i++) {
            const evt = eventObjects[i];
            const val = String(evt[discriminator] || 'unknown');
            if (!groups.has(val)) groups.set(val, []);
            // Use original raw line if available, otherwise fall back to JSON
            const rawLine = (isCefOrLeef && i < originalRawLines.length)
              ? originalRawLines[i]
              : JSON.stringify(evt);
            groups.get(val)!.push({ evt, rawLine });
          }

          for (const [typeValue, entries] of groups) {
            // Clean up the type value for use as log type name
            let logType = typeValue
              .replace(/[^a-zA-Z0-9_\- ]/g, '')
              .replace(/\s+/g, '_')
              .replace(/^_+|_+$/g, '');
            if (!logType) logType = 'default';

            // Map numeric PAN-OS DeviceEventClassID to human-readable names
            if (discriminator === 'DeviceEventClassID' && PANOS_LOG_TYPES[logType]) {
              logType = PANOS_LOG_TYPES[logType];
            }

            // For CEF/LEEF, rawEvents are original raw lines; for JSON, they're stringified objects
            const rawEvents = entries.map((e) => e.rawLine);
            // Always parse from the JSON objects for field discovery
            const jsonEvents = entries.map((e) => JSON.stringify(e.evt));
            const groupParsed = parseSampleContent(jsonEvents.join('\n'), `${fileName}:${logType}`);
            const fieldNames = groupParsed.fields.map((f) => f.name);

            samples.push({
              vendor: solutionName,
              logType,
              format: isCefOrLeef ? parsed.format : (groupParsed.format || parsed.format),
              eventCount: entries.length,
              fieldCount: groupParsed.fields.length,
              rawEvents,
              timestampField: groupParsed.timestampField || parsed.timestampField,
              source: `${fileName} [${discriminator}=${typeValue}]`,
              fields: groupParsed.fields,
              preIngested: detectPreIngested(fieldNames),
            });
          }
        } else {
          // No discriminator found -- use entire file as one log type
          // Derive log type from filename
          let logType = fileName.replace(/\.[^.]+$/, '');
          for (const kw of uniqueKeywords) {
            if (kw.length < 4) continue;
            const re = new RegExp(`^${kw}[_\\-]?`, 'i');
            logType = logType.replace(re, '');
          }
          logType = logType
            .replace(/_CL$/i, '')
            .replace(/_?RawLogs$/i, '')
            .replace(/_?IngestedLogs$/i, '')
            .replace(/_?SampleData$/i, '')
            .replace(/_?sample$/i, '')
            .replace(/^_+|_+$/g, '');
          if (!logType) logType = fileName.replace(/\.[^.]+$/, '');

          samples.push({
            vendor: solutionName,
            logType,
            format: parsed.format,
            eventCount: parsed.eventCount,
            fieldCount: parsed.fields.length,
            // For CEF/LEEF/syslog, use original raw lines; for JSON, use parsed events
            rawEvents: isCefOrLeef ? originalRawLines.slice(0, parsed.eventCount) : parsed.rawEvents,
            timestampField: parsed.timestampField,
            source: fileName,
            fields: parsed.fields,
            preIngested: detectPreIngested(parsed.fields.map((f) => f.name)),
          });
        }
      } catch { /* skip unparseable files */ }
    }

    // Filter out pre-ingested samples (already in Sentinel table schema).
    const rawSamples = samples.filter((s) => !s.preIngested);
    const skippedCount = samples.length - rawSamples.length;

    // Consolidate: if the solution defines custom tables, merge individual
    // discriminator samples (e.g., 322 event_simpleName values) into one
    // sample per solution table. This keeps raw vendor data but groups
    // events by their destination table, producing ~10 samples instead of 300+.
    let finalSamples = rawSamples;
    if (hasSolutionTables && rawSamples.length > 20) {
      // Load the DCR routing to map event_simpleName -> table
      let eventToTable = new Map<string, string>();
      try {
        const kqlParser = await import('./kql-parser');
        const routing = await kqlParser.getTableRoutingForSolution(solutionName);
        for (const r of routing) {
          for (const esn of r.eventSimpleNames) {
            eventToTable.set(esn, r.tableName);
          }
        }
      } catch { /* non-fatal */ }

      if (eventToTable.size > 0) {
        // Group samples by destination table using DCR routing
        const tableGroups = new Map<string, typeof rawSamples>();
        const unmapped: typeof rawSamples = [];

        for (const sample of rawSamples) {
          // Try to find the table for this sample's logType (which is the event_simpleName)
          const table = eventToTable.get(sample.logType);
          if (table) {
            if (!tableGroups.has(table)) tableGroups.set(table, []);
            tableGroups.get(table)!.push(sample);
          } else {
            unmapped.push(sample);
          }
        }

        // Merge samples per table: combine raw events, merge fields, keep first N events
        const MAX_EVENTS_PER_TABLE = 10;
        const consolidated: typeof rawSamples = [];
        for (const [tableName, tableSamples] of tableGroups) {
          const mergedRawEvents: string[] = [];
          const allFields = new Map<string, { name: string; type: string; sampleValues: string[]; occurrence: number; required: boolean }>();
          for (const sample of tableSamples) {
            // Take up to 2 raw events per event type for diversity
            for (const raw of (sample.rawEvents || []).slice(0, 2)) {
              if (mergedRawEvents.length < MAX_EVENTS_PER_TABLE) {
                mergedRawEvents.push(raw);
              }
            }
            for (const field of (sample.fields || [])) {
              if (!allFields.has(field.name)) {
                allFields.set(field.name, { ...field });
              }
            }
          }
          consolidated.push({
            vendor: solutionName,
            logType: tableName.replace(/_CL$/, ''),
            format: tableSamples[0]?.format || 'ndjson',
            eventCount: mergedRawEvents.length,
            fieldCount: allFields.size,
            rawEvents: mergedRawEvents,
            timestampField: tableSamples[0]?.timestampField || '',
            source: `${tableSamples.length} event types -> ${tableName}`,
            fields: [...allFields.values()],
            preIngested: false,
          });
        }

        // Add unmapped samples as-is (limit to 5)
        for (const sample of unmapped.slice(0, 5)) {
          consolidated.push(sample);
        }

        finalSamples = consolidated;
      }
    }

    return {
      success: true,
      samples: finalSamples,
      skippedPreIngested: skippedCount,
      filesSearched: matchedFiles.length,
      message: finalSamples.length > 0
        ? `Found ${finalSamples.length} sample(s) with ${finalSamples.reduce((s, x) => s + x.eventCount, 0)} total events.` +
          (skippedCount > 0 ? ` Skipped ${skippedCount} pre-ingested.` : '') +
          (hasSolutionTables && rawSamples.length > finalSamples.length ? ` Consolidated ${rawSamples.length} event types into ${finalSamples.length} table groups.` : '')
        : skippedCount > 0
          ? `All ${skippedCount} sample(s) are in Sentinel schema format. Upload raw vendor samples or capture live data.`
          : `Found ${matchedFiles.length} matching file(s) but none could be parsed.`,
    };
}
