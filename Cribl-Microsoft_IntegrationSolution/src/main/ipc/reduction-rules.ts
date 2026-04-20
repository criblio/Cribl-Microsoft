// Reduction Knowledge Base
// Defines per-table and per-vendor event filtering rules for reducing
// Sentinel ingestion volume while preserving analytics rule coverage.
//
// Each rule set contains:
//   keep:      Events that MUST be kept (analytics rules depend on them)
//   drop:      Events safe to eliminate entirely (no analytics rule queries them)
//   suppress:  Noisy events that can be sampled or aggregated
//
// Filter expressions use Cribl's JavaScript expression syntax.
// Suppress rules define a groupKey (fields to aggregate on) and
// a windowSec (time window for suppression).

export interface ReductionRule {
  id: string;
  description: string;
  filter: string;
  reason: string;
}

export interface SuppressRule extends ReductionRule {
  groupKey: string;
  windowSec: number;
  maxEvents?: number;
}

export interface TableReductionRules {
  keep: ReductionRule[];
  drop: ReductionRule[];
  suppress: SuppressRule[];
}

export interface ReductionKnowledgeBase {
  [tableOrVendor: string]: TableReductionRules;
}

// ---------------------------------------------------------------------------
// Native Sentinel Tables
// ---------------------------------------------------------------------------

const commonSecurityLog: TableReductionRules = {
  keep: [
    {
      id: 'csl_denied_blocked',
      description: 'Blocked/denied traffic',
      filter: "/deny|drop|block|reject|reset/i.test(DeviceAction || '')",
      reason: 'Sentinel analytics rules for threat detection, lateral movement, and C2 depend on denied/blocked events',
    },
    {
      id: 'csl_high_severity',
      description: 'High/critical severity events',
      filter: "(Number(LogSeverity) >= 7) || /high|critical|emergency|alert/i.test(LogSeverity || '')",
      reason: 'High severity CEF events are queried by multiple threat detection and incident creation rules',
    },
    {
      id: 'csl_auth_events',
      description: 'Authentication events',
      filter: "/auth|login|logon|logoff|logout|credential|password|sso|mfa/i.test(Activity || DeviceEventClassID || '')",
      reason: 'Authentication analytics rules (brute force, impossible travel, credential stuffing) require all auth events',
    },
    {
      id: 'csl_malware_ids',
      description: 'Malware and IDS/IPS detections',
      filter: "/malware|virus|trojan|exploit|intrusion|ips|ids|threat|apt|ransomware|botnet|c2|command.and.control/i.test(Activity || DeviceEventClassID || cat || '')",
      reason: 'Threat intelligence and malware detection analytics depend on these events',
    },
    {
      id: 'csl_policy_violation',
      description: 'Policy and compliance violations',
      filter: "/policy|violation|compliance|unauthorized|forbidden/i.test(Activity || DeviceEventClassID || '')",
      reason: 'Compliance and policy violation analytics rules require these events',
    },
    {
      id: 'csl_admin_activity',
      description: 'Administrative and configuration changes',
      filter: "/admin|config|modify|change|update|create|delete|remove|install|uninstall/i.test(Activity || DeviceEventClassID || '')",
      reason: 'Privileged activity monitoring and change detection rules query admin events',
    },
  ],
  drop: [
    {
      id: 'csl_routine_allow_443',
      description: 'Routine allowed HTTPS traffic',
      filter: "/allow|permit|pass|accept/i.test(DeviceAction || '') && (DestinationPort == 443 || DestinationPort == 80) && !(/deny|drop|block/i.test(Activity || ''))",
      reason: 'No built-in analytics rule queries bulk allowed web traffic; threat rules focus on denied connections and specific indicators',
    },
    {
      id: 'csl_heartbeat_keepalive',
      description: 'Heartbeat and keepalive messages',
      filter: "/heartbeat|keepalive|health.check|ping|status.check|monitor/i.test(Activity || DeviceEventClassID || '')",
      reason: 'Infrastructure monitoring heartbeats are not queried by any Sentinel analytics rule',
    },
    {
      id: 'csl_dns_routine',
      description: 'Routine DNS lookups (non-security)',
      filter: "/dns/i.test(DeviceEventClassID || '') && /allow|permit|pass/i.test(DeviceAction || '') && !(/nxdomain|tunnel|exfil|dga|malware|threat|suspicious/i.test(Activity || cat || ''))",
      reason: 'Routine successful DNS queries generate high volume with no analytics value; DNS analytics focus on NXDOMAIN, tunneling, and threat indicators',
    },
    {
      id: 'csl_nat_translation',
      description: 'NAT translation events',
      filter: "/nat|translation|pat|snat|dnat/i.test(DeviceEventClassID || Activity || '') && !/fail|error|deny/i.test(DeviceAction || '')",
      reason: 'NAT translation logs are purely operational; no Sentinel analytics rule queries them',
    },
  ],
  suppress: [
    {
      id: 'csl_allowed_traffic_agg',
      description: 'Aggregate allowed traffic by source/dest/port',
      filter: "/allow|permit|pass|accept/i.test(DeviceAction || '') && !(/deny|drop|block/i.test(Activity || ''))",
      reason: 'Allowed traffic that passes keep rules can be aggregated to reduce volume while preserving connection metadata',
      groupKey: "SourceIP + ':' + DestinationIP + ':' + DestinationPort + ':' + DeviceProduct",
      windowSec: 300,
      maxEvents: 1,
    },
    {
      id: 'csl_vpn_session',
      description: 'Suppress repeated VPN session updates',
      filter: "/vpn|tunnel|ipsec|ssl.vpn/i.test(DeviceEventClassID || Activity || '')",
      reason: 'VPN session keepalives generate many duplicate events; one per 5 minutes preserves session tracking',
      groupKey: "SourceIP + ':' + DestinationUserName",
      windowSec: 300,
      maxEvents: 1,
    },
  ],
};

