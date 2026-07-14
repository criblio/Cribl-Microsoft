/**
 * Vendor feed-config parser - porting-plan Unit 12 (ENG-17, GUI-07). Resolves
 * the column names / transport hints for a headerless CSV feed from a pasted
 * vendor OUTPUT configuration (a Zscaler NSS feed definition, a Palo Alto syslog
 * forwarding profile, a FortiGate syslogd block, a Cloudflare Logpush job JSON,
 * a CrowdStrike SIEM connector config, or a generic rsyslog stanza).
 *
 * Ported from the legacy sample-parser.ts `parseVendorFeedConfig`. The BRANCH
 * ORDER is load-bearing and preserved verbatim (Zscaler, Palo Alto, FortiGate,
 * Cloudflare, CrowdStrike, generic rsyslog). Two legacy quirks are consciously
 * PRESERVED and pinned by feed-config.test.ts rather than "fixed":
 *   - The Cloudflare branch claims any config whose lowercased text merely
 *     CONTAINS the word "dataset" (see the branch condition). This is a
 *     documented FALSE-POSITIVE - a non-Cloudflare config that happens to say
 *     "dataset" is classified as Cloudflare because that branch runs before the
 *     generic rsyslog fallback. Left in place because downstream code keys off
 *     the returned field list, not the vendor label, and changing the taxonomy
 *     could reclassify feeds users already rely on.
 *   - Zscaler transport DEFAULTS to TCP when neither "tcp" nor "https" appears.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

/** The resolved vendor feed configuration. Verbatim shape from the legacy port. */
export interface VendorFeedConfig {
  /** Detected vendor label ("Zscaler", "Palo Alto", ..., "generic", "unknown"). */
  vendor: string;
  /** Feed kind, e.g. "syslog_forwarding", "logpush", "event_stream", "nss_web". */
  feedType: string;
  /** Expected log format ("csv", "kv", "ndjson", "syslog", ...). */
  format: string;
  /** Field / log-type names recovered from the config. */
  fields: string[];
  /** Transport protocol hint ("TCP", "UDP", "HTTPS", "SSL", "TLS", ""). */
  transportProtocol: string;
  /** Destination port, or 0 when none was found. */
  port: number;
  /** The original pasted config text. */
  rawConfig: string;
}

/**
 * Parse a pasted vendor feed configuration into a {@link VendorFeedConfig}.
 * See the module header for the preserved branch order and the two pinned
 * legacy quirks (Cloudflare "dataset" false-positive, Zscaler default TCP).
 */
