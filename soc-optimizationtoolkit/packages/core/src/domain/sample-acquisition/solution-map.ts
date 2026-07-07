/**
 * Curated solution -> sample-source map and the ONE fuzzy solution matcher -
 * porting-plan Unit 16 (ENG-19).
 *
 * VERBATIM knowledge:
 * - SOLUTION_SAMPLE_MAP: the ~25 curated Sentinel-solution -> sample-source
 *   entries (Elastic package + data streams, Cribl pack repo, Sentinel table,
 *   source format), copied field-for-field from legacy sample-resolver.ts.
 * - lookupSolution 4-stage fuzzy match CONSOLIDATED to ONE matcher. Legacy
 *   re-implemented the same fuzzy-name comparison THREE times (sample-resolver
 *   `lookupSolution`, the inline `synthesizeSamples` matcher, and the
 *   `findSentinelRepoSamples` solution-dir matcher). Here {@link matchSolutionName}
 *   is the single boolean matcher; {@link lookupSolution} applies it against the
 *   curated map preserving the legacy STAGED pass order so the pick is identical.
 * - fuzzyMatchElasticPackage: the scoring matcher against the full Elastic
 *   package index, ported verbatim (STRIP_SUFFIXES, bidirectional containment
 *   scoring, word overlap, the >= 6 minimum-score gate).
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type { SampleSourceEntry } from "./models";

/**
 * Maps Sentinel Solution names to their sample data sources. Ported verbatim
 * from legacy sample-resolver.ts SOLUTION_SAMPLE_MAP (the ~25 curated entries).
 */
