/**
 * The ONE canonical PAN-OS positional-column dictionary set - porting-plan
 * Unit 12 (ENG-16). PAN-OS writes its logs as headerless CSV whose column order
 * is documented by Palo Alto per log type; naming the columns lets downstream
 * field mapping work with real names instead of _0, _1, _2.
 *
 * Ref (documented PAN-OS 11.0 field order, the order adopted here):
 * https://docs.paloaltonetworks.com/pan-os/11-0/pan-os-admin/monitoring/use-syslog-for-monitoring/syslog-field-descriptions
 *
 * THREE-WAY DRIFT RECONCILED (the plan's Unit-12 mandate: "one canonical PAN-OS
 * dictionary set ... resolving the three-way drift"):
 *   Source A = IS/sample-parser.ts, the local PANOS_TRAFFIC_COLS/PANOS_THREAT_COLS
 *              inside parseCsv (sample-parser.ts lines ~217-237). A truncated
 *              ~47-column subset covering ONLY TRAFFIC and THREAT. Its index 20
 *              was 'log_action'. This copy was ported verbatim as a stopgap into
 *              Unit 11 parsers.ts (line 65) with a note that Unit 12 supersedes
 *              it; Unit 12 now removes that copy (parsers.ts imports from here).
 *   Source B = IS/sample-resolver.ts, PANOS_CSV_HEADERS (sample-resolver.ts lines
 *              1034-1133). The full documented PAN-OS 11.0 order: eight log types,
 *              ~130 columns each. Its index 20 was 'logset'.
 *   Source C = the same eight-type map RE-DEFINED (PANOS_LOG_TYPES) in BOTH
 *              sample-resolver.ts (line 863) and default-samples.ts (line 724),
 *              byte-for-byte identical. That numeric-id map is DEDUPLICATED here
 *              to a single {@link PANOS_LOG_TYPES}.
 *
 * CONSCIOUS CHOICE at the drifted TRAFFIC/THREAT index 20 ('log_action' vs
 * 'logset'): this port keeps 'logset' (Source B). Rationale, pinned by
 * panos-dictionary.test.ts:
 *   - Source B IS the documented PAN-OS 11.0 field order (eight log types, full
 *     ~130-column width, cites the official Palo Alto syslog field-descriptions
 *     page); Source A was a hand-truncated two-type subset.
 *   - We adopt B's dictionary WHOLESALE rather than cherry-picking one cell out
 *     of A, so the single drifted cell follows the dictionary we adopted. Both
 *     spellings name the same physical field (the log-forwarding profile applied
 *     to the session, PAN-OS "Log Action" / "log setting"); no deployed artifact
 *     keys off either spelling, so choosing the more-complete dictionary is the
 *     lossless reconciliation.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

/**
 * PAN-OS numeric log-type id (the CEF DeviceEventClassID PAN-OS emits) to the
 * human-readable log-type name. DEDUPLICATED from the two identical legacy
 * copies (sample-resolver.ts line 863 and default-samples.ts line 724).
 */
export const PANOS_LOG_TYPES: Readonly<Record<string, string>> = Object.freeze({
  "1": "TRAFFIC",
  "2": "THREAT",
  "3": "WILDFIRE",
  "10": "CONFIG",
  "12": "SYSTEM",
  "15": "HIP-MATCH",
  "16": "IP-TAG",
  "17": "USER-ID",
  "20": "GLOBALPROTECT",
  "21": "AUTHENTICATION",
  "22": "DECRYPTION",
  "23": "TUNNEL-INSPECTION",
  "100": "HIPMATCH",
  "256": "CORRELATION",
  "1100": "URL-FILTERING",
  "1200": "DATA-FILTERING",
  "2000": "SCTP",
  "2048": "IPTAG",
  "4096": "USERID",
  "8192": "GTP",
});

/**
 * The 0-based index at which the TRAFFIC and THREAT dictionaries carried the
 * legacy drift ('log_action' in Source A vs 'logset' in Source B). Exported so
 * the conscious-choice test can assert on the exact drifted cell.
 */
export const PANOS_TRAFFIC_LOGSET_INDEX = 20;

/** The value Source A (sample-parser.ts) held at {@link PANOS_TRAFFIC_LOGSET_INDEX}. */
export const PANOS_LEGACY_PARSER_INDEX20 = "log_action";