const syslog: TableReductionRules = {
  keep: [
    {
      id: 'sys_auth_events',
      description: 'Authentication facility events',
      filter: "Facility == 'auth' || Facility == 'authpriv' || Facility == 'local6'",
      reason: 'Sentinel SSH brute force, sudo abuse, and Linux authentication analytics require all auth/authpriv events',
    },
    {
      id: 'sys_high_severity',
      description: 'Emergency/Alert/Critical severity',
      filter: "SeverityLevel == 'emerg' || SeverityLevel == 'alert' || SeverityLevel == 'crit' || SeverityLevel == 'err'",
      reason: 'Error and above severity events are queried by system health and security incident analytics rules',
    },
    {
      id: 'sys_security_keywords',
      description: 'Security-relevant syslog messages',
      filter: "/failed|failure|invalid|unauthorized|denied|blocked|attack|exploit|overflow|segfault|oom|killed|panic|fatal|root|sudo|su:/i.test(SyslogMessage || '')",
      reason: 'Security-related keywords in syslog messages are matched by multiple Sentinel analytics rules for Linux threat detection',
    },
    {
      id: 'sys_kernel_security',
      description: 'Kernel security events',
      filter: "Facility == 'kern' && /apparmor|selinux|audit|iptables|netfilter|seccomp/i.test(SyslogMessage || '')",
      reason: 'Kernel security subsystem events are required for host-based threat detection analytics',
    },
    {
      id: 'sys_ssh_events',
      description: 'All SSH-related events',
      filter: "ProcessName == 'sshd' || /ssh/i.test(SyslogMessage || '')",
      reason: 'SSH analytics rules (brute force, lateral movement, tunneling) require all sshd events',
    },
  ],
  drop: [
    {
      id: 'sys_cron_routine',
      description: 'Routine cron execution logs',
      filter: "Facility == 'cron' && /CMD|session opened|session closed/i.test(SyslogMessage || '') && !/failed|error|denied/i.test(SyslogMessage || '')",
      reason: 'Routine cron execution generates high volume; no Sentinel analytics rule queries successful cron runs',
    },
    {
      id: 'sys_dhcp_routine',
      description: 'Routine DHCP lease events',
      filter: "(ProcessName == 'dhclient' || ProcessName == 'dhcpd' || ProcessName == 'NetworkManager') && /bound|renew|lease|DHCPACK|DHCPREQUEST/i.test(SyslogMessage || '')",
      reason: 'DHCP lease renewals are operational noise with no analytics coverage',
    },
    {
      id: 'sys_ntp_sync',
      description: 'NTP time sync messages',
      filter: "(ProcessName == 'ntpd' || ProcessName == 'chronyd' || ProcessName == 'systemd-timesyncd') && !/error|fail|panic/i.test(SyslogMessage || '')",
      reason: 'Time synchronization messages are purely operational',
    },
    {
      id: 'sys_systemd_routine',
      description: 'Routine systemd service start/stop',
      filter: "ProcessName == 'systemd' && /Started|Stopped|Starting|Stopping|Reached target|Listening on/i.test(SyslogMessage || '') && !/fail|error|crash|abort|core dump/i.test(SyslogMessage || '')",
      reason: 'Normal systemd lifecycle events generate high volume; analytics only care about failures',
    },
    {
      id: 'sys_postfix_routine',
      description: 'Routine mail delivery logs',
      filter: "/postfix|sendmail|dovecot/i.test(ProcessName || '') && /status=sent|delivered|removed|connect from/i.test(SyslogMessage || '') && !/reject|error|fail|auth|sasl/i.test(SyslogMessage || '')",
      reason: 'Successful mail delivery logs are not queried by any analytics rule; mail analytics focus on auth failures and rejections',
    },
  ],
  suppress: [
    {
      id: 'sys_daemon_info',
      description: 'Aggregate daemon informational messages',
      filter: "Facility == 'daemon' && (SeverityLevel == 'info' || SeverityLevel == 'notice') && !/fail|error|denied|attack|root|sudo/i.test(SyslogMessage || '')",
      reason: 'Informational daemon messages are high volume; one per host per 5 minutes preserves context',
      groupKey: "Computer + ':' + ProcessName",
      windowSec: 300,
      maxEvents: 1,
    },
    {
      id: 'sys_kern_info',
      description: 'Aggregate kernel informational messages',
      filter: "Facility == 'kern' && (SeverityLevel == 'info' || SeverityLevel == 'notice') && !/apparmor|selinux|audit|iptables|netfilter|seccomp|error|fail|panic|oops/i.test(SyslogMessage || '')",
      reason: 'Routine kernel info messages (hardware, driver) can be aggregated without analytics impact',
      groupKey: "Computer",
      windowSec: 300,
      maxEvents: 1,
    },
  ],
};

