/**
 * SIEM Migration knowledge bases (porting-plan Unit 26): the load-bearing
 * mapping IP, ported VERBATIM from the legacy siem-migration.ts (lines
 * 70-236) as versioned data assets. Derived from actual customer exports -
 * extend by appending entries, never by rewriting existing ones (each entry
 * is evidence from a real migration).
 *
 * Pure data + three pure predicates. No IO.
 *
 * THE SOLUTION NAME IS AN ADDRESS, NOT A LABEL (DBT-103, DBT-104). Every
 * non-empty `solution` below is handed to the Integrate screen as a deep link
 * (`#/?solution=<name>`) and resolved against the repo's `Solutions/`
 * directories, so a name that no directory carries produces a pivot that
 * silently lands nowhere, and a name belonging to a DIFFERENT vendor produces
 * one that lands somewhere wrong with the same confidence badge as every
 * correct row. Both were live: `f5_` and `zeek_` named other vendors' products
 * (DBT-103), and ten of the 24 solution names then in these maps reached no
 * directory at all, while an eleventh reached one only through a rung the
 * product did not yet have (DBT-104).
 *
 * THE LADDER THIS DEPENDS ON GREW WHILE THE FIX WAS BEING WRITTEN. Until
 * 2026-09-04 resolveSelectedSolution stopped at case-insensitive-exact; the
 * third, SEPARATOR-INSENSITIVE rung landed that same day (DBT-28). An earlier
 * draft of this header said the audit had used "the browser's own resolution
 * ladder" including that rung. It did not exist yet, so that audit credited
 * one name - "Cisco ASA" - with resolving through a rung the product did not
 * have, and the count below it was one short.
 *
 * RE-MEASURED 2026-09-04 against both current things: the live listing (GET
 * api.github.com/repos/Azure/Azure-Sentinel/contents/Solutions - 574
 * directories plus 7 files) and the three-rung ladder as it now stands. Of the
 * 27 distinct non-empty solution names below (26 before the `zeek_` fix in
 * this same change added Corelight),
 *
 *   18  match a directory EXACTLY;
 *    1  case-insensitively only - "Azure Kubernetes Service", whose directory
 *       is spelled "Azure kubernetes Service". Kept in the readable casing on
 *       purpose: the rung matches either spelling, so copying upstream's typo
 *       verbatim would buy an exact match now and lose it the day upstream
 *       fixes its own name;
 *    1  separator-insensitively only - "Cisco ASA", directory "CiscoASA";
 *    7  match nothing at any rung, and are exactly the seven declared in
 *       {@link SOLUTIONS_WITHOUT_SENTINEL_FOLDER}. Nothing is undeclared.
 *
 * Those two rung dependencies are pinned, not just written here:
 * `solution-directories.fixture.json` carries the 574 names and the pins in
 * siem-migration.test.ts assert WHICH rung each name needs, so a spacing-only
 * edit that pushes a name off the exact rung fails there. That the PRODUCT
 * still offers the rung is browser-state.test.ts's pin - core cannot import
 * ui, so the two halves are split on purpose and neither claims the other's.
 *
 * Four names the audit found were mapping gaps - a directory existed under
 * another name (DNS, GitHub Enterprise, Microsoft Exchange, and Google
 * Workspace for the gws_/gsuite_ prefixes) - and those entries now point at
 * it. None of the seven declared names was repointed at a plausible-looking
 * neighbour: inventing a folder name would add exactly the defect DBT-103 is
 * about.
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
  // DBT-104: was "GitHub Enterprise", which names no directory. The one that
  // does is "GitHub", and its connectors declare GitHubAuditData - the table
  // this entry already carried.
  github_enterprise: { solution: "GitHub", table: "GitHubAuditData" },
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
  // DBT-104: both were "Microsoft Exchange", which names no directory. The
  // index carries two Exchange directories - "... - Exchange On-Premises" and
  // "... - Exchange Online". Both entries here are ON-PREMISES signals (IIS
  // logs from the Exchange servers; the MSExchange Management Windows event
  // log), and the On-Premises solution's connectors declare both W3CIISLog and
  // Event - the tables these entries already carried.
  windows_exchange_iis: {
    solution: "Microsoft Exchange Security - Exchange On-Premises",
    table: "W3CIISLog",
  },
  msexchange_management: {
    solution: "Microsoft Exchange Security - Exchange On-Premises",
    table: "Event",
  },
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
  // DBT-104: was "DNS", which names no directory. Five directories mention
  // DNS; only "Windows Server DNS" declares DnsEvents (plus
  // ASimDnsActivityLogs) - the table this entry already carried, and a table
  // only the Windows DNS connector populates. "DNS Essentials" has no Data
  // Connectors directory at all, so it can never be an ingestion pivot.
  "IBM QRadar DNS Analyzer": { solution: "Windows Server DNS", table: "DnsEvents" },
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
  // DBT-104: "Google Workspace" names no directory; "GoogleWorkspaceReports"
  // does, and gws_/gsuite_ unambiguously mean Workspace. Its nine connectors
  // declare seven per-API tables (GWorkspace_ReportsAPI_admin_CL, _calendar_CL,
  // _drive_CL, _login_CL, _mobile_CL, _token_CL, _user_accounts_CL) and no
  // GoogleWorkspace_CL - that table was in this entry but exists nowhere in the
  // solution, so it is blank rather than wrong: which of the seven a given
  // macro feeds is not knowable from the prefix. The UI renders a blank table
  // as "(resolved at integration)".
  { prefix: "gws_", solution: "GoogleWorkspaceReports", table: "" },
  { prefix: "gsuite_", solution: "GoogleWorkspaceReports", table: "" },
  // DBT-104: `google_` cannot be resolved the same way - it covers Workspace
  // AND Google Cloud, and this entry's own table (GCPAuditLog_CL) belongs to
  // neither solution: the GCP audit connector declares GCPAuditLogs. Left
  // naming a solution that resolves to nothing, and DECLARED as such below,
  // rather than guessed at.
  { prefix: "google_", solution: "Google Workspace", table: "" },
  { prefix: "crowdstrike_", solution: "CrowdStrike Falcon Endpoint Protection", table: "CommonSecurityLog" },
  { prefix: "github_", solution: "GitHub", table: "GitHubAuditData" },
  { prefix: "kube_", solution: "Azure Kubernetes Service", table: "ContainerLog" },
  { prefix: "kubernetes_", solution: "Azure Kubernetes Service", table: "ContainerLog" },
  { prefix: "aws_", solution: "Amazon Web Services", table: "AWSCloudTrail" },
  { prefix: "cisco_", solution: "Cisco ASA", table: "CommonSecurityLog" },
  { prefix: "ms_defender", solution: "Microsoft Defender XDR", table: "SecurityAlert" },
  { prefix: "stream_", solution: "Windows Security Events", table: "SecurityEvent" },
  // DBT-103, second instance: this read `Windows Security Events` /
  // `SecurityEvent`. Zeek is open-source network monitoring; SecurityEvent is
  // the Windows security event log. Every zeek_ macro in a Splunk export was
  // therefore pointed at a Microsoft Windows solution, with the same medium
  // badge and the same working pivot button as a correct row - the f5_ defect
  // with a different pair of vendors.
  //
  // Corelight is where Zeek lands in Sentinel, and that is measured, not
  // inferred. No directory contains "zeek" at all, and none is named Bro (the
  // two carrying those three letters are "Broadcom SymantecDLP" and "Ermes
  // Browser Security"); "Corelight" is a directory, at the exact rung. Its one
  // connector, CorelightExporter, says in its own description that it ingests
  // "events from Zeek and Suricata via Corelight Sensors ... using the Azure
  // Monitor Logs Ingestion API", and of its 238 dataTypes at least 23 are
  // named verbatim for a core Zeek log (conn, dns, http, ssl, files, notice,
  // x509, ftp, ssh, dhcp, ...), each routed to its own table -
  // Corelight_v3_conn_CL, _dns_CL, and so on. That 23 is a FLOOR - it was
  // counted against a hand-listed set of Zeek log names, not all of them. The
  // remainder are further per-analyser streams of the same shape (bacnet, cip,
  // amqp and so on), of which 20 are Corelight's own analytics and 4 are
  // Suricata. This repo had already reached the same conclusion once:
  // the log-type catalog's `corelight-zeek` entry claims the keywords
  // "corelight", "zeek" and "bro" for exactly this reason.
  //
  // The table is BLANK for the same reason gws_'s is: one table per Zeek log
  // type, and a prefix does not say which of the 238. The UI renders a blank
  // table as "(resolved at integration)"; a guessed one would be a second
  // confident wrong answer stacked on the first.
  { prefix: "zeek_", solution: "Corelight", table: "" },
  { prefix: "iis_", solution: "Windows Security Events", table: "W3CIISLog" },
  { prefix: "nginx_", solution: "Syslog", table: "Syslog" },
  // DBT-103: this read `Cisco ASA`. F5 and Cisco ASA are different vendors and
  // different products, so every f5_ macro and f5_ sourcetype in a Splunk
  // export was pointed at a Cisco firewall solution - carrying the same
  // "medium confidence" badge and the same working "Open in Sentinel
  // Integration" button as every other prefix-resolved row, which deep-linked
  // the operator INTO the Cisco ASA solution. Nothing downstream contradicts a
  // mapping that resolves; it just resolves to the wrong vendor.
  //
  // A case-insensitive /f5/ scan of the 574 directories returns exactly two:
  // "F5 Networks", whose connectors declare CommonSecurityLog and Syslog, and
  // "F5 BIG-IP", whose connector declares F5Telemetry_ASM_CL / _LTM_CL /
  // _system_CL. The table this entry already carried - CommonSecurityLog,
  // evidence from a real migration - is declared by the first and by neither
  // table of the second, so F5 Networks is the solution the entry was already
  // describing.
  { prefix: "f5_", solution: "F5 Networks", table: "CommonSecurityLog" },
];

/**
 * Solution names in the maps above that name NO directory under `Solutions/`,
 * with what was checked (see the module header for the index and the
 * resolution ladder). These are DECLARED rather than repointed: for four other
 * names a directory did exist under a different name and those entries were
 * fixed, but for these seven either nothing matches at all (five of them), or
 * several match and the SIEM identifier does not say which (two).
 *
 * {@link hasSentinelSolutionFolder} is what turns this into behaviour: plan
 * assembly refuses to award such a mapping high or medium confidence, so the
 * operator sees a "low confidence" badge instead of a pivot button that looks
 * as settled as a working one.
 */
