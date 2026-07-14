/**
 * SIEM Migration knowledge bases (porting-plan Unit 26): the load-bearing
 * mapping IP, ported VERBATIM from the legacy siem-migration.ts (lines
 * 70-236) as versioned data assets. Derived from actual customer exports -
 * extend by appending entries, never by rewriting existing ones (each entry
 * is evidence from a real migration).
 *
 * Pure data + two pure predicates. No IO.
 */

/** A data-source mapping target: the Sentinel solution and its table. */
export interface SolutionTableTarget {
  solution: string;
  table: string;
}

/** Splunk macros -> { solution, table }. Empty solution = Splunk-internal. */
export const SPLUNK_MACRO_MAP: Record<string, SolutionTableTarget> = {
  wineventlog_security: { solution: "Windows Security Events", table: "SecurityEvent" },
  powershell: { solution: "Windows Security Events", table: "SecurityEvent" },
  sysmon: { solution: "Windows Security Events", table: "SecurityEvent" },
  process_powershell: { solution: "Windows Security Events", table: "SecurityEvent" },
  process_net: { solution: "Windows Security Events", table: "SecurityEvent" },
  process_cmd: { solution: "Windows Security Events", table: "SecurityEvent" },
  process_wmic: { solution: "Windows Security Events", table: "SecurityEvent" },
  process_certutil: { solution: "Windows Security Events", table: "SecurityEvent" },
  process_reg: { solution: "Windows Security Events", table: "SecurityEvent" },
  process_auditpol: { solution: "Windows Security Events", table: "SecurityEvent" },
  wineventlog_system: { solution: "Windows Security Events", table: "SecurityEvent" },
  wineventlog_application: { solution: "Windows Security Events", table: "SecurityEvent" },
  cloudtrail: { solution: "Amazon Web Services", table: "AWSCloudTrail" },
  amazon_security_lake: { solution: "Amazon Web Services", table: "AWSCloudTrail" },
  linux_auditd: { solution: "Syslog", table: "Syslog" },
  azure_monitor_aad: { solution: "Microsoft Entra ID", table: "SigninLogs" },
  cisco_secure_firewall: { solution: "Cisco ASA", table: "CommonSecurityLog" },
  zscaler_proxy: { solution: "Zscaler Internet Access", table: "CommonSecurityLog" },
  okta: { solution: "Okta Single Sign-On", table: "Okta_CL" },
  github_enterprise: { solution: "GitHub Enterprise", table: "GitHubAuditData" },
  kubernetes_metrics: { solution: "Azure Kubernetes Service", table: "ContainerLog" },
  kube_audit: { solution: "Azure Kubernetes Service", table: "ContainerLog" },
  splunkd: { solution: "", table: "" },
  splunkd_web: { solution: "", table: "" },
  splunkd_ui: { solution: "", table: "" },
  splunkda: { solution: "", table: "" },
  splunkd_webx: { solution: "", table: "" },
  audit_searches: { solution: "", table: "" },
  cisco_ai_defense: { solution: "Cisco Secure Endpoint", table: "CommonSecurityLog" },
  appdynamics_security: { solution: "Cisco Secure Application", table: "CommonSecurityLog" },
  crushftp: { solution: "Syslog", table: "Syslog" },
  o365_management_activity: { solution: "Microsoft 365", table: "OfficeActivity" },
  admon: { solution: "Windows Security Events", table: "SecurityEvent" },
  ntlm_audit: { solution: "Windows Security Events", table: "SecurityEvent" },
  applocker: { solution: "Windows Security Events", table: "SecurityEvent" },
  windows_shells: { solution: "Windows Security Events", table: "SecurityEvent" },
  windows_exchange_iis: { solution: "Microsoft Exchange", table: "W3CIISLog" },
  msexchange_management: { solution: "Microsoft Exchange", table: "Event" },
  suricata: { solution: "Suricata", table: "CommonSecurityLog" },
  pingid: { solution: "PingID", table: "PingID_CL" },
  circleci: { solution: "CircleCI", table: "CircleCI_CL" },
  papercutng: { solution: "PaperCut", table: "Syslog" },
  remoteconnectionmanager: { solution: "Windows Security Events", table: "SecurityEvent" },
  subjectinterfacepackage: { solution: "Windows Security Events", table: "SecurityEvent" },
  certificateservices_lifecycle: { solution: "Windows Security Events", table: "SecurityEvent" },
};

