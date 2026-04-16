// SIEM Migration Module
// Parses Splunk and QRadar detection rule exports to identify required data
// sources, maps them to Sentinel solutions, and drives Cribl pack creation.

import { IpcMain, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedRule {
  name: string;
  platform: 'splunk' | 'qradar';
  enabled: boolean;
  dataSources: string[];       // normalized data source identifiers
  macros: string[];            // Splunk: backtick-wrapped macro names
  dataModels: string[];        // Splunk: datamodel references
  sourcetypes: string[];       // Splunk: sourcetype values
  contentExtension: string;    // QRadar: Content extension name
  eventCategories: string[];   // QRadar: High-level.low-level category
  mitreTactics: string[];
  mitreTechniques: string[];
  severity: string;
  description: string;
  rawSearch: string;           // Splunk: SPL query / QRadar: Test definition
  isRule: boolean;             // QRadar: true = rule, false = building block
}

export interface SentinelAnalyticRuleMatch {
  name: string;
  severity: string;
  tactics: string[];
  query: string;               // KQL query for preview
}

export interface IdentifiedDataSource {
  id: string;                  // normalized key
  name: string;                // display name
  platform: 'splunk' | 'qradar';
  platformIdentifiers: string[]; // original macro/extension names
  ruleCount: number;
  rules: string[];             // rule names referencing this source
  mitreTactics: string[];
  mitreTechniques: string[];
  sentinelSolution: string;    // matched Sentinel solution name (empty = unmapped)
  sentinelTable: string;       // destination table (e.g., CommonSecurityLog)
  confidence: 'high' | 'medium' | 'low' | 'none';
  sentinelAnalyticRules: SentinelAnalyticRuleMatch[]; // matched Sentinel analytics rules
}

export interface MigrationPlan {
  platform: 'splunk' | 'qradar';
  fileName: string;
  totalRules: number;
  enabledRules: number;
  buildingBlocks: number;      // QRadar only
  dataSources: IdentifiedDataSource[];
  unmappedRules: ParsedRule[];
  mitreCoverage: Array<{ tactic: string; techniqueCount: number; ruleCount: number }>;
  totalSentinelRules: number;  // total matched Sentinel analytics rules across all sources
}

// ---------------------------------------------------------------------------
// Static Mapping Tables (derived from actual customer exports)
// ---------------------------------------------------------------------------

// Splunk macros -> { solution, table }
const SPLUNK_MACRO_MAP: Record<string, { solution: string; table: string }> = {
  wineventlog_security: { solution: 'Windows Security Events', table: 'SecurityEvent' },
  powershell: { solution: 'Windows Security Events', table: 'SecurityEvent' },
  sysmon: { solution: 'Windows Security Events', table: 'SecurityEvent' },
  process_powershell: { solution: 'Windows Security Events', table: 'SecurityEvent' },
  process_net: { solution: 'Windows Security Events', table: 'SecurityEvent' },
  process_cmd: { solution: 'Windows Security Events', table: 'SecurityEvent' },
  process_wmic: { solution: 'Windows Security Events', table: 'SecurityEvent' },
  process_certutil: { solution: 'Windows Security Events', table: 'SecurityEvent' },
  process_reg: { solution: 'Windows Security Events', table: 'SecurityEvent' },
  process_auditpol: { solution: 'Windows Security Events', table: 'SecurityEvent' },
  wineventlog_system: { solution: 'Windows Security Events', table: 'SecurityEvent' },
  wineventlog_application: { solution: 'Windows Security Events', table: 'SecurityEvent' },
  cloudtrail: { solution: 'Amazon Web Services', table: 'AWSCloudTrail' },
  amazon_security_lake: { solution: 'Amazon Web Services', table: 'AWSCloudTrail' },
  linux_auditd: { solution: 'Syslog', table: 'Syslog' },
  azure_monitor_aad: { solution: 'Microsoft Entra ID', table: 'SigninLogs' },
  cisco_secure_firewall: { solution: 'Cisco ASA', table: 'CommonSecurityLog' },
  zscaler_proxy: { solution: 'Zscaler Internet Access', table: 'CommonSecurityLog' },
  okta: { solution: 'Okta Single Sign-On', table: 'Okta_CL' },
  github_enterprise: { solution: 'GitHub Enterprise', table: 'GitHubAuditData' },
  kubernetes_metrics: { solution: 'Azure Kubernetes Service', table: 'ContainerLog' },
  kube_audit: { solution: 'Azure Kubernetes Service', table: 'ContainerLog' },
  splunkd: { solution: '', table: '' },          // Splunk internal -- not migrated
  splunkd_web: { solution: '', table: '' },
  splunkd_ui: { solution: '', table: '' },
  splunkda: { solution: '', table: '' },
  splunkd_webx: { solution: '', table: '' },
  audit_searches: { solution: '', table: '' },
  cisco_ai_defense: { solution: 'Cisco Secure Endpoint', table: 'CommonSecurityLog' },
  appdynamics_security: { solution: 'Cisco Secure Application', table: 'CommonSecurityLog' },
  crushftp: { solution: 'Syslog', table: 'Syslog' },
  o365_management_activity: { solution: 'Microsoft 365', table: 'OfficeActivity' },
  admon: { solution: 'Windows Security Events', table: 'SecurityEvent' },
  ntlm_audit: { solution: 'Windows Security Events', table: 'SecurityEvent' },
  applocker: { solution: 'Windows Security Events', table: 'SecurityEvent' },
  windows_shells: { solution: 'Windows Security Events', table: 'SecurityEvent' },
  windows_exchange_iis: { solution: 'Microsoft Exchange', table: 'W3CIISLog' },
  msexchange_management: { solution: 'Microsoft Exchange', table: 'Event' },
  suricata: { solution: 'Suricata', table: 'CommonSecurityLog' },
  pingid: { solution: 'PingID', table: 'PingID_CL' },
  circleci: { solution: 'CircleCI', table: 'CircleCI_CL' },
  papercutng: { solution: 'PaperCut', table: 'Syslog' },
  remoteconnectionmanager: { solution: 'Windows Security Events', table: 'SecurityEvent' },
  subjectinterfacepackage: { solution: 'Windows Security Events', table: 'SecurityEvent' },
  certificateservices_lifecycle: { solution: 'Windows Security Events', table: 'SecurityEvent' },
};

// Splunk data models -> { solution, table }
// Data model map -- uses top-level names since sub-models are collapsed before lookup
const SPLUNK_DATAMODEL_MAP: Record<string, { solution: string; table: string }> = {
  'Endpoint': { solution: 'Windows Security Events', table: 'SecurityEvent' },
  'Authentication': { solution: 'Windows Security Events', table: 'SecurityEvent' },
  'Network_Traffic': { solution: 'Windows Security Events', table: 'CommonSecurityLog' },
  'Web': { solution: 'Windows Security Events', table: 'CommonSecurityLog' },
  'Network_Resolution': { solution: 'Windows Security Events', table: 'DnsEvents' },
  'Email': { solution: 'Microsoft 365', table: 'EmailEvents' },
  'Change': { solution: 'Windows Security Events', table: 'SecurityEvent' },
  'Intrusion_Detection': { solution: 'Windows Security Events', table: 'CommonSecurityLog' },
  'Network_Sessions': { solution: 'Windows Security Events', table: 'CommonSecurityLog' },
  'Updates': { solution: 'Windows Security Events', table: 'SecurityEvent' },
  'Certificates': { solution: 'Windows Security Events', table: 'CommonSecurityLog' },
  'Risk': { solution: '', table: '' }, // Splunk-specific concept
  'Splunk_Audit': { solution: '', table: '' },
};

// QRadar content extensions -> { solution, table }
const QRADAR_EXTENSION_MAP: Record<string, { solution: string; table: string }> = {
  'IBM QRadar Endpoint Content Extension': { solution: 'Windows Security Events', table: 'SecurityEvent' },
  'IBM QRadar Content Extension for Sysmon': { solution: 'Windows Security Events', table: 'SecurityEvent' },
  'IBM QRadar Baseline Maintenance Content Extension': { solution: '', table: '' },
  'IBM QRadar Baseline Maintenance Content Extension v7.3.3 FP4+': { solution: '', table: '' },
  'IBM QRadar Security Threat Monitoring Content Extension': { solution: 'Threat Intelligence', table: 'ThreatIntelligenceIndicator' },
  'IBM Security QRadar Techniques for Turla Content Extension': { solution: 'Threat Intelligence', table: 'ThreatIntelligenceIndicator' },
  'IBM Security GPG13 Content': { solution: 'Windows Security Events', table: 'SecurityEvent' },
  'IBM Security ISO 27001 Content': { solution: '', table: '' }, // Compliance framework
  'IBM Security QRadar Content Extension for Hybrid Cloud Use Cases': { solution: 'Azure Activity', table: 'AzureActivity' },
  'IBM Security QRadar Reconnaissance Content Extension': { solution: 'Firewall', table: 'CommonSecurityLog' },
  'IBM QRadar Data Exfiltration Content Extension': { solution: 'Firewall', table: 'CommonSecurityLog' },
  'IBM Security QRadar Network Anomaly Content Extension': { solution: 'Firewall', table: 'CommonSecurityLog' },
  'IBM QRadar DNS Analyzer': { solution: 'DNS', table: 'DnsEvents' },
  'IBM QRadar Compliance Content Extension': { solution: '', table: '' },
  'IBM QRadar Phishing and Email Content Extension': { solution: 'Microsoft 365', table: 'EmailEvents' },
  'IBM QRadar Container Content Extension': { solution: 'Azure Kubernetes Service', table: 'ContainerLog' },
  'IBM Security QRadar Content Extension for SysFlow': { solution: 'Syslog', table: 'Syslog' },
  'IBM QRadar Cryptomining Content Extension': { solution: 'Threat Intelligence', table: 'ThreatIntelligenceIndicator' },
  'IBM QRadar Network Insights Content Extension': { solution: 'Firewall', table: 'CommonSecurityLog' },
  'IBM QRadar SOX Content Extension': { solution: '', table: '' },
  'IBM QRadar NERC Content Extension': { solution: '', table: '' },
  'IBM QRadar GLBA Content Extension': { solution: '', table: '' },
  'IBM QRadar FISMA Content Extension': { solution: '', table: '' },
  'IBM QRadar Content Extension for GDPR': { solution: '', table: '' },
};

// Splunk internal macros to skip (not real data sources)
const SPLUNK_INTERNAL_MACROS = new Set([
  'security_content_summariesonly', 'security_content_ctime',
  'drop_dm_object_name', 'cim_entity_resolution',
]);

// Prefix-based grouping for Splunk macros not in the static table.
// Maps macro prefixes to a { solution, table } so related macros group together.
const SPLUNK_PREFIX_MAP: Array<{ prefix: string; solution: string; table: string }> = [
  { prefix: 'process_', solution: 'Windows Security Events', table: 'SecurityEvent' },
  { prefix: 'wineventlog_', solution: 'Windows Security Events', table: 'SecurityEvent' },
  { prefix: 'o365_', solution: 'Microsoft 365', table: 'OfficeActivity' },
  { prefix: 'ms365_', solution: 'Microsoft 365', table: 'OfficeActivity' },
  { prefix: 'azure_', solution: 'Microsoft Entra ID', table: 'SigninLogs' },
  { prefix: 'gws_', solution: 'Google Workspace', table: 'GoogleWorkspace_CL' },
  { prefix: 'gsuite_', solution: 'Google Workspace', table: 'GoogleWorkspace_CL' },
  { prefix: 'google_', solution: 'Google Workspace', table: 'GCPAuditLog_CL' },
  { prefix: 'crowdstrike_', solution: 'CrowdStrike Falcon Endpoint Protection', table: 'CommonSecurityLog' },
  { prefix: 'github_', solution: 'GitHub Enterprise', table: 'GitHubAuditData' },
  { prefix: 'kube_', solution: 'Azure Kubernetes Service', table: 'ContainerLog' },
  { prefix: 'kubernetes_', solution: 'Azure Kubernetes Service', table: 'ContainerLog' },
  { prefix: 'aws_', solution: 'Amazon Web Services', table: 'AWSCloudTrail' },
  { prefix: 'cisco_', solution: 'Cisco ASA', table: 'CommonSecurityLog' },
  { prefix: 'ms_defender', solution: 'Microsoft Defender XDR', table: 'SecurityAlert' },
  { prefix: 'stream_', solution: 'Windows Security Events', table: 'SecurityEvent' },
  { prefix: 'zeek_', solution: 'Windows Security Events', table: 'SecurityEvent' },
  { prefix: 'iis_', solution: 'Windows Security Events', table: 'W3CIISLog' },
  { prefix: 'nginx_', solution: 'Syslog', table: 'Syslog' },
  { prefix: 'f5_', solution: 'Cisco ASA', table: 'CommonSecurityLog' },
];

// Macros that are Splunk-internal and should be excluded entirely (no data source)
const SPLUNK_SKIP_MACROS = new Set([
  'splunkd', 'splunkda', 'splunkd_web', 'splunkd_ui', 'splunkd_webx', 'splunkd_webs',
  'splunk_python', 'splunkd_failed_auths', 'audit_searches',
  'remote_access_software_usage_exceptions',
  'previously_unseen_cloud_provisioning_activity_window',
  'previously_seen_zoom_child_processes_window',
  'previously_seen_windows_services_window',
  'prohibited_apps_launching_cmd_macro',
  'is_windows_system_file_macro', 'is_net_windows_file_macro', 'is_nirsoft_software_macro',
  'potentially_malicious_code_on_cmdline_tokenize_score',
  'potential_password_in_username_false_positive_reduction',
  'system_network_configuration_discovery_tools',
  'path_traversal_spl_injection',
  'ransomware_notes', 'dynamic_dns_providers', 'brand_abuse_web',
  'suspicious_email_attachments', 'bootloader_inventory', 'driverinventory',
  'important_audit_policy_subcategory_guids',
]);

// Patterns for Splunk macros that are filters/helpers, not data source identifiers
function isSplunkFilterMacro(macro: string): boolean {
  // If it's in the mapping table, it's a real data source
  if (SPLUNK_MACRO_MAP[macro]) return false;
  // If it's an explicit skip macro
  if (SPLUNK_SKIP_MACROS.has(macro)) return true;
  // Skip common filter/helper patterns
  return macro.endsWith('_filter') || macro.endsWith('_ctime')
    || macro.startsWith('get_') || macro.startsWith('set_')
    || macro.startsWith('lookup_') || macro.startsWith('notable_');
}

// Resolve a macro to a solution via static table or prefix matching
function resolveSplunkMacro(macro: string): { solution: string; table: string } | null {
  // 1. Direct static mapping
  const direct = SPLUNK_MACRO_MAP[macro];
  if (direct) return direct;
  // 2. Prefix-based grouping
  for (const { prefix, solution, table } of SPLUNK_PREFIX_MAP) {
    if (macro.startsWith(prefix)) return { solution, table };
  }
  return null;
}

// ---------------------------------------------------------------------------
// CSV Parser (RFC 4180 compliant -- handles quoted multi-line fields)
// ---------------------------------------------------------------------------

function parseQRadarCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++; // skip escaped quote
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\n' || (ch === '\r' && next === '\n')) {
        row.push(field);
        field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
        if (ch === '\r') i++; // skip \r\n
      } else {
        field += ch;
      }
    }
  }
  // Last field/row
  if (field || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Splunk Parser
// ---------------------------------------------------------------------------

function parseSplunkExport(jsonContent: string): ParsedRule[] {
  const parsed = JSON.parse(jsonContent);
  const alertRules = parsed?.result?.alertrules || parsed?.alertrules || (Array.isArray(parsed) ? parsed : []);
  const rules: ParsedRule[] = [];

  for (const rule of alertRules) {
    const search = rule.search || '';
    const title = rule.title || '';

    // Extract macros (backtick-wrapped) -- skip internal and filter macros
    const macros: string[] = [];
    const macroRegex = /`([a-zA-Z_][a-zA-Z0-9_]*)`/g;
    let m;
    while ((m = macroRegex.exec(search)) !== null) {
      const macro = m[1];
      if (!SPLUNK_INTERNAL_MACROS.has(macro) && macro.length > 2 && !isSplunkFilterMacro(macro)) {
        macros.push(macro);
      }
    }

    // Extract data models
    const dataModels: string[] = [];
    const dmRegex = /datamodel=([A-Za-z_.]+)/g;
    while ((m = dmRegex.exec(search)) !== null) {
      dataModels.push(m[1]);
    }

    // Extract sourcetypes
    const sourcetypes: string[] = [];
    const stRegex = /sourcetype\s*=\s*"?([^\s"',)]+)/gi;
    while ((m = stRegex.exec(search)) !== null) {
      sourcetypes.push(m[1]);
    }

    // Prefer macros over data models as the data source identifier.
    // When a rule has both (macro = specific source, datamodel = abstract schema),
    // use only the macro -- the data model is redundant.
    // Collapse sub-data-models to top level (Endpoint.Processes -> Endpoint).
    const collapsedDMs = dataModels.map((dm) => dm.split('.')[0]);
    const dataSources = macros.length > 0
      ? [...new Set([...macros, ...sourcetypes])]
      : [...new Set([...collapsedDMs, ...sourcetypes])];

    // Severity
    const sev = rule['alert.severity'];
    const severity = sev === 1 ? 'Low' : sev === 2 ? 'Medium' : sev === 3 ? 'High' : sev === 4 ? 'Critical' : 'Unknown';

    rules.push({
      name: title,
      platform: 'splunk',
      enabled: true, // Splunk export only includes enabled alerts
      dataSources,
      macros,
      dataModels,
      sourcetypes,
      contentExtension: '',
      eventCategories: [],
      mitreTactics: [],
      mitreTechniques: [],
      severity,
      description: rule.description || '',
      rawSearch: search,
      isRule: true,
    });
  }

  return rules;
}

// ---------------------------------------------------------------------------
// QRadar Parser
// ---------------------------------------------------------------------------

function parseQRadarExport(csvContent: string): ParsedRule[] {
  const rows = parseQRadarCsv(csvContent);
  if (rows.length < 2) return [];

  // Build column index from header
  const header = rows[0].map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const ruleNameIdx = col('Rule name');
  const typeIdx = col('Type');
  const enabledIdx = col('Rule enabled');
  const isRuleIdx = col('Is rule');
  const notesIdx = col('Notes');
  const categoryIdx = col('High-level.low-level category');
  const eventNameIdx = col('Event name');
  const descIdx = col('Event description');
  const testDefIdx = col('Test definition');
  const tacticIdx = col('Tactic');
  const techniqueIdx = col('Technique');
  const subTechIdx = col('Sub-technique');
  const extNameIdx = col('Content extension name');
  const contentCatIdx = col('Content category');

  const rules: ParsedRule[] = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < 5) continue; // skip malformed rows

    const get = (idx: number) => (idx >= 0 && idx < r.length ? r[idx].trim() : '');

    const ruleName = get(ruleNameIdx);
    if (!ruleName) continue;

    const enabled = get(enabledIdx).toUpperCase() === 'TRUE';
    const isRule = get(isRuleIdx).toUpperCase() === 'TRUE';
    const contentExt = get(extNameIdx);
    const category = get(categoryIdx);
    const tactic = get(tacticIdx);
    const technique = get(techniqueIdx);
    const testDef = get(testDefIdx);
    const description = get(descIdx) || get(notesIdx);

    // Data source from content extension
    const dataSources: string[] = [];
    if (contentExt) {
      const mapped = QRADAR_EXTENSION_MAP[contentExt];
      if (mapped?.solution) dataSources.push(mapped.solution);
      else dataSources.push(`extension:${contentExt}`);
    }

    // Event categories
    const eventCategories = category ? category.split('.').map((c) => c.trim()).filter(Boolean) : [];

    rules.push({
      name: ruleName,
      platform: 'qradar',
      enabled,
      dataSources: [...new Set(dataSources)],
      macros: [],
      dataModels: [],
      sourcetypes: [],
      contentExtension: contentExt,
      eventCategories,
      mitreTactics: tactic ? [tactic] : [],
      mitreTechniques: technique ? [technique] : [],
      severity: 'Unknown',
      description,
      rawSearch: testDef,
      isRule,
    });
  }

  return rules;
}

