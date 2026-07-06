/**
 * Pack outputs.yml serializer - porting-plan Unit 19, task item 5, and section 3
 * contract 4.
 *
 * The task requires outputs.yml to be produced VIA THE EXISTING
 * sentinel-destination module, not by duplicating the field set. So the scaffold
 * builds each destination with {@link buildSentinelDestination} (Unit 20's
 * single source for the tuning block, url composition, and single-quoted
 * client_id), and THIS module only SERIALIZES those config objects to the pack's
 * YAML shape. Every emitted field flows from the config object, so the tuning
 * values are never re-listed here.
 *
 * ONE override: `secret` is emitted as the Cribl secret reference
 * `!{sentinel_client_secret}` (the resolved decision recorded in porting-plan:
 * destinations reference a named Cribl secret; `<replace me>` survives only in
 * air-gap artifacts). The legacy pack outputs.yml used exactly this reference
 * (pack-builder.ts 2573).
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import type { SentinelDestinationConfig } from "../sentinel-destination";

/** The Cribl secret reference the pack outputs.yml embeds for `secret`. */
export const CRIBL_SECRET_REFERENCE = "!{sentinel_client_secret}";

/** String keys whose values must be double-quoted in the emitted YAML. */
const QUOTED_STRING_KEYS = new Set(["loginUrl", "url"]);

function formatScalar(key: string, value: string | number | boolean): string {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  // client_id already carries its own literal single quotes; scope/dceEndpoint/
  // etc. contain no colon-space and stay unquoted (legacy behavior).
  return QUOTED_STRING_KEYS.has(key) ? `"${value}"` : value;
}

/** Serialize one destination config block under `outputs:`. */
function serializeBlock(config: SentinelDestinationConfig, secretRef: string): string[] {
  const lines: string[] = [`  ${config.id}:`];
  for (const [key, value] of Object.entries(config)) {
    if (key === "id") continue;
    if (key === "secret") {
      lines.push(`    secret: "${secretRef}"`);
      continue;
    }
    if (Array.isArray(value)) {
      lines.push(`    ${key}: ${value.length === 0 ? "[]" : JSON.stringify(value)}`);
      continue;
    }
    if (value !== null && typeof value === "object") {
      lines.push(`    ${key}:`);
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        lines.push(`      ${k}: ${String(v)}`);
      }
      continue;
    }
    lines.push(`    ${key}: ${formatScalar(key, value as string | number | boolean)}`);
  }
  return lines;
}

/**
 * Serialize a set of Sentinel destination configs into the pack's
 * default/outputs.yml. `secret` is replaced with the Cribl secret reference.
 */
export function serializeSentinelOutputsYml(
  configs: SentinelDestinationConfig[],
  options: { secretRef?: string } = {},
): string {
  const secretRef = options.secretRef ?? CRIBL_SECRET_REFERENCE;
  const lines: string[] = ["outputs:"];
  for (const config of configs) {
    lines.push(...serializeBlock(config, secretRef));
    lines.push("");
  }
  return lines.join("\n") + "\n";
}