const windowsEvent: TableReductionRules = {
  keep: [
    {
      id: 'win_security_critical',
      description: 'Critical security EventIDs',
      // 4624=Logon, 4625=Failed logon, 4648=Explicit cred logon, 4672=Special privs,
      // 4688=Process creation, 4689=Process exit, 4697=Service install,
      // 4698-4702=Scheduled task events, 4720=Account created, 4722-4726=Account mgmt,
      // 4728-4737=Group membership, 4740=Lockout, 4756=Member added to universal group,
      // 4767=Unlock, 4768-4771=Kerberos events, 4776=NTLM auth, 1102=Log cleared
      filter: "[4624,4625,4648,4672,4688,4689,4697,4698,4699,4700,4701,4702,4720,4722,4723,4724,4725,4726,4728,4729,4730,4731,4732,4733,4734,4735,4736,4737,4740,4756,4767,4768,4769,4770,4771,4776,1102].includes(Number(EventID))",
      reason: 'These EventIDs are referenced by Sentinel analytics rules for logon monitoring, privilege escalation, persistence, credential access, and audit tampering',
    },
    {
      id: 'win_powershell_execution',
      description: 'PowerShell script block and module logging',
      // 4103=Module logging, 4104=Script block logging, 4105/4106=Script start/stop
      filter: "[4103,4104,4105,4106].includes(Number(EventID)) || (Channel == 'Microsoft-Windows-PowerShell/Operational')",
      reason: 'PowerShell analytics rules (obfuscation, encoded commands, malicious scripts) require all script block and module events',
    },
    {
      id: 'win_defender_events',
      description: 'Windows Defender and security product events',
      filter: "Channel == 'Microsoft-Windows-Windows Defender/Operational' || /Defender|Antimalware|AntiVirus/i.test(Provider || '')",
      reason: 'Antimalware detection and response analytics require all Defender events',
    },
    {
      id: 'win_firewall_events',
      description: 'Windows Firewall connection events',
      // 5152=Packet dropped, 5156=Connection allowed, 5157=Connection blocked
      filter: "[5152,5156,5157].includes(Number(EventID))",
      reason: 'Network connection analytics rules use firewall allow/deny events for lateral movement detection',
    },
    {
      id: 'win_sysmon_events',
      description: 'Sysmon events (all)',
      filter: "Channel == 'Microsoft-Windows-Sysmon/Operational' || Provider == 'Microsoft-Windows-Sysmon'",
      reason: 'All Sysmon events are high-fidelity security telemetry used extensively by Sentinel analytics',
    },
    {
      id: 'win_rdp_events',
      description: 'RDP connection events',
      // 4624 type 10=RemoteInteractive, 4778=Session reconnect, 4779=Session disconnect
      // 1149=RDP auth success in TerminalServices
      filter: "[4778,4779,1149].includes(Number(EventID)) || (Number(EventID) == 4624 && LogonType == 10)",
      reason: 'RDP analytics rules (brute force, lateral movement, suspicious RDP) need all remote session events',
    },
    {
      id: 'win_wmi_events',
      description: 'WMI activity events',
      filter: "[5857,5858,5859,5860,5861].includes(Number(EventID))",
      reason: 'WMI persistence and lateral movement analytics require WMI operational events',
    },
    {
      id: 'win_bits_events',
      description: 'BITS transfer events',
      filter: "Channel == 'Microsoft-Windows-Bits-Client/Operational'",
      reason: 'BITS is used for data exfiltration and malware download; analytics rules monitor BITS transfers',
    },
  ],
  drop: [
    {
      id: 'win_noise_eventids',
      description: 'High-volume noise EventIDs with no analytics coverage',
      // 5379=Credential Manager read, 4663=Object access audit (volume),
      // 4658=Handle closed, 4656=Handle requested, 4690=Handle duplicated,
      // 5145=Network share check (very high volume), 4660=Object deleted,
      // 10016=DCOM permission, 6005/6006/6009=EventLog service start/stop/OS info
      filter: "[5379,4663,4658,4656,4690,5145,4660,10016,6005,6006,6009].includes(Number(EventID))",
      reason: 'These EventIDs generate extreme volume (handle operations, share access auditing, DCOM errors) and are not queried by any built-in Sentinel analytics rule',
    },
    {
      id: 'win_noise_process_exit',
      description: 'Process termination without matching creation',
      filter: "Number(EventID) == 4689 && !ProcessName",
      reason: 'Process exit events without process name context provide no analytics value',
    },
    {
      id: 'win_crypto_api',
      description: 'Routine crypto API operations',
      filter: "[5058,5059,5061].includes(Number(EventID))",
      reason: 'Cryptographic key operations generate high volume on servers with TLS; no analytics rule queries these',
    },
    {
      id: 'win_mpssvc_noise',
      description: 'Windows Filtering Platform (WFP) noise',
      // 5031=Firewall blocked app, 5154=Listen allowed, 5155=Listen blocked,
      // 5158=Bind permitted, 5159=Bind blocked
      filter: "[5031,5154,5155,5158,5159].includes(Number(EventID))",
      reason: 'WFP bind/listen events are infrastructure noise not queried by analytics rules; firewall analytics use 5152/5156/5157 instead',
    },
  ],
  suppress: [
    {
      id: 'win_logon_success_agg',
      description: 'Aggregate repeated successful logons per user/host',
      filter: "Number(EventID) == 4624 && (LogonType == 3 || LogonType == 5)",
      reason: 'Type 3 (network) and Type 5 (service) logons are extremely high volume; analytics rules for brute force use failed logons (4625) and specific logon types (10, 2)',
      groupKey: "Computer + ':' + TargetUserName + ':' + LogonType",
      windowSec: 300,
      maxEvents: 5,
    },
    {
      id: 'win_object_access_agg',
      description: 'Aggregate file/registry access audits',
      filter: "[4656,4663].includes(Number(EventID))",
      reason: 'Object access auditing generates massive volume; sampling preserves anomaly detection capability',
      groupKey: "Computer + ':' + SubjectUserName + ':' + ObjectName",
      windowSec: 60,
      maxEvents: 1,
    },
  ],
};