export const SOLUTION_SAMPLE_MAP: Record<string, SampleSourceEntry> = {
  "Windows Security Events": {
    elasticPackage: "windows",
    elasticDataStreams: ["sysmon_operational", "powershell", "powershell_operational"],
    criblPackRepo: "cribl-windows-events",
    sentinelTable: "SecurityEvent",
    sourceFormat: "json",
  },
  "Amazon Web Services": {
    elasticPackage: "aws",
    elasticDataStreams: ["cloudtrail", "guardduty", "vpcflow"],
    criblPackRepo: "cribl-aws-cloudtrail-logs",
    sentinelTable: "AWSCloudTrail",
    sourceFormat: "json",
  },
  "Microsoft 365": {
    elasticPackage: "o365",
    elasticDataStreams: ["audit"],
    criblPackRepo: "cribl-microsoft-graph-rest-io",
    sentinelTable: "OfficeActivity",
    sourceFormat: "json",
  },
  Syslog: {
    elasticPackage: "system",
    elasticDataStreams: ["syslog"],
    criblPackRepo: "cribl-syslog-input",
    sentinelTable: "Syslog",
    sourceFormat: "syslog",
  },
  "Microsoft Entra ID": {
    elasticPackage: "azure",
    elasticDataStreams: ["signinlogs", "auditlogs", "identity_protection"],
    sentinelTable: "SigninLogs",
    sourceFormat: "json",
  },
  "Azure Kubernetes Service": {
    elasticPackage: "kubernetes",
    elasticDataStreams: ["audit_logs", "container_logs"],
    sentinelTable: "ContainerLog",
    sourceFormat: "json",
  },
  "Cisco ASA": {
    elasticPackage: "cisco_asa",
    elasticDataStreams: ["log"],
    criblPackRepo: "cribl-cisco-asa-cleanup",
    sentinelTable: "CommonSecurityLog",
    sourceFormat: "syslog",
  },
  CiscoASA: {
    elasticPackage: "cisco_asa",
    elasticDataStreams: ["log"],
    criblPackRepo: "cribl-cisco-asa-cleanup",
    sentinelTable: "CommonSecurityLog",
    sourceFormat: "syslog",
  },
  "Google Workspace": {
    elasticPackage: "google_workspace",
    elasticDataStreams: ["login", "admin", "drive", "saml"],
    criblPackRepo: "cribl-google-workspace-rest-io",
    sentinelTable: "GoogleWorkspace_CL",
    sourceFormat: "json",
  },
  "GitHub Enterprise": {
    elasticPackage: "github",
    elasticDataStreams: ["audit"],
    sentinelTable: "GitHubAuditData",
    sourceFormat: "json",
  },
  "Zscaler Internet Access": {
    elasticPackage: "zscaler_zia",
    elasticDataStreams: ["web", "firewall", "dns", "tunnel"],
    sentinelTable: "CommonSecurityLog",
    sourceFormat: "json",
  },
  "Okta Single Sign-On": {
    elasticPackage: "okta",
    elasticDataStreams: ["system"],
    criblPackRepo: "cribl-okta-rest",
    sentinelTable: "Okta_CL",
    sourceFormat: "json",
  },
  "CrowdStrike Falcon Endpoint Protection": {
    elasticPackage: "crowdstrike",
    elasticDataStreams: ["fdr", "falcon", "alert"],
    criblPackRepo: "cribl_crowdstrike",
    sentinelTable: "CommonSecurityLog",
    sourceFormat: "json",
  },
  "Microsoft Defender XDR": {
    elasticPackage: "microsoft_defender_endpoint",
    elasticDataStreams: ["log"],
    sentinelTable: "SecurityAlert",
    sourceFormat: "json",
  },
  "Microsoft Exchange": {
    elasticPackage: "exchange_server",
    elasticDataStreams: ["httpproxy", "messagetracking"],
    sentinelTable: "W3CIISLog",
    sourceFormat: "csv",
  },
  Suricata: {
    elasticPackage: "suricata",
    elasticDataStreams: ["eve"],
    sentinelTable: "CommonSecurityLog",
    sourceFormat: "json",
  },
  "Cisco Secure Endpoint": {
    elasticPackage: "cisco_secure_endpoint",
    elasticDataStreams: ["event"],
    sentinelTable: "CommonSecurityLog",
    sourceFormat: "json",
  },
  PingID: {
    sentinelTable: "PingID_CL",
    sourceFormat: "json",
  },
  PingFederate: {
    elasticPackage: "ping_federate",
    elasticDataStreams: ["log"],
    sentinelTable: "CommonSecurityLog",
    sourceFormat: "json",
  },
  CircleCI: {
    sentinelTable: "CircleCI_CL",
    sourceFormat: "json",
  },
  PaperCut: {
    sentinelTable: "Syslog",
    sourceFormat: "syslog",
  },
  "Cisco Secure Application": {
    elasticPackage: "cisco_duo",
    elasticDataStreams: ["admin"],
    sentinelTable: "CommonSecurityLog",
    sourceFormat: "json",
  },
  "Fortinet FortiGate": {
    elasticPackage: "fortinet_fortigate",
    elasticDataStreams: ["log"],
    criblPackRepo: "cribl-fortinet-fortigate-firewall",
    sentinelTable: "CommonSecurityLog",
    sourceFormat: "kv",
  },
  "Palo Alto Networks": {
    elasticPackage: "panw",
    elasticDataStreams: ["panos"],
    criblPackRepo: "cribl-palo-alto-networks",
    sentinelTable: "CommonSecurityLog",
    sourceFormat: "csv",
  },
};

/** lowercase, non-alphanumerics removed (the legacy normalization). */
export function normalizeSolutionKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** lowercase words split on whitespace/-/_ , keeping only tokens >= 3 chars. */
function solutionWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[\s\-_]+/)
    .filter((w) => w.length >= 3);
}

/**
 * The ONE fuzzy solution-name matcher (legacy had three copies). Returns true
 * when `a` and `b` should be treated as the same solution under the legacy
 * fuzzy rules: a case-insensitive alnum-equal, a substring either direction, or
 * a shared >= 3-char word (via bidirectional `includes`). Symmetric.
 */