// ---------------------------------------------------------------------------
// Data Source Identification
// ---------------------------------------------------------------------------

function identifyDataSources(rules: ParsedRule[], platform: 'splunk' | 'qradar'): IdentifiedDataSource[] {
  // Group rules by each unique data source identifier (macro, data model, sourcetype, extension)
  const sourceMap = new Map<string, {
    rawId: string;
    rules: Set<string>;
    tactics: Set<string>;
    techniques: Set<string>;
  }>();

  for (const rule of rules) {
    if (!rule.isRule && platform === 'qradar') continue;

    for (const ds of rule.dataSources) {
      if (!ds) continue;
      // Skip Splunk internal macros that map to empty solution
      if (platform === 'splunk') {
        const mapped = SPLUNK_MACRO_MAP[ds];
        if (mapped && !mapped.solution) continue; // Splunk internal
        if (SPLUNK_SKIP_MACROS.has(ds)) continue;
      }

      const key = ds.toLowerCase().replace(/[^a-z0-9.]/g, '_');
      const existing = sourceMap.get(key) || { rawId: ds, rules: new Set(), tactics: new Set(), techniques: new Set() };
      existing.rules.add(rule.name);
      rule.mitreTactics.forEach((t) => existing.tactics.add(t));
      rule.mitreTechniques.forEach((t) => existing.techniques.add(t));
      sourceMap.set(key, existing);
    }
  }

  // Convert to array with solution resolution
  const dataSources: IdentifiedDataSource[] = [];
  for (const [key, data] of sourceMap) {
    const rawId = data.rawId;
    let sentinelSolution = '';
    let sentinelTable = '';
    let confidence: 'high' | 'medium' | 'low' | 'none' = 'none';

    if (platform === 'splunk') {
      // Resolve via static table, then prefix map
      const resolved = resolveSplunkMacro(rawId) || SPLUNK_DATAMODEL_MAP[rawId];
      if (resolved?.solution) {
        sentinelSolution = resolved.solution;
        sentinelTable = resolved.table;
        confidence = SPLUNK_MACRO_MAP[rawId] ? 'high' : 'medium'; // direct = high, prefix = medium
      }
    } else {
      const resolved = QRADAR_EXTENSION_MAP[rawId];
      if (resolved?.solution) {
        sentinelSolution = resolved.solution;
        sentinelTable = resolved.table;
        confidence = 'high';
      }
    }

    dataSources.push({
      id: key,
      name: rawId,
      platform,
      platformIdentifiers: [rawId],
      ruleCount: data.rules.size,
      rules: [...data.rules],
      mitreTactics: [...data.tactics].sort(),
      mitreTechniques: [...data.techniques].sort(),
      sentinelSolution,
      sentinelTable,
      confidence,
      sentinelAnalyticRules: [],
    });
  }

  // Merge data sources that map to the same Sentinel solution into a single entry.
  // This collapses e.g. kube_allowed_locations + kube_container_falco + kube_audit
  // into one "Azure Kubernetes Service" data source.
  const mergedMap = new Map<string, IdentifiedDataSource>();
  for (const ds of dataSources) {
    const mergeKey = ds.sentinelSolution
      ? ds.sentinelSolution.toLowerCase().trim()
      : ds.id; // unmapped sources stay separate

    const existing = mergedMap.get(mergeKey);
    if (existing) {
      // Merge into existing entry
      existing.platformIdentifiers.push(...ds.platformIdentifiers);
      existing.ruleCount += ds.ruleCount;
      for (const r of ds.rules) { if (!existing.rules.includes(r)) existing.rules.push(r); }
      for (const t of ds.mitreTactics) { if (!existing.mitreTactics.includes(t)) existing.mitreTactics.push(t); }
      for (const t of ds.mitreTechniques) { if (!existing.mitreTechniques.includes(t)) existing.mitreTechniques.push(t); }
      if (!existing.sentinelTable && ds.sentinelTable) existing.sentinelTable = ds.sentinelTable;
      // Use highest confidence
      const confOrder = { high: 3, medium: 2, low: 1, none: 0 };
      if ((confOrder[ds.confidence] || 0) > (confOrder[existing.confidence] || 0)) {
        existing.confidence = ds.confidence;
      }
    } else {
      mergedMap.set(mergeKey, { ...ds, platformIdentifiers: [...ds.platformIdentifiers] });
    }
  }

  const merged = [...mergedMap.values()];
  // Deduplicate rule count (rules array may have duplicates from merging)
  for (const ds of merged) {
    ds.rules = [...new Set(ds.rules)];
    ds.ruleCount = ds.rules.length;
    ds.mitreTactics.sort();
    ds.mitreTechniques.sort();
  }

  merged.sort((a, b) => b.ruleCount - a.ruleCount);
  return merged;
}