/** The value this port keeps at {@link PANOS_TRAFFIC_LOGSET_INDEX} (Source B). */
export const PANOS_CANONICAL_INDEX20 = "logset";

/**
 * The canonical PAN-OS 11.0 per-log-type column dictionaries (Source B,
 * verbatim). Eight log types: TRAFFIC, THREAT, SYSTEM, CONFIG, GLOBALPROTECT,
 * AUTHENTICATION, DECRYPTION, HIP-MATCH. `future_use*` placeholders are retained
 * in the order (so positions stay correct) but skipped when a line is named.
 */
export const PANOS_CSV_HEADERS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    TRAFFIC: [
      "future_use1", "receive_time", "serial", "type", "subtype", "future_use2",
      "generated_time", "src", "dst", "natsrc", "natdst", "rule", "srcuser",
      "dstuser", "app", "vsys", "from", "to", "inbound_if", "outbound_if",
      "logset", "future_use3", "sessionid", "repeatcnt", "sport", "dport",
      "natsport", "natdport", "flags", "proto", "action", "bytes", "bytes_sent",
      "bytes_received", "packets", "start", "elapsed", "category", "future_use4",
      "seqno", "actionflags", "srcloc", "dstloc", "future_use5", "pkts_sent",
      "pkts_received", "session_end_reason", "dg_hier_level_1", "dg_hier_level_2",
      "dg_hier_level_3", "dg_hier_level_4", "vsys_name", "device_name",
      "action_source", "src_uuid", "dst_uuid", "tunnelid_imsi", "monitortag_imei",
      "parent_session_id", "parent_start_time", "tunnel", "assoc_id", "chunks",
      "chunks_sent", "chunks_received", "rule_uuid", "http2_connection",
      "link_change_count", "policy_id", "link_switches", "sdwan_cluster",
      "sdwan_device_type", "sdwan_cluster_type", "sdwan_site", "dynusergroup_name",
      "xff", "src_category", "src_profile", "src_model", "src_vendor",
      "src_osfamily", "src_osversion", "src_host", "src_mac", "dst_category",
      "dst_profile", "dst_model", "dst_vendor", "dst_osfamily", "dst_osversion",
      "dst_host", "dst_mac", "container_id", "pod_namespace", "pod_name",
      "src_edl", "dst_edl", "hostid", "serialnumber", "domain_edl", "src_dag",
      "dst_dag", "session_owner", "high_res_timestamp", "a_slice_service_type",
      "a_slice_differentiator", "application_subcategory", "application_category",
      "application_technology", "application_risk", "application_characteristic",
      "application_container", "tunneled_app", "application_saas",
      "application_sanctioned_state",
    ],
    THREAT: [
      "future_use1", "receive_time", "serial", "type", "subtype", "future_use2",
      "generated_time", "src", "dst", "natsrc", "natdst", "rule", "srcuser",
      "dstuser", "app", "vsys", "from", "to", "inbound_if", "outbound_if",
      "logset", "future_use3", "sessionid", "repeatcnt", "sport", "dport",
      "natsport", "natdport", "flags", "proto", "action", "misc", "threatid",
      "category", "severity", "direction", "seqno", "actionflags", "srcloc",
      "dstloc", "future_use4", "contenttype", "pcap_id", "filedigest", "cloud",
      "url_idx", "user_agent", "filetype", "xff", "referer", "sender", "subject",
      "recipient", "reportid", "dg_hier_level_1", "dg_hier_level_2",
      "dg_hier_level_3", "dg_hier_level_4", "vsys_name", "device_name",
      "future_use5", "src_uuid", "dst_uuid", "http_method", "tunnel_id_imsi",
      "monitortag_imei", "parent_session_id", "parent_start_time", "tunnel",
      "thr_category", "contentver", "future_use6", "assoc_id", "ppid",
      "http_headers", "url_category_list", "rule_uuid", "http2_connection",
      "dynusergroup_name", "xff_ip", "src_category", "src_profile", "src_model",
      "src_vendor", "src_osfamily", "src_osversion", "src_host", "src_mac",
      "dst_category", "dst_profile", "dst_model", "dst_vendor", "dst_osfamily",
      "dst_osversion", "dst_host", "dst_mac", "container_id", "pod_namespace",
      "pod_name", "src_edl", "dst_edl", "hostid", "serialnumber", "domain_edl",
      "src_dag", "dst_dag", "partial_hash", "high_res_timestamp", "reason",
      "justification", "nssai_sst", "subcategory_of_app", "category_of_app",
      "technology_of_app", "risk_of_app", "characteristic_of_app",
      "container_of_app", "tunneled_app", "saas_of_app", "sanctioned_state_of_app",
    ],
    SYSTEM: [
      "future_use1", "receive_time", "serial", "type", "subtype", "future_use2",
      "generated_time", "vsys", "eventid", "object", "future_use3", "future_use4",
      "module", "severity", "opaque", "seqno", "actionflags", "dg_hier_level_1",
      "dg_hier_level_2", "dg_hier_level_3", "dg_hier_level_4", "vsys_name",
      "device_name", "future_use5", "high_res_timestamp",
    ],
    CONFIG: [
      "future_use1", "receive_time", "serial", "type", "subtype", "future_use2",
      "generated_time", "host", "vsys", "cmd", "admin", "client", "result",
      "path", "before_change_detail", "after_change_detail", "seqno",
      "actionflags", "dg_hier_level_1", "dg_hier_level_2", "dg_hier_level_3",
      "dg_hier_level_4", "vsys_name", "device_name", "future_use3",
      "high_res_timestamp",
    ],
    GLOBALPROTECT: [
      "future_use1", "receive_time", "serial", "type", "subtype", "future_use2",
      "generated_time", "vsys", "eventid", "stage", "auth_method", "tunnel_type",
      "srcuser", "srcregion", "machinename", "public_ip", "public_ipv6",
      "private_ip", "private_ipv6", "hostid", "serialnumber", "client_ver",
      "client_os", "client_os_ver", "repeatcnt", "reason", "error", "opaque",
      "status", "location", "login_duration", "connect_method", "error_code",
      "portal", "seqno", "actionflags", "selection_type", "response_time",
      "priority", "attempted_gateways", "gateway", "dg_hier_level_1",
      "dg_hier_level_2", "dg_hier_level_3", "dg_hier_level_4", "vsys_name",
      "device_name", "vsys_id", "high_res_timestamp",
    ],
    AUTHENTICATION: [
      "future_use1", "receive_time", "serial", "type", "subtype", "future_use2",
      "generated_time", "vsys", "ip", "user", "normalize_user", "object",
      "authpolicy", "repeatcnt", "authid", "vendor", "logset", "serverprofile",
      "desc", "clienttype", "event", "factorno", "seqno", "actionflags",
      "dg_hier_level_1", "dg_hier_level_2", "dg_hier_level_3", "dg_hier_level_4",
      "vsys_name", "device_name", "vsys_id", "authproto", "rule_uuid",
      "high_res_timestamp", "src_category", "src_profile", "src_model",
      "src_vendor", "src_osfamily", "src_osversion", "src_host", "src_mac",
      "region", "future_use3", "user_agent", "session_id",
    ],
    DECRYPTION: [
      "future_use1", "receive_time", "serial", "type", "subtype", "future_use2",
      "generated_time", "src", "dst", "natsrc", "natdst", "rule", "srcuser",
      "dstuser", "app", "vsys", "from", "to", "inbound_if", "outbound_if",
      "logset", "future_use3", "sessionid", "repeatcnt", "sport", "dport",
      "natsport", "natdport", "flags", "proto", "action", "tunnel", "src_uuid",
      "dst_uuid", "rule_uuid", "policy_name", "elliptic_curve", "error_index",
      "root_status", "chain_status", "proxy_type", "cert_serial_number",
      "fingerprint", "not_before", "not_after", "cert_version", "cert_size",
      "cn_length", "issuer_cn_length", "root_cn_length", "sni_length",
      "cert_flags", "subject_cn", "issuer_cn", "root_cn", "sni", "error",
      "container_id", "pod_namespace", "pod_name", "src_edl", "dst_edl",
      "src_dag", "dst_dag", "seqno", "actionflags", "dg_hier_level_1",
      "dg_hier_level_2", "dg_hier_level_3", "dg_hier_level_4", "vsys_name",
      "device_name", "high_res_timestamp",
    ],
    "HIP-MATCH": [
      "future_use1", "receive_time", "serial", "type", "subtype", "future_use2",
      "generated_time", "srcuser", "vsys", "machinename", "os", "src",
      "matchname", "repeatcnt", "matchtype", "future_use3", "future_use4",
      "seqno", "actionflags", "dg_hier_level_1", "dg_hier_level_2",
      "dg_hier_level_3", "dg_hier_level_4", "vsys_name", "device_name", "vsys_id",
      "srcipv6", "hostid", "serialnumber", "mac", "high_res_timestamp",
    ],
  });