const azureActivity: TableReductionRules = {
  keep: [
    {
      id: 'azure_write_delete',
      description: 'Resource write and delete operations',
      filter: "OperationNameValue && (/write|delete|action/i.test(OperationNameValue || '') || /Create|Delete|Update|Remove|Start|Stop|Restart|Reset|Set|Revoke|Assign/i.test(OperationNameValue || ''))",
      reason: 'Resource modification analytics rules (suspicious deployment, resource deletion, role assignment) depend on write/delete/action operations',
    },
    {
      id: 'azure_failed_ops',
      description: 'Failed operations',
      filter: "/Failed|Failure|Error|Denied|Unauthorized|Forbidden/i.test(ActivityStatusValue || ActivityStatus || '')",
      reason: 'Failed operation analytics rules detect unauthorized access attempts and misconfiguration exploitation',
    },
    {
      id: 'azure_policy_events',
      description: 'Policy and RBAC events',
      filter: "/Microsoft.Authorization|Microsoft.PolicyInsights|roleAssignment|roleDefinition|lock/i.test(OperationNameValue || '')",
      reason: 'Privilege escalation and policy bypass analytics require all authorization and policy events',
    },
    {
      id: 'azure_security_events',
      description: 'Security-related resource operations',
      filter: "/Microsoft.Security|Microsoft.KeyVault|Microsoft.Network\\/networkSecurityGroups|Microsoft.Network\\/firewallPolicies/i.test(OperationNameValue || '')",
      reason: 'Security resource modification analytics (NSG changes, firewall rule changes, Key Vault access) need all security resource events',
    },
  ],
  drop: [
    {
      id: 'azure_read_ops',
      description: 'Read-only operations',
      filter: "/\\/read$/i.test(OperationNameValue || '') && /Succeeded|Success/i.test(ActivityStatusValue || ActivityStatus || '')",
      reason: 'Successful read operations are the highest volume Azure Activity events and no built-in analytics rule queries read-only operations',
    },
    {
      id: 'azure_list_ops',
      description: 'List operations',
      filter: "/\\/list/i.test(OperationNameValue || '') && /Succeeded|Success/i.test(ActivityStatusValue || ActivityStatus || '')",
      reason: 'List operations (listing resources, keys, etc.) are high volume operational events with no analytics coverage',
    },
    {
      id: 'azure_autoscale_health',
      description: 'Autoscale and health check events',
      filter: "/Microsoft.Insights\\/AutoscaleSettings|Microsoft.ResourceHealth|Microsoft.Advisor/i.test(OperationNameValue || '')",
      reason: 'Autoscale, resource health, and advisor events are operational and not queried by security analytics',
    },
  ],
  suppress: [
    {
      id: 'azure_metric_diagnostic',
      description: 'Aggregate diagnostic settings operations',
      filter: "/Microsoft.Insights\\/diagnosticSettings|Microsoft.Insights\\/metricAlerts/i.test(OperationNameValue || '')",
      reason: 'Diagnostic and metric alert operations can be aggregated without losing security context',
      groupKey: "Caller + ':' + OperationNameValue",
      windowSec: 600,
      maxEvents: 1,
    },
  ],
};

