/**
 * field-matcher SCORING - porting-plan Unit 13 (ENG-04).
 *
 * The 6-strategy score ladder (scoreMatch), the type-aware sample-value boost
 * (typeValueBoost), and the two substring guards, ported VERBATIM from legacy
 * field-matcher.ts (lines 526-617). These scores ARE the contract.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type { MatchConfidence } from "./models";
import { ALIAS_TABLE, REVERSE_ALIAS } from "./knowledge-bases";

/**
 * Lowercased-key alias index (2026-07-08 improvement): the legacy lookup was
 * case-SENSITIVE on the alias key, so a case variant of a known source field
 * ("SRC", "User_Agent") silently missed its alias and fell to fuzzy/overflow.
 * Exact-key lookup still runs first; this index is the fallback. Key
 * collisions after lowercasing (CustomString1 vs customstring1) carry
 * equivalent values, so last-wins is harmless.
 */
const ALIAS_TABLE_LOWER = new Map<string, string[]>();
for (const [key, dests] of Object.entries(ALIAS_TABLE)) {
  ALIAS_TABLE_LOWER.set(key.toLowerCase(), dests);
}

/** Strip separators and lowercase (camelCase preserved for comparison). */
export function normalize(name: string): string {
  return name
    .replace(/[_\-\s]/g, "") // Strip separators
    .replace(/([a-z])([A-Z])/g, "$1$2") // Keep camelCase intact for comparison
    .toLowerCase();
}

/** Strip common prefixes/suffixes for fuzzy matching. */
export function stripAffixes(name: string): string {
  return name
    .replace(
      /^(source|src|dest|destination|dst|device|event|client|origin|edge|network)/i,
      "",
    )
    .replace(/(name|value|address|field|string|number|label|id)$/i, "")
    .toLowerCase()
    .replace(/[_-]/g, "");
}

/**
 * Standard Sentinel columns that vendor-prefixed / *Label source fields must
 * NOT claim via fuzzy substring match. Verbatim from legacy scoreMatch.
 */
export const STANDARD_COLUMNS = new Set([
  "sourceip",
  "destinationip",
  "sourceport",
  "destinationport",
  "protocol",
  "deviceaction",
  "timegenerated",
  "applicationprotocol",
  "logseverity",
  "activity",
  "devicename",
  "computer",
  "sourceusername",
  "destinationusername",
  "receipttime",
  "starttime",
  "endtime",
  "requesturl",
  "filename",
  "message",
  "eventcount",
  "externalid",
  "deviceaddress",
  "deviceeventclassid",
  "deviceeventcategory",
  "communicationdirection",
  "eventoutcome",
  "devicecustomstring1",
  "devicecustomstring2",
  "devicecustomstring3",
  "devicecustomstring4",
  "devicecustomstring5",
  "devicecustomstring6",
  "devicecustomnumber1",
  "devicecustomnumber2",
  "devicecustomnumber3",
]);

/**
 * Score a single source-name -> dest-name pairing through the 6-strategy
 * ladder. Verbatim from legacy scoreMatch. Includes the vendor-prefix guard
 * and the *Label-vs-STANDARD_COLUMNS guard that block fuzzy substring matches
 * from over-claiming standard columns.
 */
