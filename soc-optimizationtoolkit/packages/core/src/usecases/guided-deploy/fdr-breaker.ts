/**
 * CrowdStrike FDR event breaker - porting-plan Unit 20 task item 4, and section
 * 3 compatibility contract 11 (breaker knowledge).
 *
 * When the deployed vendor is CrowdStrike, the legacy deploy created a
 * worker-group-level event breaker so Cribl Insights extracts _time accurately
 * from FDR events whose "timestamp" field position varies across event types
 * (SentinelIntegration.tsx 1248-1265). The breaker literal is a COMPATIBILITY
 * CONTRACT (deployed environments rely on the exact anchor regex / maxEventBytes
 * / timestamp format), so it is extracted VERBATIM here as core data - no field
 * is re-derived. maxEventBytes 786432 is the same value pack-assembly pins as
 * CROWDSTRIKE_MAX_EVENT_BYTES (a cross-check test guards the two against drift).
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import type { CriblRequest } from "../../ports/cribl-client";

/** The breaker id/ruleset name the legacy created (stable, referenced by tag). */
export const CROWDSTRIKE_FDR_BREAKER_ID = "CrowdStrike_FDR";

/** One rule inside {@link CrowdStrikeFdrBreaker}. */
export interface CrowdStrikeFdrBreakerRule {
  name: string;
  type: "json_array";
  condition: string;
  timestampAnchorRegex: string;
  timestamp: { type: "format"; length: number; format: string };
  timestampTimezone: string;
  maxEventBytes: number;
  jsonExtractAll: boolean;
}

/** The CrowdStrike FDR event-breaker ruleset (POST /lib/breakers body). */
export interface CrowdStrikeFdrBreaker {
  id: string;
  lib: "custom";
  description: string;
  tags: string;
  rules: CrowdStrikeFdrBreakerRule[];
}

/**
 * Build the CrowdStrike FDR event-breaker ruleset, VERBATIM from the legacy
 * literal (SentinelIntegration.tsx 1248-1265). Returned as a fresh object each
 * call so callers can never mutate shared core data.
 */
export function buildCrowdStrikeFdrBreaker(): CrowdStrikeFdrBreaker {
  return {
    id: CROWDSTRIKE_FDR_BREAKER_ID,
    lib: "custom",
    description:
      "CrowdStrike FDR event breaker. Anchors timestamp extraction directly " +
      'on the "timestamp" field (epoch ms) to handle varying field positions ' +
      "across event types. 768KB max for ScriptContent events.",
    tags: "CrowdStrike,FDR,Sentinel",
    rules: [
      {
        name: "CrowdStrike FDR JSON",
        type: "json_array",
        condition:
          "/crowdstrike/i.test(source) || /crowdstrike/i.test(sourcetype)",
        timestampAnchorRegex: '/"timestamp":\\s*"/',
        timestamp: { type: "format", length: 150, format: "%s%L" },
        timestampTimezone: "utc",
        maxEventBytes: 786432,
        jsonExtractAll: true,
      },
    ],
  };
}

/**
 * Whether a vendor/solution name denotes CrowdStrike (legacy test:
 * `vendorName.toLowerCase().includes('crowdstrike')`). The FDR breaker is
 * created only when this is true.
 */
export function isCrowdStrikeVendor(vendor: string): boolean {
  return vendor.toLowerCase().includes("crowdstrike");
}

/** Cribl API path the FDR breaker is created on (porting-plan external surface). */
export const BREAKERS_API_PATH = "/lib/breakers";

/**
 * Shape the CriblClient request that creates the FDR breaker on a worker group.
 * The shell performs the call (and any create-vs-update conflict handling); this
 * only composes the request so the path and body stay identical across shells.
 */
export function buildFdrBreakerRequest(groupId: string): CriblRequest {
  return {
    method: "POST",
    path: BREAKERS_API_PATH,
    groupId,
    body: buildCrowdStrikeFdrBreaker(),
  };
}