// ---------------------------------------------------------------------------
// Vendor-Specific Tables (Custom _CL tables)
// ---------------------------------------------------------------------------

const cloudflare: TableReductionRules = {
  keep: [
    {
      id: 'cf_waf_events',
      description: 'All WAF/Firewall events',
      filter: "sourcetype == 'cloudflare:waf' || /FirewallEvent|firewall_events/i.test(Type || source || '')",
      reason: 'All WAF events are security-relevant: blocks, challenges, JS challenges, managed rules, rate limiting',
    },
    {
      id: 'cf_http_errors',
      description: 'HTTP error responses (4xx, 5xx)',
      filter: "(sourcetype == 'cloudflare:json' || /HttpRequest|http_requests/i.test(Type || source || '')) && (Number(EdgeResponseStatus) >= 400 || Number(OriginResponseStatus) >= 400)",
      reason: 'HTTP errors indicate scanning, brute force, application attacks, and server-side issues',
    },
    {
      id: 'cf_http_large_response',
      description: 'Unusually large responses (potential data exfiltration)',
      filter: "(sourcetype == 'cloudflare:json' || /HttpRequest/i.test(Type || '')) && Number(EdgeResponseBytes) > 10000000",
      reason: 'Large response bodies may indicate data exfiltration; analytics rules use size thresholds',
    },
    {
      id: 'cf_http_suspicious_ua',
      description: 'Suspicious or empty user agents',
      filter: "(sourcetype == 'cloudflare:json' || /HttpRequest/i.test(Type || '')) && (!ClientRequestUserAgent || ClientRequestUserAgent == '' || /curl|wget|python|go-http|scanner|bot|nikto|sqlmap|nmap|masscan|dirbuster/i.test(ClientRequestUserAgent || ''))",
      reason: 'Empty or tool-based user agents indicate automated scanning or attack tools',
    },
    {
      id: 'cf_http_auth_paths',
      description: 'Requests to authentication and admin paths',
      filter: "(sourcetype == 'cloudflare:json' || /HttpRequest/i.test(Type || '')) && /\\/login|\\/auth|\\/admin|\\/api\\/token|\\/oauth|\\/signin|\\/wp-login|\\/xmlrpc/i.test(ClientRequestURI || '')",
      reason: 'Authentication endpoint traffic is needed for brute force and credential stuffing detection',
    },
    {
      id: 'cf_dns_nxdomain',
      description: 'DNS NXDOMAIN and error responses',
      filter: "(sourcetype == 'cloudflare:dns:zones' || /DNS|dns_logs/i.test(Type || source || '')) && (Number(ResponseCode) != 0)",
      reason: 'NXDOMAIN and DNS errors indicate DGA, tunneling, and reconnaissance activity',
    },
    {
      id: 'cf_dns_unusual_types',
      description: 'Unusual DNS query types',
      filter: "(sourcetype == 'cloudflare:dns:zones' || /DNS/i.test(Type || '')) && ![1,28,5,15,2,16].includes(Number(QueryType))",
      reason: 'Non-standard query types (TXT, SRV, NULL, ANY) can indicate tunneling or abuse; A, AAAA, CNAME, MX, NS, TXT are routine',
    },
  ],
  drop: [
    {
      id: 'cf_http_static_200',
      description: 'Successful requests for static assets',
      filter: "(sourcetype == 'cloudflare:json' || /HttpRequest/i.test(Type || '')) && Number(EdgeResponseStatus) == 200 && /\\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map)$/i.test(ClientRequestURI || '')",
      reason: 'Static asset 200s are the highest volume HTTP events; no analytics rule queries successful static content delivery',
    },
    {
      id: 'cf_http_304',
      description: 'Not Modified responses',
      filter: "(sourcetype == 'cloudflare:json' || /HttpRequest/i.test(Type || '')) && Number(EdgeResponseStatus) == 304",
      reason: '304 responses indicate cached content revalidation; purely operational with no security analytics value',
    },
    {
      id: 'cf_http_cached_hit',
      description: 'CDN cache hits for known-good content',
      filter: "(sourcetype == 'cloudflare:json' || /HttpRequest/i.test(Type || '')) && CacheCacheStatus == 'hit' && Number(EdgeResponseStatus) < 400 && !/\\/login|\\/auth|\\/admin|\\/api/i.test(ClientRequestURI || '')",
      reason: 'Cache hits to non-sensitive paths are CDN operational data; attack traffic bypasses cache',
    },
  ],
  suppress: [
    {
      id: 'cf_http_ok_agg',
      description: 'Aggregate successful non-static HTTP requests per client IP',
      filter: "(sourcetype == 'cloudflare:json' || /HttpRequest/i.test(Type || '')) && Number(EdgeResponseStatus) >= 200 && Number(EdgeResponseStatus) < 400 && !/\\/login|\\/auth|\\/admin|\\/api/i.test(ClientRequestURI || '')",
      reason: 'Successful non-sensitive HTTP requests can be aggregated per client IP to preserve volume patterns while reducing event count',
      groupKey: "ClientIP + ':' + ClientRequestHost",
      windowSec: 300,
      maxEvents: 5,
    },
    {
      id: 'cf_dns_routine_agg',
      description: 'Aggregate routine DNS A/AAAA queries',
      filter: "(sourcetype == 'cloudflare:dns:zones' || /DNS/i.test(Type || '')) && Number(ResponseCode) == 0 && [1,28].includes(Number(QueryType))",
      reason: 'Routine successful A/AAAA queries are highest volume DNS events; aggregate per source to preserve query volume patterns',
      groupKey: "SourceIP + ':' + QueryName",
      windowSec: 300,
      maxEvents: 1,
    },
  ],
};