/**
 * Parse ONE PAN-OS syslog+CSV line into a named-field object. Ported verbatim
 * from the legacy sample-resolver.ts `parsePanosLine`.
 *
 * The '1,' SLICE FINGERPRINT (pinned by panos-dictionary.test.ts): PAN-OS CSV
 * always begins with `future_use1` set to the literal `1`, so the parser locates
 * the CSV body with `line.indexOf('1,')` and slices from there - this strips any
 * leading syslog header WITHOUT a regex. Documented fragility kept verbatim:
 * `indexOf` returns the FIRST '1,' in the line, so a header that itself contains
 * the substring "1," (rare) would be mis-sliced; the legacy accepted this.
 *
 * Returns null when no '1,' is found or fewer than 7 fields survive.
 */
export function parsePanosLine(
  line: string,
): { logType: string; fields: Record<string, string> } | null {
  const csvStart = line.indexOf("1,");
  if (csvStart < 0) {
    return null;
  }
  const csv = line.slice(csvStart);
  const values = csv.split(",");
  if (values.length < 7) {
    return null;
  }

  // Field[3] is the log type (TRAFFIC, THREAT, SYSTEM, CONFIG, ...).
  const logType = (values[3] || "").toUpperCase().trim();
  const headers = PANOS_CSV_HEADERS[logType];

  const fields: Record<string, string> = {};
  if (headers) {
    for (let i = 0; i < Math.min(headers.length, values.length); i += 1) {
      const name = headers[i];
      const val = values[i] || "";
      // Skip empty values and future_use placeholder positions.
      if (val && !name.startsWith("future_use")) {
        fields[name] = val;
      }
    }
  } else {
    // Unknown log type: keep the type and a bounded set of generic positions.
    fields["type"] = logType;
    for (let i = 0; i < Math.min(20, values.length); i += 1) {
      if (values[i]) {
        fields[`field_${i}`] = values[i];
      }
    }
  }

  return { logType, fields };
}

