/**
 * Which family a destination table belongs to - the ONE answer to "is this an
 * ASim normalized table?" (architecture audit 2026-11-04).
 *
 * Two copies of this test had drifted apart: the overflow config matched
 * `/^ASim/i` while vendor-identity's required-fields check used a case-
 * sensitive `startsWith("ASim")`, so `asimnetworksessionlogs` got ASim's
 * AdditionalFields catch-all but none of ASim's EventVendor/EventProduct
 * requirement. Both now ask here.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

/** True for the ASim normalized tables (ASimNetworkSessionLogs, ...). */
export function isAsimTableName(tableName: string): boolean {
  return /^asim/i.test(tableName.trim());
}