const paloAlto: TableReductionRules = {
  keep: [
    {
      id: 'pa_threat_events',
      description: 'All threat log entries',
      filter: "/threat|wildfire|virus|spyware|vulnerability|url-filtering|file-blocking/i.test(DeviceEventClassID || Activity || '')",
      reason: 'Palo Alto threat logs are core security telemetry for Sentinel analytics',
    },
    {
      id: 'pa_denied_traffic',
      description: 'Denied/dropped/reset traffic',
      filter: "/deny|drop|reset-both|reset-client|reset-server|block/i.test(DeviceAction || '')",
      reason: 'Blocked traffic is queried by lateral movement, C2, and reconnaissance analytics rules',
    },
    {
      id: 'pa_config_changes',
      description: 'Configuration and system events',
      filter: "/config|system/i.test(DeviceEventClassID || '') || /commit|admin|config/i.test(Activity || '')",
      reason: 'Configuration change analytics require all admin and system events',
    },
  ],
  drop: [
    {
      id: 'pa_traffic_allow_internal',
      description: 'Allowed internal-to-internal traffic',
      filter: "/allow|permit/i.test(DeviceAction || '') && /^(10\\.|172\\.(1[6-9]|2[0-9]|3[0-1])\\.|192\\.168\\.)/i.test(SourceIP || '') && /^(10\\.|172\\.(1[6-9]|2[0-9]|3[0-1])\\.|192\\.168\\.)/i.test(DestinationIP || '') && (DestinationPort == 443 || DestinationPort == 80 || DestinationPort == 53)",
      reason: 'Allowed internal web/DNS traffic is extremely high volume; threat analytics focus on denied, external, and unusual port traffic',
    },
  ],
  suppress: [
    {
      id: 'pa_allowed_external_agg',
      description: 'Aggregate allowed external traffic per src/dst/port',
      filter: "/allow|permit/i.test(DeviceAction || '') && !/^(10\\.|172\\.(1[6-9]|2[0-9]|3[0-1])\\.|192\\.168\\.)/i.test(DestinationIP || '')",
      reason: 'Allowed external traffic can be aggregated to preserve connection patterns while reducing volume',
      groupKey: "SourceIP + ':' + DestinationIP + ':' + DestinationPort",
      windowSec: 300,
      maxEvents: 1,
    },
  ],
};