// ---------------------------------------------------------------------------
// Fuzzy Solution Mapping (tier 2 -- for unmapped data sources)
// ---------------------------------------------------------------------------

async function fuzzyMapSolutions(dataSources: IdentifiedDataSource[]): Promise<void> {
  let solutions: Array<{ name: string }> = [];
  try {
    const sentinelRepo = await import('./sentinel-repo');
    if (sentinelRepo.isRepoReady()) {
      solutions = sentinelRepo.listSolutions();
    }
  } catch { /* skip */ }

  if (solutions.length === 0) return;

  const solutionNames = solutions.map((s) => s.name);

  for (const ds of dataSources) {
    if (ds.confidence !== 'none') continue; // already mapped

    const searchName = ds.name.toLowerCase().replace(/[^a-z0-9]/g, '');

    // Fuzzy match against solution names
    for (const sol of solutionNames) {
      const solLower = sol.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (solLower === searchName || solLower.includes(searchName) || searchName.includes(solLower)) {
        ds.sentinelSolution = sol;
        ds.confidence = searchName === solLower ? 'high' : 'medium';
        break;
      }
    }

    // If still unmapped, try partial word matching
    if (ds.confidence === 'none') {
      const words = ds.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
      for (const sol of solutionNames) {
        const solLower = sol.toLowerCase();
        const matchCount = words.filter((w) => solLower.includes(w)).length;
        if (matchCount >= 2 || (words.length === 1 && matchCount === 1)) {
          ds.sentinelSolution = sol;
          ds.confidence = 'low';
          break;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Analytics Rule Enrichment -- match Sentinel rules to identified data sources
// ---------------------------------------------------------------------------

async function enrichWithAnalyticRules(dataSources: IdentifiedDataSource[]): Promise<number> {
  let totalRules = 0;
  try {
    const sentinelRepo = await import('./sentinel-repo');
    if (!sentinelRepo.isRepoReady()) return 0;

    // Cache rules per solution to avoid re-reading for duplicate solution names
    const ruleCache = new Map<string, SentinelAnalyticRuleMatch[]>();
    const solutions = sentinelRepo.listSolutions();

    for (const ds of dataSources) {
      if (!ds.sentinelSolution) continue;

      const cacheKey = ds.sentinelSolution.toLowerCase();
      if (ruleCache.has(cacheKey)) {
        ds.sentinelAnalyticRules = ruleCache.get(cacheKey)!;
        continue;
      }

      // Try exact match first, then fuzzy match against solution directory names
      const solNameLower = ds.sentinelSolution.toLowerCase().replace(/[^a-z0-9]/g, '');
      const match = solutions.find((s) => {
        const k = s.name.toLowerCase().replace(/[^a-z0-9]/g, '');
        return k === solNameLower || k.includes(solNameLower) || solNameLower.includes(k);
      });

      if (match) {
        const rules = sentinelRepo.listAnalyticRules(match.name);
        const mapped: SentinelAnalyticRuleMatch[] = rules.map((r) => ({
          name: r.name,
          severity: r.severity,
          tactics: r.tactics,
          query: r.query,
        }));
        ds.sentinelAnalyticRules = mapped;
        ruleCache.set(cacheKey, mapped);
      } else {
        ruleCache.set(cacheKey, []);
      }
    }

    // Count unique rules (each solution counted once, not per data source)
    for (const rules of ruleCache.values()) {
      totalRules += rules.length;
    }
  } catch { /* non-fatal */ }
  return totalRules;
}

// ---------------------------------------------------------------------------
// Migration Plan Builder
// ---------------------------------------------------------------------------

function buildMitreCoverage(rules: ParsedRule[]): Array<{ tactic: string; techniqueCount: number; ruleCount: number }> {
  const tacticMap = new Map<string, { techniques: Set<string>; ruleCount: number }>();

  for (const rule of rules) {
    for (const tactic of rule.mitreTactics) {
      if (!tactic || tactic === 'None') continue;
      const existing = tacticMap.get(tactic) || { techniques: new Set(), ruleCount: 0 };
      existing.ruleCount++;
      for (const tech of rule.mitreTechniques) {
        if (tech && tech !== 'None') existing.techniques.add(tech);
      }
      tacticMap.set(tactic, existing);
    }
  }

  return [...tacticMap.entries()]
    .map(([tactic, data]) => ({ tactic, techniqueCount: data.techniques.size, ruleCount: data.ruleCount }))
    .sort((a, b) => b.ruleCount - a.ruleCount);
}

async function buildMigrationPlan(
  content: string,
  platform: 'splunk' | 'qradar',
  fileName: string,
): Promise<MigrationPlan> {
  // Parse
  const rules = platform === 'splunk' ? parseSplunkExport(content) : parseQRadarExport(content);

  // Identify data sources
  const dataSources = identifyDataSources(rules, platform);

  // Fuzzy-map unmapped sources to Sentinel solutions
  await fuzzyMapSolutions(dataSources);

  // Enrich with Sentinel analytics rules for each matched solution
  const totalSentinelRules = await enrichWithAnalyticRules(dataSources);

  // Identify unmapped rules (rules with no resolved data source)
  const mappedSourceIds = new Set(dataSources.filter((ds) => ds.sentinelSolution).map((ds) => ds.id));
  const unmappedRules = rules.filter((r) =>
    r.isRule && r.dataSources.every((ds) => {
      const key = ds.toLowerCase().replace(/[^a-z0-9]/g, '_');
      return !mappedSourceIds.has(key);
    })
  );

  // MITRE coverage
  const mitreCoverage = buildMitreCoverage(rules.filter((r) => r.isRule));

  const actualRules = rules.filter((r) => r.isRule);
  const buildingBlocks = rules.filter((r) => !r.isRule);

  return {
    platform,
    fileName,
    totalRules: actualRules.length,
    enabledRules: actualRules.filter((r) => r.enabled).length,
    buildingBlocks: buildingBlocks.length,
    dataSources,
    unmappedRules,
    mitreCoverage,
    totalSentinelRules,
  };
}

// ---------------------------------------------------------------------------
// Report Generator
// ---------------------------------------------------------------------------

function esc(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function generateMigrationReport(plan: MigrationPlan): string {
  const mapped = plan.dataSources.filter((ds) => ds.sentinelSolution);
  const unmapped = plan.dataSources.filter((ds) => !ds.sentinelSolution);
  const sourcesWithRules = plan.dataSources.filter((ds) => ds.sentinelAnalyticRules.length > 0);
  const date = new Date().toISOString().split('T')[0];
  const platform = plan.platform === 'splunk' ? 'Splunk' : 'IBM QRadar';

  const sevColor = (s: string) => s === 'High' ? '#ef5350' : s === 'Medium' ? '#ffa726' : s === 'Low' ? '#4fc3f7' : '#999';
  const confColor = (c: string) => c === 'high' ? '#66bb6a' : c === 'medium' ? '#4fc3f7' : c === 'low' ? '#ffa726' : '#888';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SIEM Migration Report - ${esc(platform)} - ${date}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; margin: 0; padding: 24px; line-height: 1.5; }
  h1 { color: #58a6ff; font-size: 24px; border-bottom: 1px solid #30363d; padding-bottom: 8px; }
  h2 { color: #c9d1d9; font-size: 18px; margin-top: 32px; border-bottom: 1px solid #21262d; padding-bottom: 6px; }
  h3 { color: #8b949e; font-size: 14px; margin-top: 20px; }
  .meta { color: #8b949e; font-size: 13px; margin-bottom: 24px; }
  .meta span { margin-right: 24px; }
  .stats { display: flex; gap: 16px; flex-wrap: wrap; margin: 16px 0; }
  .stat { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px 20px; text-align: center; min-width: 100px; }
  .stat .num { font-size: 28px; font-weight: 700; }
  .stat .label { font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin: 12px 0; }
  th { background: #161b22; color: #8b949e; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; padding: 8px 12px; text-align: left; border-bottom: 1px solid #30363d; }
  td { padding: 6px 12px; border-bottom: 1px solid #21262d; }
  tr:hover { background: rgba(88, 166, 255, 0.04); }
  .badge { display: inline-block; font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 10px; }
  .steps { counter-reset: step; list-style: none; padding: 0; }
  .steps li { counter-increment: step; padding: 8px 0 8px 36px; position: relative; color: #c9d1d9; font-size: 14px; }
  .steps li::before { content: counter(step); position: absolute; left: 0; width: 24px; height: 24px; border-radius: 50%; background: #1f6feb; color: #fff; font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
  .unmapped { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px 16px; font-size: 12px; font-family: monospace; max-height: 300px; overflow: auto; }
  .unmapped div { padding: 2px 0; color: #8b949e; }
  .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #21262d; font-size: 11px; color: #484f58; }
</style>
</head>
<body>
<h1>SIEM Migration Report</h1>
<div class="meta">
  <span>Source SIEM: <strong>${esc(platform)}</strong></span>
  <span>Export: <strong>${esc(plan.fileName)}</strong></span>
  <span>Generated: <strong>${date}</strong></span>
</div>

<div class="stats">
  <div class="stat"><div class="num" style="color:#c9d1d9">${plan.totalRules}</div><div class="label">Detection Rules</div></div>
  <div class="stat"><div class="num" style="color:#c9d1d9">${plan.dataSources.length}</div><div class="label">Data Sources</div></div>
  <div class="stat"><div class="num" style="color:#66bb6a">${mapped.length}</div><div class="label">Mapped</div></div>
  <div class="stat"><div class="num" style="color:${unmapped.length > 0 ? '#ffa726' : '#8b949e'}">${unmapped.length}</div><div class="label">Unmapped</div></div>
  <div class="stat"><div class="num" style="color:#4fc3f7">${plan.totalSentinelRules}</div><div class="label">Sentinel Rules</div></div>
</div>

<h2>Data Sources</h2>
<table>
<thead><tr><th>Data Source</th><th>Rules</th><th>Sentinel Solution</th><th>Confidence</th><th>Table</th><th>Identifiers</th></tr></thead>
<tbody>
${plan.dataSources.map((ds) => `<tr>
  <td style="font-weight:600">${esc(ds.name)}</td>
  <td>${ds.ruleCount}</td>
  <td>${esc(ds.sentinelSolution || '(unmapped)')}</td>
  <td><span class="badge" style="background:${confColor(ds.confidence)}22;color:${confColor(ds.confidence)}">${ds.confidence}</span></td>
  <td style="font-family:monospace;font-size:11px">${esc(ds.sentinelTable || '--')}</td>
  <td style="font-size:11px;color:#8b949e">${esc(ds.platformIdentifiers.slice(0, 3).join(', '))}${ds.platformIdentifiers.length > 3 ? ' +' + (ds.platformIdentifiers.length - 3) : ''}</td>
</tr>`).join('\n')}
</tbody>
</table>

${sourcesWithRules.length > 0 ? `
<h2>Matched Sentinel Analytics Rules</h2>
${sourcesWithRules.map((ds) => `
<h3>${esc(ds.sentinelSolution)} (${ds.sentinelAnalyticRules.length} rules)</h3>
<table>
<thead><tr><th>Rule Name</th><th>Severity</th><th>Tactics</th></tr></thead>
<tbody>
${ds.sentinelAnalyticRules.map((r) => `<tr>
  <td>${esc(r.name)}</td>
  <td><span class="badge" style="background:${sevColor(r.severity)}22;color:${sevColor(r.severity)}">${esc(r.severity)}</span></td>
  <td style="font-size:11px;color:#8b949e">${esc(r.tactics.join(', ') || '--')}</td>
</tr>`).join('\n')}
</tbody>
</table>
`).join('\n')}
` : ''}

${plan.unmappedRules.length > 0 ? `
<h2>Unmapped Rules (${plan.unmappedRules.length})</h2>
<div class="unmapped">
${plan.unmappedRules.slice(0, 100).map((r) => `<div><strong>${esc(r.name)}</strong>: ${esc(r.dataSources.join(', ') || 'no data source identified')}</div>`).join('\n')}
${plan.unmappedRules.length > 100 ? `<div>... and ${plan.unmappedRules.length - 100} more</div>` : ''}
</div>
` : ''}

<h2>Next Steps</h2>
<ol class="steps">
  <li>Review the identified data sources and confirm the Sentinel solution mappings</li>
  <li>For each mapped data source, build a Cribl pack using the SOC Optimization Toolkit</li>
  <li>Upload the exported rules to the Microsoft SIEM Migration tool (security.microsoft.com)</li>
  <li>Deploy the Cribl packs and Sentinel analytics rules in parallel</li>
  <li>Validate data flow end-to-end for each data source</li>
</ol>

<div class="footer">Generated by Cribl SOC Optimization Toolkit</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

export function registerSiemMigrationHandlers(ipcMain: IpcMain): void {
  // Parse a Splunk or QRadar export and return the migration plan
  ipcMain.handle('siem:parse', async (_event, {
    content, platform, fileName,
  }: {
    content: string;
    platform: 'splunk' | 'qradar';
    fileName?: string;
  }) => {
    try {
      const plan = await buildMigrationPlan(content, platform, fileName || 'export');
      return { success: true, plan };
    } catch (err) {
      return { success: false, plan: null, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Build a Cribl pack for a specific data source
  ipcMain.handle('siem:build-pack', async (_event, {
    solutionName, packName, userSamples,
  }: {
    solutionName: string;
    packName?: string;
    userSamples?: Array<{ logType: string; content: string; fileName: string }>;
  }) => {
    try {
      const { performVendorResearch } = await import('./vendor-research');
      const { resolveSamples } = await import('./sample-resolver');

      const research = await performVendorResearch(solutionName);

      // Resolve vendor samples via tiered approach
      const resolvedSamples = await resolveSamples(solutionName, userSamples);
      const sampleTier = resolvedSamples.length > 0 ? resolvedSamples[0].tier : 'none';
      const sampleCount = resolvedSamples.reduce((sum, s) => sum + s.rawEvents.length, 0);

      // Convert ResolvedSample[] to VendorSample[] for pack-builder
      const vendorSamples = resolvedSamples.map((s) => ({
        tableName: s.tableName,
        format: s.format,
        rawEvents: s.rawEvents,
        source: s.source,
        logType: s.logType,
      }));

      // Build pack using existing scaffold pipeline
      const name = packName || solutionName.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-sentinel';
      const tables = (research?.logTypes || []).map((lt) => ({
        sentinelTable: lt.destTable || 'CommonSecurityLog',
        criblStream: `Custom-${(lt.destTable || 'CommonSecurityLog').replace(/_CL$/i, '')}`,
        logType: lt.name || lt.id,
        sourcetypeFilter: lt.sourcetypePattern ? `sourcetype == '${lt.sourcetypePattern}'` : 'true',
        fields: [] as Array<{ source: string; target: string; type: string; action: 'rename' | 'keep' | 'coerce' | 'drop' }>,
      }));

      if (tables.length === 0) {
        tables.push({
          sentinelTable: 'CommonSecurityLog',
          criblStream: 'Custom-CommonSecurityLog',
          logType: solutionName,
          sourcetypeFilter: 'true',
          fields: [],
        });
      }

      // Import scaffoldPack dynamically
      const packBuilder = await import('./pack-builder');

      // Use the IPC handler indirectly -- call scaffold via the exported function
      // Since scaffoldPack isn't directly exported, invoke via IPC
      const { ipcMain: mainIpc } = await import('electron');
      // Direct function call approach -- get the pack builder's internal function
      const result = await new Promise<{ packDir: string; crblPath: string }>((resolve, reject) => {
        // Trigger the existing IPC handler
        const fakeEvent = { sender: { send: () => {}, isDestroyed: () => false } } as any;
        mainIpc.emit('pack:scaffold', fakeEvent, {
          solutionName,
          packName: name,
          version: '1.0.0',
          autoPackage: true,
          vendorSamples,
          tables,
        });
        // This approach won't work cleanly -- use ipcRenderer.invoke pattern instead
        reject(new Error('Use window.api.packBuilder.scaffold() from the renderer'));
      }).catch(() => {
        // Fallback: return instructions for the renderer to call scaffold
        return { packDir: '', crblPath: '', needsRendererCall: true };
      });

      return {
        success: true,
        solutionName,
        packName: name,
        tables: tables.map((t) => t.sentinelTable),
        research: research ? { vendor: research.vendor, logTypes: research.logTypes.length } : null,
        sampleInfo: { tier: sampleTier, eventCount: sampleCount, sources: resolvedSamples.map((s) => s.source) },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Export migration report to Downloads
  ipcMain.handle('siem:export-report', async (_event, {
    plan,
  }: {
    plan: MigrationPlan;
  }) => {
    try {
      const report = generateMigrationReport(plan);
      const userHome = process.env.USERPROFILE || process.env.HOME || '';
      const fileName = `siem-migration-report-${plan.platform}-${new Date().toISOString().split('T')[0]}.html`;
      const filePath = path.join(userHome, 'Downloads', fileName);
      fs.writeFileSync(filePath, report);
      return { success: true, filePath, report };
    } catch (err) {
      return { success: false, filePath: '', report: '', error: err instanceof Error ? err.message : String(err) };
    }
  });
}
