/**
 * Synthetic sample-value generator - porting-plan Unit 19, task item 4
 * (generateFieldValue heuristic KB, verbatim).
 *
 * Ported from legacy pack-builder.ts generateFieldValue (1025-1176). The
 * name/type -> value-shape heuristic table is reproduced BRANCH-FOR-BRANCH (the
 * substring checks, the ordering, and every literal value array), because it is
 * the knowledge base the task pins verbatim. What changes is the SOURCE OF
 * ENTROPY: the legacy used `Math.random()` and Node `crypto.randomBytes`, which
 * pure core forbids and which made every build non-reproducible. Here entropy
 * comes from a deterministic seeded PRNG (mulberry32) keyed by
 * `name:type:seed`, so the SAME field always yields the SAME value and multiple
 * synthetic events differ only via the caller-supplied event `seed`. No
 * Date/crypto/Math.random anywhere.
 *
 * This path only runs when a table has NO real uploaded samples (the fallback
 * branch of {@link file:./sample-file.ts}); real vendor bytes are always
 * preferred.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

/** FNV-1a 32-bit hash of a string (unsigned). Deterministic, dependency-free. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG: a deterministic sequence of doubles in [0, 1) from a seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic lowercase hex string of `len` chars from a seeded generator. */
function randHex(rand: () => number, len: number): string {
  let out = "";
  while (out.length < len) {
    out += Math.floor(rand() * 0x10000)
      .toString(16)
      .padStart(4, "0");
  }
  return out.slice(0, len);
}

// The synthetic timestamp base: legacy new Date('2025-06-15T14:30:00Z').
const BASE_EPOCH_MS = 1749997800000;

function pad(n: number, width: number): string {
  return Math.floor(n).toString().padStart(width, "0");
}

/**
 * Pure ISO-8601 (UTC, millisecond) formatting of an epoch-ms value, replacing
 * the forbidden `new Date(ms).toISOString()`. Uses Hinnant's civil-from-days
 * algorithm so no Date object is ever constructed.
 */
export function isoFromEpochMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const msPart = ms - totalSec * 1000;
  const days = Math.floor(totalSec / 86400);
  let secOfDay = totalSec - days * 86400;
  const hh = Math.floor(secOfDay / 3600);
  secOfDay -= hh * 3600;
  const mm = Math.floor(secOfDay / 60);
  const ss = secOfDay - mm * 60;

  const z = days + 719468;
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const year = m <= 2 ? y + 1 : y;

  return (
    `${pad(year, 4)}-${pad(m, 2)}-${pad(d, 2)}` +
    `T${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)}.${pad(msPart, 3)}Z`
  );
}

/**
 * Generate a deterministic, realistic value for a field given its name and Log
 * Analytics type. Verbatim heuristic table from legacy generateFieldValue, with
 * `Math.random()` replaced by a `name:type:seed`-seeded generator.
 */