/**
 * Splunk data models -> { solution, table }. Top-level names only - the
 * parser collapses sub-models (Endpoint.Processes -> Endpoint) first.
 */
export const SPLUNK_DATAMODEL_MAP: Record<string, SolutionTableTarget> = {
  Endpoint: { solution: "Windows Security Events", table: "SecurityEvent" },
  Authentication: { solution: "Windows Security Events", table: "SecurityEvent" },
  Network_Traffic: { solution: "Windows Security Events", table: "CommonSecurityLog" },
  Web: { solution: "Windows Security Events", table: "CommonSecurityLog" },
  Network_Resolution: { solution: "Windows Security Events", table: "DnsEvents" },
  Email: { solution: "Microsoft 365", table: "EmailEvents" },
  Change: { solution: "Windows Security Events", table: "SecurityEvent" },
  Intrusion_Detection: { solution: "Windows Security Events", table: "CommonSecurityLog" },
  Network_Sessions: { solution: "Windows Security Events", table: "CommonSecurityLog" },
  Updates: { solution: "Windows Security Events", table: "SecurityEvent" },
  Certificates: { solution: "Windows Security Events", table: "CommonSecurityLog" },
  Risk: { solution: "", table: "" },
  Splunk_Audit: { solution: "", table: "" },
};

/** QRadar content extensions -> { solution, table }. Empty = not migrated. */
export const QRADAR_EXTENSION_MAP: Record<string, SolutionTableTarget> = {
  "IBM QRadar Endpoint Content Extension": { solution: "Windows Security Events", table: "SecurityEvent" },
  "IBM QRadar Content Extension for Sysmon": { solution: "Windows Security Events", table: "SecurityEvent" },
  "IBM QRadar Baseline Maintenance Content Extension": { solution: "", table: "" },
  "IBM QRadar Baseline Maintenance Content Extension v7.3.3 FP4+": { solution: "", table: "" },
  "IBM QRadar Security Threat Monitoring Content Extension": { solution: "Threat Intelligence", table: "ThreatIntelligenceIndicator" },
  "IBM Security QRadar Techniques for Turla Content Extension": { solution: "Threat Intelligence", table: "ThreatIntelligenceIndicator" },
  "IBM Security GPG13 Content": { solution: "Windows Security Events", table: "SecurityEvent" },
  "IBM Security ISO 27001 Content": { solution: "", table: "" },
  "IBM Security QRadar Content Extension for Hybrid Cloud Use Cases": { solution: "Azure Activity", table: "AzureActivity" },
  "IBM Security QRadar Reconnaissance Content Extension": { solution: "Firewall", table: "CommonSecurityLog" },
  "IBM QRadar Data Exfiltration Content Extension": { solution: "Firewall", table: "CommonSecurityLog" },
  "IBM Security QRadar Network Anomaly Content Extension": { solution: "Firewall", table: "CommonSecurityLog" },
  "IBM QRadar DNS Analyzer": { solution: "DNS", table: "DnsEvents" },
  "IBM QRadar Compliance Content Extension": { solution: "", table: "" },
  "IBM QRadar Phishing and Email Content Extension": { solution: "Microsoft 365", table: "EmailEvents" },
  "IBM QRadar Container Content Extension": { solution: "Azure Kubernetes Service", table: "ContainerLog" },
  "IBM Security QRadar Content Extension for SysFlow": { solution: "Syslog", table: "Syslog" },
  "IBM QRadar Cryptomining Content Extension": { solution: "Threat Intelligence", table: "ThreatIntelligenceIndicator" },
  "IBM QRadar Network Insights Content Extension": { solution: "Firewall", table: "CommonSecurityLog" },
  "IBM QRadar SOX Content Extension": { solution: "", table: "" },
  "IBM QRadar NERC Content Extension": { solution: "", table: "" },
  "IBM QRadar GLBA Content Extension": { solution: "", table: "" },
  "IBM QRadar FISMA Content Extension": { solution: "", table: "" },
  "IBM QRadar Content Extension for GDPR": { solution: "", table: "" },
};

/** Splunk internal macros to skip during extraction (not data sources). */
export const SPLUNK_INTERNAL_MACROS: ReadonlySet<string> = new Set([
  "security_content_summariesonly",
  "security_content_ctime",
  "drop_dm_object_name",
  "cim_entity_resolution",
]);

