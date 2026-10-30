/**
 * PAN-OS CEF ROUTE BY HEADER TYPE (GEN-24) - the route filter for a log type
 * that DBT-196's split named from CEF header field 6.
 *
 * WHY THE GENERIC LADDER CANNOT DO THIS. PAN-OS writes CEF as
 * `CEF:0|Palo Alto Networks|PAN-OS|ver|SUBTYPE|TYPE|sev|ext`, and DBT-196 splits
 * a capture by TYPE (THREAT, TRAFFIC). Both discriminators in this directory
 * skip CEF header fields (isMintedHeaderField, GEN-8): the header field NAMES
 * exist only in the parsed record, so `Name === 'THREAT'` is false for every
 * unparsed route-time event. So a two-type PAN-OS pack fell to whatever the
 * extension pairs offered. Measured on the UAT capture fixture before this
 * change: THREAT routed on `PanOSContentVer === 'AppThreat-8800-8888'` (a
 * content-package version, which changes with every content update and names
 * the log type only by the accident of containing "Threat"), and TRAFFIC was
 * placeholdered when the mappings named few fields.
 *
 * WHAT IS EMITTED. The header VALUE is in the raw text even though its name is
 * not, so the filter tests `_raw` with a regex that walks the header:
 *
 *   /CEF:F\|Palo Alto Networks\|PAN-OS\|F\|F\|THREAT\|/.test(_raw)
 *
 * where F is sample-parsing's own CEF header field body, so an escaped pipe
 * (`\|`) inside DeviceVersion or the subtype is stepped over by the same rule
 * the parser splits by - not counted as a separator. Anchoring to the vendor,
 * the product and field 6 is the point: a TRAFFIC line whose SUBTYPE is
 * `THREAT`, or whose extension carries `|THREAT|`, does not match the THREAT
 * route. Unanchored before `CEF:`, so a syslog-wrapped line routes like a bare
 * one, as it splits like one.
 *
 * SCOPED EXACTLY AS DBT-196 IS, and by the same predicate
 * ({@link isPanosCefIdentity}): any other vendor's log types keep the generic
 * ladder unchanged. Guards, each returning null so the caller carries on down
 * that ladder:
 *   - the format is cef;
 *   - every own event carries ONE DeviceVendor, ONE DeviceProduct and ONE Name
 *     (the TYPE), and the vendor and product are PAN-OS;
 *   - the TYPE is a plain token (letters, digits, `_`, `-` - every PAN-OS log
 *     type), so nothing has to be escaped into the regex or the YAML;
 *   - no sibling carries the same TYPE, or the filter would take its events.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import { CEF_HEADER_FIELD_BODY, isPanosCefIdentity } from "../sample-parsing";
import { fieldPresence } from "./route-value-discriminator";
import type { LogTypeFieldValues } from "./route-value-discriminator";

/** A header value safe to place in the regex literal verbatim. */
const PLAIN_TOKEN = /^[A-Za-z0-9_-]+$/;

/** The one value a field takes in EVERY own event, else undefined. */
function constantValue(
  own: LogTypeFieldValues,
  field: string,
): string | undefined {
  if (fieldPresence(own, field) !== "every-event") return undefined;
  const distinct = new Set(own.values[field]);
  return distinct.size === 1 ? [...distinct][0] : undefined;
}

/** Escape a literal for a JS regex literal (including its `/` delimiter). */
function regexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * The header-TYPE route filter for one PAN-OS CEF log type, or null when the
 * evidence is not PAN-OS CEF with a constant, unshared, plain TYPE.
 */
export function derivePanosCefTypeFilter(
  own: LogTypeFieldValues,
  siblings: readonly LogTypeFieldValues[],
  format: string,
): string | null {
  if (format.toLowerCase() !== "cef") return null;
  const vendor = constantValue(own, "DeviceVendor");
  const product = constantValue(own, "DeviceProduct");
  const type = constantValue(own, "Name");
  if (vendor === undefined || product === undefined || type === undefined) {
    return null;
  }
  // Trimmed for the scope test, as the split trims; the regex keeps the bytes
  // as sent, which is what `_raw` carries.
  if (!isPanosCefIdentity(vendor.trim(), product.trim())) return null;
  if (!PLAIN_TOKEN.test(type)) return null;
  if (siblings.some((s) => (s.values["Name"] ?? []).includes(type))) {
    return null;
  }
  const f = CEF_HEADER_FIELD_BODY;
  const header = [
    `CEF:${f}`,
    regexLiteral(vendor),
    regexLiteral(product),
    f,
    f,
    type,
  ].join("\\|");
  return `typeof _raw === 'string' && /${header}\\|/.test(_raw)`;
}