export function generateFieldValue(name: string, type: string, seed = 0): unknown {
  const lower = name.toLowerCase();
  const t = type.toLowerCase();
  const rand = mulberry32(fnv1a(`${name}:${type}:${seed}`));

  // Datetime fields
  if (t === "datetime" || lower.includes("time") || lower.includes("date") || lower === "timestamp") {
    const offset = Math.floor(rand() * 3600000);
    return isoFromEpochMs(BASE_EPOCH_MS + offset);
  }

  // Boolean fields
  if (t === "boolean" || t === "bool") {
    return rand() > 0.5;
  }

  // Numeric fields - name heuristics for realistic ranges
  if (t === "int" || t === "long" || t === "real") {
    if (lower.includes("port")) return 1024 + Math.floor(rand() * 64000);
    if (lower.includes("pid") || lower.includes("processid")) return 1000 + Math.floor(rand() * 50000);
    if (lower.includes("severity") || lower.includes("level")) return Math.floor(rand() * 8);
    if (lower.includes("size") || lower.includes("bytes") || lower.includes("length")) return Math.floor(rand() * 100000);
    if (lower.includes("count") || lower.includes("total")) return Math.floor(rand() * 500);
    if (lower.includes("duration") || lower.includes("elapsed")) return Math.floor(rand() * 30000);
    if (lower.includes("code") || lower.includes("status")) return [200, 201, 301, 400, 403, 404, 500][Math.floor(rand() * 7)];
    if (lower.includes("id") && !lower.includes("guid")) return Math.floor(rand() * 100000);
    if (t === "real") return Math.round(rand() * 100 * 100) / 100;
    return Math.floor(rand() * 10000);
  }

  // Dynamic/object fields
  if (t === "dynamic" || t === "object") {
    if (lower.includes("event") && lower.includes("data")) {
      return { param1: "value1", param2: 42 };
    }
    return {};
  }

  // String fields - extensive name-based heuristics
  if ((lower.includes("ip") || lower.includes("address")) && !lower.includes("mac") && !lower.includes("email") && !lower.includes("descript")) {
    const octets = [10, Math.floor(rand() * 255), Math.floor(rand() * 255), 1 + Math.floor(rand() * 254)];
    if (lower.includes("dest") || lower.includes("dst") || lower.includes("target") || lower.includes("remote")) {
      octets[0] = [172, 192, 10][Math.floor(rand() * 3)];
    }
    if (lower.includes("source") || lower.includes("src") || lower.includes("client") || lower.includes("local")) {
      octets[0] = 10;
    }
    if (lower.includes("public") || lower.includes("external")) {
      octets[0] = [52, 104, 20, 40][Math.floor(rand() * 4)];
    }
    return octets.join(".");
  }

  if (lower.includes("mac")) {
    return Array.from({ length: 6 }, () => Math.floor(rand() * 256).toString(16).padStart(2, "0").toUpperCase()).join(":");
  }

  if (lower.includes("host") || lower.includes("computer") || lower.includes("machine") || lower.includes("node")) {
    const prefixes = ["srv", "web", "app", "db", "dc", "fw", "proxy", "mail"];
    const prefix = prefixes[Math.floor(rand() * prefixes.length)];
    return `${prefix}-${String(Math.floor(rand() * 99) + 1).padStart(2, "0")}.contoso.com`;
  }

  if (lower.includes("user") || lower.includes("account") || lower.includes("identity")) {
    const users = ["admin", "jsmith", "svc-monitor", "SYSTEM", "jane.doe", "backup-svc", "apiuser01"];
    return users[Math.floor(rand() * users.length)];
  }

  if (lower.includes("domain") || lower.includes("dns")) {
    const domains = ["contoso.com", "fabrikam.net", "tailspintoys.org", "internal.corp"];
    return domains[Math.floor(rand() * domains.length)];
  }

  if (lower.includes("url") || lower.includes("uri") || lower.includes("href")) {
    const paths = ["/api/v2/status", "/login", "/health", "/data/query", "/admin/settings"];
    return `https://app.contoso.com${paths[Math.floor(rand() * paths.length)]}`;
  }

  if (lower.includes("path") || lower.includes("file")) {
    if (lower.includes("file") && !lower.includes("path")) {
      return ["audit.log", "system.evtx", "access.log", "error.log", "sysmon.xml"][Math.floor(rand() * 5)];
    }
    return ["C:\\Windows\\System32\\svchost.exe", "/var/log/syslog", "C:\\Program Files\\app\\service.exe", "/usr/bin/python3", "/etc/config.yaml"][Math.floor(rand() * 5)];
  }

  if (lower.includes("process") || lower.includes("program") || lower.includes("application")) {
    return ["svchost.exe", "python3", "java", "nginx", "powershell.exe", "cmd.exe", "sshd"][Math.floor(rand() * 7)];
  }

  if (lower.includes("protocol")) {
    return ["TCP", "UDP", "HTTPS", "DNS", "ICMP", "SSH", "TLS"][Math.floor(rand() * 7)];
  }

  if (lower.includes("action") || lower.includes("operation") || lower.includes("activity")) {
    return ["Allow", "Deny", "Create", "Delete", "Modify", "Read", "Execute", "Login"][Math.floor(rand() * 8)];
  }

  if (lower.includes("severity") || lower.includes("priority") || lower.includes("level")) {
    return ["Informational", "Low", "Medium", "High", "Critical"][Math.floor(rand() * 5)];
  }

  if (lower.includes("category") || lower.includes("type") || lower.includes("class")) {
    return ["Security", "Audit", "Network", "Application", "System", "Authentication"][Math.floor(rand() * 6)];
  }

  if (lower.includes("facility")) {
    return ["auth", "authpriv", "local0", "kern", "daemon", "syslog", "user"][Math.floor(rand() * 7)];
  }

  if (lower.includes("message") || lower.includes("description") || lower.includes("detail") || lower === "syslogmessage") {
    const msgs = [
      "User authentication successful for admin from 10.1.2.3",
      "Connection established to remote host 172.16.0.10:443",
      "Firewall rule applied: Allow TCP from 10.0.0.0/8 to any:443",
      "Process svchost.exe (PID 4528) started by SYSTEM",
      "File access audit: C:\\Sensitive\\data.xlsx read by jsmith",
    ];
    return msgs[Math.floor(rand() * msgs.length)];
  }

  if (lower.includes("guid") || lower.includes("uuid") || lower.includes("correlationid") || lower.includes("requestid")) {
    return [randHex(rand, 8), randHex(rand, 4), randHex(rand, 4), randHex(rand, 4), randHex(rand, 12)].join("-");
  }

  if (lower.includes("hash") || lower.includes("checksum")) {
    return randHex(rand, 32);
  }

  if (lower.includes("vendor") || lower.includes("product")) {
    return lower.includes("vendor")
      ? ["Microsoft", "Palo Alto", "CrowdStrike", "Fortinet", "Cisco"][Math.floor(rand() * 5)]
      : ["Defender", "Cortex", "Falcon", "FortiGate", "ASA"][Math.floor(rand() * 5)];
  }

  if (lower.includes("version")) {
    return `${1 + Math.floor(rand() * 5)}.${Math.floor(rand() * 10)}.${Math.floor(rand() * 100)}`;
  }

  if (lower.includes("country") || lower.includes("region") || lower.includes("location")) {
    return ["US", "GB", "DE", "JP", "AU", "CA", "FR"][Math.floor(rand() * 7)];
  }

  // Generic string fallback
  return `sample_${name}_value`;
}