export function scoreMatch(
  sourceName: string,
  destName: string,
): { score: number; confidence: MatchConfidence; reason: string } {
  // 1. Exact match
  if (sourceName === destName) {
    return { score: 100, confidence: "exact", reason: "Exact name match" };
  }

  // 2. Case-insensitive match
  if (sourceName.toLowerCase() === destName.toLowerCase()) {
    return { score: 95, confidence: "exact", reason: "Case-insensitive match" };
  }

  // 3. Known alias lookup (exact key first, then the case-insensitive index).
  // RANK-AWARE (2026-07-09 improvement, pinned): candidates earlier in the
  // alias list outscore later ones (90, 89, 88... floored at 86 - still above
  // the 80 normalized-match band), so the LIST order finally means priority.
  // Previously every candidate scored a flat 90 and the SCHEMA's column order
  // broke the tie - which is how `action` (DeviceAction first in its list)
  // once flipped onto Activity purely because Activity precedes DeviceAction
  // in the CommonSecurityLog schema.
  const aliases =
    ALIAS_TABLE[sourceName] ?? ALIAS_TABLE_LOWER.get(sourceName.toLowerCase());
  if (aliases) {
    for (let i = 0; i < aliases.length; i++) {
      if (aliases[i].toLowerCase() === destName.toLowerCase()) {
        return {
          score: Math.max(86, 90 - i),
          confidence: "alias",
          reason: `Known alias: ${sourceName} -> ${aliases[i]}`,
        };
      }
    }
  }

  // Also check reverse: does this dest name expect this source name?
  const reverseSet = REVERSE_ALIAS.get(destName.toLowerCase());
  if (reverseSet && reverseSet.has(sourceName.toLowerCase())) {
    return {
      score: 88,
      confidence: "alias",
      reason: `Reverse alias: ${destName} <- ${sourceName}`,
    };
  }

  // 4. Normalized name match
  const normSrc = normalize(sourceName);
  const normDst = normalize(destName);
  if (normSrc === normDst) {
    return {
      score: 80,
      confidence: "fuzzy",
      reason: "Normalized name match (stripped separators)",
    };
  }

  // 5. Stripped affixes match
  const strippedSrc = stripAffixes(sourceName);
  const strippedDst = stripAffixes(destName);
  if (
    strippedSrc.length > 2 &&
    strippedDst.length > 2 &&
    strippedSrc === strippedDst
  ) {
    return {
      score: 70,
      confidence: "fuzzy",
      reason: "Core name match after stripping prefixes/suffixes",
    };
  }

  // 6. Substring containment (lower confidence)
  // Guard: vendor-prefixed source fields (PanOS*, Fortinet*, Cisco*, etc.) should NOT
  // claim standard Sentinel columns via fuzzy substring match. This prevents
  // "PanOSIsNonStandardDestinationPort" from claiming "DestinationPort".
  const isVendorPrefixed =
    /^(PanOS|Fortinet|Forti|Cisco|Check|Zscaler|CrowdStrike|Barracuda|Sophos)/i.test(
      sourceName,
    );
  const isStandardDest = STANDARD_COLUMNS.has(normDst);
  // Also block *Label fields from claiming non-Label columns (e.g., imageFileNameLabel -> FileName)
  const isLabelClaimingNonLabel =
    sourceName.endsWith("Label") && !destName.endsWith("Label");

  if ((!isVendorPrefixed && !isLabelClaimingNonLabel) || !isStandardDest) {
    if (normSrc.length > 3 && normDst.includes(normSrc)) {
      return {
        score: 55,
        confidence: "fuzzy",
        reason: `Source name "${sourceName}" contained in dest "${destName}"`,
      };
    }
    if (normDst.length > 3 && normSrc.includes(normDst)) {
      return {
        score: 50,
        confidence: "fuzzy",
        reason: `Dest name "${destName}" contained in source "${sourceName}"`,
      };
    }
  }

  return { score: 0, confidence: "unmatched", reason: "" };
}

/**
 * Type-aware sample-value scoring (OCSF/ECS pattern). When two source fields
 * tie on name score, inspect the sample value to boost confidence for a
 * type-appropriate destination. Verbatim from legacy typeValueBoost.
 */
export function typeValueBoost(
  sampleValue: string | undefined,
  destName: string,
  destType: string,
): number {
  if (!sampleValue) return 0;

  const destLower = destName.toLowerCase();

  // IP address detection -> boost for IP destination fields.
  // FIXED 2026-07-09: the legacy IPv6 pattern had no required ":", so ANY
  // bare number ("500") or hex string read as "IP-looking" and handed a +12
  // boost to *IP*/*Address* columns.
  if (
    /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(sampleValue) ||
    (sampleValue.includes(":") && /^[0-9a-f:]{3,39}$/i.test(sampleValue))
  ) {
    // IPv4 or IPv6
    if (destLower.includes("ip") || destLower.includes("address")) return 12;
  }

  // Port number detection (1-65535) -> boost for Port fields
  if (
    /^\d{1,5}$/.test(sampleValue) &&
    Number(sampleValue) >= 1 &&
    Number(sampleValue) <= 65535
  ) {
    if (destLower.includes("port")) return 10;
  }

  // Timestamp detection -> boost for time/date fields
  if (
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(sampleValue) ||
    /^\d{10,13}$/.test(sampleValue)
  ) {
    if (
      destType === "datetime" ||
      destLower.includes("time") ||
      destLower.includes("date")
    )
      return 12;
  }

  // URL detection -> boost for URL/Request fields
  if (/^https?:\/\//.test(sampleValue) || /^\/[a-zA-Z0-9]/.test(sampleValue)) {
    if (
      destLower.includes("url") ||
      destLower.includes("request") ||
      destLower.includes("uri")
    )
      return 10;
  }

  // MAC address -> boost for MAC fields
  if (/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(sampleValue)) {
    if (destLower.includes("mac")) return 12;
  }

  // Protocol name -> boost for Protocol field
  if (
    /^(TCP|UDP|ICMP|HTTP|HTTPS|DNS|SSH|TLS|SSL|FTP|SMTP|GRE|ESP)$/i.test(
      sampleValue,
    )
  ) {
    if (destLower.includes("protocol")) return 10;
  }

  // Action value -> boost for Action field
  if (
    /^(allow|deny|drop|block|permit|reject|reset|alert|pass|accept)$/i.test(
      sampleValue,
    )
  ) {
    if (destLower.includes("action")) return 10;
  }

  // Numeric severity -> boost for Severity field
  if (
    /^[0-9]$/.test(sampleValue) ||
    /^(low|medium|high|critical|informational|warning)$/i.test(sampleValue)
  ) {
    if (
      destLower.includes("severity") ||
      destLower.includes("level") ||
      destLower.includes("priority")
    )
      return 8;
  }

  return 0;
}