const crowdStrike: TableReductionRules = {
  keep: [
    {
      id: 'cs_detection_events',
      description: 'All detection and incident events',
      filter: "/Detection|Incident|Alert|Critical|Warning/i.test(ExternalApiType || EventType || Severity || '')",
      reason: 'CrowdStrike detections are the primary security signal; all must be preserved',
    },
    {
      id: 'cs_process_execution',
      description: 'Process execution events with suspicious indicators',
      filter: "/ProcessRollup|SyntheticProcessRollup/i.test(ExternalApiType || '') || /CommandLine/i.test(JSON.stringify(EventData || ''))",
      reason: 'Process execution events are needed for threat hunting and investigation',
    },
    {
      id: 'cs_network_connections',
      description: 'Network connection events',
      filter: "/NetworkConnect|DnsRequest/i.test(ExternalApiType || EventType || '')",
      reason: 'Network telemetry supports C2 detection and lateral movement analytics',
    },
  ],
  drop: [
    {
      id: 'cs_status_heartbeat',
      description: 'Agent status and heartbeat events',
      filter: "/AgentOnline|AgentOffline|SensorHeartbeat|Status/i.test(ExternalApiType || EventType || '') && !/Error|Fail/i.test(EventType || '')",
      reason: 'Sensor heartbeats are operational health data not queried by analytics rules',
    },
  ],
  suppress: [
    {
      id: 'cs_audit_events_agg',
      description: 'Aggregate audit/telemetry events per host',
      filter: "/UserActivity|AuditEvent/i.test(ExternalApiType || EventType || '')",
      reason: 'User activity audit events can be aggregated per host to reduce volume',
      groupKey: "aid + ':' + ExternalApiType",
      windowSec: 300,
      maxEvents: 3,
    },
  ],
};