/**
 * True when the first non-empty line looks like PAN-OS syslog+CSV: the
 * `1,<date>,<serial>,<TYPE>,` positional fingerprint. Verbatim from the legacy
 * sample-resolver.ts `isPanosFormat` (regex flags preserved: case-insensitive).
 */
export function isPanosFormat(rawEvents: readonly string[]): boolean {
  if (rawEvents.length === 0) {
    return false;
  }
  const first = rawEvents.find((l) => l.trim()) || "";
  return /1,\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2},\d+,(TRAFFIC|THREAT|SYSTEM|CONFIG|GLOBALPROTECT|AUTHENTICATION|DECRYPTION|HIP-MATCH|CORRELATION|GTP|SCTP|TUNNEL|USERID|IPTAG|HIPMATCH|WILDFIRE|URL|DATA)/i.test(
    first,
  );
}

/**
 * Convert PAN-OS syslog+CSV raw events into JSON strings of named-field objects.
 * Returns the converted events and the first detected log type. Verbatim from
 * the legacy sample-resolver.ts `convertPanosToJson`: when nothing parses, the
 * original raw events are returned unchanged.
 */
export function convertPanosToJson(rawEvents: readonly string[]): {
  events: string[];
  logType: string;
} {
  const results: string[] = [];
  let detectedType = "";
  for (const line of rawEvents) {
    const parsed = parsePanosLine(line);
    if (parsed) {
      if (!detectedType) {
        detectedType = parsed.logType;
      }
      results.push(JSON.stringify(parsed.fields));
    }
  }
  return {
    events: results.length > 0 ? results : [...rawEvents],
    logType: detectedType,
  };
}