export const SOLUTIONS_WITHOUT_SENTINEL_FOLDER: Readonly<
  Record<string, string>
> = {
  CircleCI:
    "No directory matches /circle/. Sentinel ships no CircleCI solution, so " +
    "the CircleCI_CL table this entry names has to be built by hand.",
  "Cisco Secure Application":
    "No directory matches /appdynamic/ or /secure application/. The index " +
    "carries 15 Cisco directories (ASA, ACI, ETD, Firepower EStreamer, ISE, " +
    "Meraki x2, SD-WAN, Secure Cloud Analytics, Secure Endpoint, UCS, Duo, " +
    "SEG, Umbrella, WSA) and none of them is Secure Application.",
  Firewall:
    "UNKNOWN rather than absent. 'Firewall' is a category, not a product: ten " +
    "directories have Firewall in the name (shortened here - Azure Firewall, " +
    "Barracuda CloudGen, Fortinet FortiGate, SonicWall, Sophos XG, Windows " +
    "Firewall, AWS NetworkFirewall, GCP Firewall Logs, Azure WAF, Citrix Web " +
    "App Firewall) plus vendors like PaloAlto-PAN-OS and Check Point. The " +
    "three QRadar extensions mapped here name no vendor, so which one is not " +
    "knowable from the export.",
  "Google Workspace":
    "UNKNOWN rather than absent, and reached only by the `google_` prefix " +
    "now. That prefix covers both Workspace (directory " +
    "GoogleWorkspaceReports) and Google Cloud (directory 'Google Cloud " +
    "Platform Audit Logs', table GCPAuditLogs), and the table this entry " +
    "carried - GCPAuditLog_CL - is declared by neither. gws_/gsuite_, which " +
    "do say Workspace, were repointed at GoogleWorkspaceReports.",
  PaperCut:
    "No directory matches /papercut/. PaperCut logs land in Syslog, which IS " +
    "a directory in the index, but the Syslog solution is not PaperCut under " +
    "another name - crushftp and linux_auditd are mapped to it deliberately " +
    "and this entry was not, so redirecting it here would be a decision, not " +
    "a correction.",
  PingID:
    "No directory matches /pingid/. The index has PingFederate and PingOne, " +
    "which are different Ping products; PingFederate's connectors declare " +
    "CommonSecurityLog, Syslog and Event, not the PingID_CL table this entry " +
    "names.",
  Suricata:
    "No directory matches /suricata/. Corelight is the near miss, and the " +
    "reason for not using it is now measured instead of waved at: its " +
    "connector DOES declare four Suricata tables (Corelight_v3_suricata_eve" +
    "_CL, _corelight_CL, _stats_CL, _zeek_stats_CL), but those carry a " +
    "Corelight SENSOR's export of Suricata, while this entry's evidence " +
    "table is CommonSecurityLog - a standalone Suricata shipping CEF over " +
    "syslog. Repointing would swap the delivery path as well as the name, " +
    "and this file has no evidence for that. The zeek_ prefix WAS repointed " +
    "at Corelight because there the tables are literally Zeek's log types.",
};

/**
 * Whether a knowledge-base solution name can actually be opened in Sentinel
 * Integration. False for the empty string (no mapping at all) and for every
 * name in {@link SOLUTIONS_WITHOUT_SENTINEL_FOLDER}.
 */
export function hasSentinelSolutionFolder(solution: string): boolean {
  return (
    solution !== "" &&
    SOLUTIONS_WITHOUT_SENTINEL_FOLDER[solution] === undefined
  );
}

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