const fortinet: TableReductionRules = {
  keep: [
    {
      id: 'ft_utm_events',
      description: 'UTM/IPS/AV/Web filter detections',
      filter: "/utm|ips|virus|webfilter|dlp|anomaly|voip|waf|dns/i.test(type || subtype || '')",
      reason: 'FortiGate UTM security events are core threat telemetry for Sentinel',
    },
    {
      id: 'ft_denied_traffic',
      description: 'Denied and blocked sessions',
      filter: "action == 'deny' || action == 'blocked' || action == 'dropped' || action == 'reset'",
      reason: 'Denied traffic is queried by threat detection and policy violation analytics',
    },
    {
      id: 'ft_event_log',
      description: 'System and config events',
      filter: "type == 'event' && /system|config|user|vpn/i.test(subtype || '')",
      reason: 'System events, config changes, and VPN events are needed for admin activity and VPN analytics',
    },
  ],
  drop: [
    {
      id: 'ft_traffic_allow_standard',
      description: 'Allowed traffic on standard ports to common destinations',
      filter: "type == 'traffic' && action == 'accept' && (dstport == '443' || dstport == '80' || dstport == '53') && !/deny|block|drop/i.test(action || '')",
      reason: 'Allowed standard port traffic is the highest volume FortiGate log type; analytics focus on denied and unusual traffic',
    },
  ],
  suppress: [
    {
      id: 'ft_traffic_allowed_agg',
      description: 'Aggregate allowed traffic per policy/src/dst',
      filter: "type == 'traffic' && action == 'accept'",
      reason: 'Allowed traffic can be aggregated by policy to preserve connection patterns',
      groupKey: "srcip + ':' + dstip + ':' + dstport + ':' + policyid",
      windowSec: 300,
      maxEvents: 1,
    },
  ],
};

// ---------------------------------------------------------------------------
// Exported Knowledge Base
// ---------------------------------------------------------------------------

export const REDUCTION_RULES: ReductionKnowledgeBase = {
  // Native Sentinel tables
  CommonSecurityLog: commonSecurityLog,
  Syslog: syslog,
  WindowsEvent: windowsEvent,
  SecurityEvent: windowsEvent, // SecurityEvent uses same schema/rules as WindowsEvent
  AzureActivity: azureActivity,

  // Vendor-specific (matched by vendor/solution name keywords)
  Cloudflare: cloudflare,
  CloudflareV2_CL: cloudflare,
  PaloAlto: paloAlto,
  'Palo Alto': paloAlto,
  CrowdStrike: crowdStrike,
  Fortinet: fortinet,
  FortiGate: fortinet,
};

// Look up reduction rules for a given table name or vendor/solution name.
// Tries exact match first, then keyword matching.
export function findReductionRules(
  tableName: string,
  solutionName: string,
): TableReductionRules | null {
  // Exact match on table name
  if (REDUCTION_RULES[tableName]) {
    return REDUCTION_RULES[tableName];
  }

  // Try matching by solution name keywords
  const combined = `${tableName} ${solutionName}`.toLowerCase();
  for (const [key, rules] of Object.entries(REDUCTION_RULES)) {
    if (combined.includes(key.toLowerCase())) {
      return rules;
    }
  }

  // Try partial match on table name (strip _CL suffix, try vendor prefix)
  const stripped = tableName.replace(/_CL$/i, '').toLowerCase();
  for (const [key, rules] of Object.entries(REDUCTION_RULES)) {
    if (key.toLowerCase().includes(stripped) || stripped.includes(key.toLowerCase())) {
      return rules;
    }
  }

  return null;
}