export function parseFeedConfig(configText: string): VendorFeedConfig {
  const result: VendorFeedConfig = {
    vendor: "unknown",
    feedType: "unknown",
    format: "unknown",
    fields: [],
    transportProtocol: "",
    port: 0,
    rawConfig: configText,
  };

  const lower = configText.toLowerCase();

  // --- 1. Zscaler NSS feed configuration ------------------------------------
  // THREE field-extraction patterns, tried in order (see below).
  if (
    lower.includes("zscaler") ||
    lower.includes("nss") ||
    lower.includes("%s{") ||
    lower.includes("%d{")
  ) {
    result.vendor = "Zscaler";
    result.format = "csv";

    if (
      lower.includes("nss for web") ||
      lower.includes("nss_type=web") ||
      lower.includes("weblog")
    ) {
      result.feedType = "nss_web";
    } else if (
      lower.includes("nss for firewall") ||
      lower.includes("nss_type=firewall") ||
      lower.includes("fwlog")
    ) {
      result.feedType = "nss_firewall";
    } else if (
      lower.includes("nss for dns") ||
      lower.includes("nss_type=dns") ||
      lower.includes("dnslog")
    ) {
      result.feedType = "nss_dns";
    } else if (
      lower.includes("nss for tunnel") ||
      lower.includes("nss_type=tunnel")
    ) {
      result.feedType = "nss_tunnel";
    } else {
      result.feedType = "nss";
    }

    // Pattern 1: format-string placeholders %s{field}, %d{field}, %02d{field}.
    const formatFields = configText.match(/%[sd]\d*\{([^}]+)\}/g);
    if (formatFields && formatFields.length > 0) {
      result.fields = formatFields.map((f) => {
        const m = f.match(/\{([^}]+)\}/);
        return m ? m[1] : f;
      });
    }

    // Pattern 2: "Fields: a,b,c" or "fields=a,b,c".
    if (result.fields.length === 0) {
      const fieldsMatch = configText.match(/[Ff]ields[=:]\s*(.+)/);
      if (fieldsMatch) {
        result.fields = fieldsMatch[1]
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean);
      }
    }

    // Pattern 3: a bare comma-separated field list on a single line (>=5 cols,
    // every column an identifier).
    if (result.fields.length === 0) {
      const lines = configText.trim().split("\n");
      for (const line of lines) {
        const parts = line.split(",").map((p) => p.trim());
        if (parts.length >= 5 && parts.every((p) => /^[a-zA-Z_]\w*$/.test(p))) {
          result.fields = parts;
          break;
        }
      }
    }

    // Transport DEFAULTS to TCP (pinned): only HTTPS if explicitly present and
    // TCP absent.
    result.transportProtocol = lower.includes("tcp")
      ? "TCP"
      : lower.includes("https")
        ? "HTTPS"
        : "TCP";
    const portMatch = configText.match(/port[=:\s]+(\d+)/i);
    if (portMatch) {
      result.port = parseInt(portMatch[1], 10);
    }
  }

  // --- 2. Palo Alto syslog forwarding profile -------------------------------
  else if (
    lower.includes("syslog-server-profile") ||
    lower.includes("pan-os") ||
    lower.includes("paloalto")
  ) {
    result.vendor = "Palo Alto";
    result.feedType = "syslog_forwarding";
    const portMatch = configText.match(/port\s+(\d+)/);
    const protoMatch = configText.match(/transport\s+(TCP|UDP|SSL)/i);
    const formatMatch = configText.match(/format\s+(BSD|IETF)/i);
    if (portMatch) {
      result.port = parseInt(portMatch[1], 10);
    }
    if (protoMatch) {
      result.transportProtocol = protoMatch[1].toUpperCase();
    }
    if (formatMatch) {
      result.format =
        formatMatch[1].toUpperCase() === "BSD" ? "syslog_bsd" : "syslog_ietf";
    } else {
      result.format = "syslog";
    }
    const logTypes = configText.match(
      /(traffic|threat|url|data|wildfire|tunnel|auth|sctp|decryption|gtp|hip-match)/gi,
    );
    if (logTypes) {
      result.fields = [...new Set(logTypes.map((t) => t.toLowerCase()))];
    }
  }

  // --- 3. FortiGate syslog config -------------------------------------------
  else if (
    lower.includes("config log syslogd") ||
    lower.includes("fortigate") ||
    lower.includes("fortinet")
  ) {
    result.vendor = "Fortinet";
    result.feedType = "syslog_forwarding";
    result.format = "kv";
    const portMatch = configText.match(/port\s+(\d+)/i);
    if (portMatch) {
      result.port = parseInt(portMatch[1], 10);
    }
    const protoMatch = configText.match(/(tcp|udp)/i);
    if (protoMatch) {
      result.transportProtocol = protoMatch[1].toUpperCase();
    }
    const filterMatch = configText.match(/filter\s+"([^"]+)"/);
    if (filterMatch) {
      result.fields = filterMatch[1].split(/\s+/);
    }
  }

  // --- 4. Cloudflare Logpush job config (JSON) ------------------------------
  // WARNING: the bare "dataset" keyword claims this branch (false-positive);
  // see the module header. Preserved verbatim.
  else if (
    lower.includes("logpush") ||
    lower.includes("cloudflare") ||
    lower.includes("dataset")
  ) {
    result.vendor = "Cloudflare";
    result.feedType = "logpush";
    try {
      const parsed = JSON.parse(configText) as {
        dataset?: unknown;
        logpull_options?: unknown;
        destination_conf?: unknown;
      };
      if (parsed.dataset) {
        result.fields = [String(parsed.dataset)];
      }
      if (typeof parsed.logpull_options === "string") {
        const fieldsMatch = parsed.logpull_options.match(/fields=([^&]+)/);
        if (fieldsMatch) {
          result.fields = fieldsMatch[1].split(",");
        }
      }
      if (
        typeof parsed.destination_conf === "string" &&
        parsed.destination_conf.includes("https://")
      ) {
        result.transportProtocol = "HTTPS";
      }
      result.format = "ndjson";
    } catch {
      // Not JSON: try extracting a field list from free text.
      const fieldsMatch = configText.match(/fields[=:]\s*"?([^"&\n]+)/i);
      if (fieldsMatch) {
        result.fields = fieldsMatch[1].split(",").map((f) => f.trim());
      }
    }
  }

  // --- 5. CrowdStrike SIEM Connector / Event Streams ------------------------
  else if (
    lower.includes("crowdstrike") ||
    lower.includes("falcon") ||
    lower.includes("event_streams")
  ) {
    result.vendor = "CrowdStrike";
    result.feedType = "event_stream";
    result.format = "json";
    result.transportProtocol = "HTTPS";
    const eventTypes = configText.match(
      /(DetectionSummary|AuthActivity|RemoteResponse|UserActivity|IncidentSummary)/gi,
    );
    if (eventTypes) {
      result.fields = [...new Set(eventTypes)];
    }
  }

  // --- 6. Generic syslog / rsyslog fallback ---------------------------------
  else if (
    lower.includes("syslog") ||
    lower.includes("rsyslog") ||
    lower.includes("syslog-ng")
  ) {
    result.vendor = "generic";
    result.feedType = "syslog_forwarding";
    result.format = "syslog";
    const portMatch = configText.match(/port[=:\s]+(\d+)/i);
    if (portMatch) {
      result.port = parseInt(portMatch[1], 10);
    }
    const protoMatch = configText.match(/(tcp|udp|tls)/i);
    if (protoMatch) {
      result.transportProtocol = protoMatch[1].toUpperCase();
    }
  }

  return result;
}