/**
 * Prefix-based grouping for Splunk macros not in the static table (ORDERED -
 * first matching prefix wins).
 */
export const SPLUNK_PREFIX_MAP: ReadonlyArray<
  { prefix: string } & SolutionTableTarget
> = [
  { prefix: "process_", solution: "Windows Security Events", table: "SecurityEvent" },
  { prefix: "wineventlog_", solution: "Windows Security Events", table: "SecurityEvent" },
  { prefix: "o365_", solution: "Microsoft 365", table: "OfficeActivity" },
  { prefix: "ms365_", solution: "Microsoft 365", table: "OfficeActivity" },
  { prefix: "azure_", solution: "Microsoft Entra ID", table: "SigninLogs" },
  { prefix: "gws_", solution: "Google Workspace", table: "GoogleWorkspace_CL" },
  { prefix: "gsuite_", solution: "Google Workspace", table: "GoogleWorkspace_CL" },
  { prefix: "google_", solution: "Google Workspace", table: "GCPAuditLog_CL" },
  { prefix: "crowdstrike_", solution: "CrowdStrike Falcon Endpoint Protection", table: "CommonSecurityLog" },
  { prefix: "github_", solution: "GitHub Enterprise", table: "GitHubAuditData" },
  { prefix: "kube_", solution: "Azure Kubernetes Service", table: "ContainerLog" },
  { prefix: "kubernetes_", solution: "Azure Kubernetes Service", table: "ContainerLog" },
  { prefix: "aws_", solution: "Amazon Web Services", table: "AWSCloudTrail" },
  { prefix: "cisco_", solution: "Cisco ASA", table: "CommonSecurityLog" },
  { prefix: "ms_defender", solution: "Microsoft Defender XDR", table: "SecurityAlert" },
  { prefix: "stream_", solution: "Windows Security Events", table: "SecurityEvent" },
  { prefix: "zeek_", solution: "Windows Security Events", table: "SecurityEvent" },
  { prefix: "iis_", solution: "Windows Security Events", table: "W3CIISLog" },
  { prefix: "nginx_", solution: "Syslog", table: "Syslog" },
  { prefix: "f5_", solution: "Cisco ASA", table: "CommonSecurityLog" },
];

/** Macros that are Splunk-internal and excluded entirely (no data source). */
export const SPLUNK_SKIP_MACROS: ReadonlySet<string> = new Set([
  "splunkd",
  "splunkda",
  "splunkd_web",
  "splunkd_ui",
  "splunkd_webx",
  "splunkd_webs",
  "splunk_python",
  "splunkd_failed_auths",
  "audit_searches",
  "remote_access_software_usage_exceptions",
  "previously_unseen_cloud_provisioning_activity_window",
  "previously_seen_zoom_child_processes_window",
  "previously_seen_windows_services_window",
  "prohibited_apps_launching_cmd_macro",
  "is_windows_system_file_macro",
  "is_net_windows_file_macro",
  "is_nirsoft_software_macro",
  "potentially_malicious_code_on_cmdline_tokenize_score",
  "potential_password_in_username_false_positive_reduction",
  "system_network_configuration_discovery_tools",
  "path_traversal_spl_injection",
  "ransomware_notes",
  "dynamic_dns_providers",
  "brand_abuse_web",
  "suspicious_email_attachments",
  "bootloader_inventory",
  "driverinventory",
  "important_audit_policy_subcategory_guids",
]);

/** Whether a Splunk macro is a filter/helper, not a data-source identifier. */
export function isSplunkFilterMacro(macro: string): boolean {
  if (SPLUNK_MACRO_MAP[macro]) return false;
  if (SPLUNK_SKIP_MACROS.has(macro)) return true;
  return (
    macro.endsWith("_filter") ||
    macro.endsWith("_ctime") ||
    macro.startsWith("get_") ||
    macro.startsWith("set_") ||
    macro.startsWith("lookup_") ||
    macro.startsWith("notable_")
  );
}

/** Resolve a macro via the static table, then the ordered prefix map. */
export function resolveSplunkMacro(macro: string): SolutionTableTarget | null {
  const direct = SPLUNK_MACRO_MAP[macro];
  if (direct) return direct;
  for (const { prefix, solution, table } of SPLUNK_PREFIX_MAP) {
    if (macro.startsWith(prefix)) return { solution, table };
  }
  return null;
}