export function matchSolutionName(a: string, b: string): boolean {
  const na = normalizeSolutionKey(a);
  const nb = normalizeSolutionKey(b);
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const wa = solutionWords(a);
  const wb = solutionWords(b);
  return wa.some((x) => wb.some((y) => y.includes(x) || x.includes(y)));
}

/**
 * Look up a solution's curated sample source. Ported from legacy
 * sample-resolver.ts `lookupSolution`, preserving the STAGED pass order (exact
 * key, then case-insensitive alnum-equal, then substring, then word overlap) so
 * that when a name could match several entries the SAME entry legacy returned is
 * returned. Resolves null when no entry matches.
 */
export function lookupSolution(solutionName: string): SampleSourceEntry | null {
  // Stage 1: exact key hit.
  if (SOLUTION_SAMPLE_MAP[solutionName]) return SOLUTION_SAMPLE_MAP[solutionName];

  const lower = normalizeSolutionKey(solutionName);
  const entries = Object.entries(SOLUTION_SAMPLE_MAP);

  // Stage 2: case-insensitive alnum-equal.
  for (const [key, val] of entries) {
    if (normalizeSolutionKey(key) === lower) return val;
  }
  // Stage 3: substring either direction.
  for (const [key, val] of entries) {
    const kl = normalizeSolutionKey(key);
    if (kl.includes(lower) || lower.includes(kl)) return val;
  }
  // Stage 4: word overlap (>= 3-char shared word).
  const solWords = solutionWords(solutionName);
  for (const [key, val] of entries) {
    const keyWords = solutionWords(key);
    const shared = solWords.filter((sw) =>
      keyWords.some((kw) => kw.includes(sw) || sw.includes(kw)),
    );
    if (shared.length >= 1) return val;
  }
  return null;
}

/**
 * Common suffixes stripped from Sentinel solution names before fuzzy matching
 * against the Elastic package index. Ported verbatim from legacy STRIP_SUFFIXES.
 */
export const STRIP_SUFFIXES: readonly string[] = Object.freeze([
  "endpoint protection",
  "security events",
  "single sign-on",
  "sign on",
  "internet access",
  "secure endpoint",
  "threat protection",
  "for microsoft sentinel",
  "for sentinel",
  "for azure",
  "solution",
  "connector",
  "integration",
]);

/**
 * Fuzzy-match a Sentinel solution name to an Elastic integration package name.
 * Ported verbatim from legacy sample-resolver.ts `fuzzyMatchElasticPackage`:
 * strip common suffixes, normalize, score bidirectional containment (>= 4 chars,
 * weighted x2) plus per-word overlap, and require a minimum score of 6 (a
 * 3-letter word matched bidirectionally) to avoid false positives. Returns the
 * best package name or null.
 */
export function fuzzyMatchElasticPackage(
  solutionName: string,
  packageNames: readonly string[],
): string | null {
  let normalized = solutionName.toLowerCase();
  for (const suffix of STRIP_SUFFIXES) {
    normalized = normalized.replace(new RegExp(`\\s*${suffix}\\s*`, "gi"), " ");
  }
  normalized = normalized.replace(/[^a-z0-9\s]/g, "").trim();
  const solWords = normalized.split(/\s+/).filter((w) => w.length >= 2);
  const solJoined = solWords.join("");

  let bestMatch: string | null = null;
  let bestScore = 0;

  for (const pkg of packageNames) {
    const pkgNorm = pkg.replace(/[_-]/g, "").toLowerCase();
    let score = 0;

    if (pkgNorm === solJoined) return pkg;

    if (solJoined.includes(pkgNorm) && pkgNorm.length >= 4) {
      score += pkgNorm.length * 2;
    } else if (pkgNorm.includes(solJoined) && solJoined.length >= 4) {
      score += solJoined.length * 2;
    }

    for (const word of solWords) {
      if (word.length >= 3 && pkgNorm.includes(word)) {
        score += word.length;
      }
    }

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

  return bestScore >= 6 ? bestMatch : null;
}
