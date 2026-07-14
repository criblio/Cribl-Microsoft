/**
 * Config JSON validation - the PURE glue behind the settings screen's
 * validate-before-save raw-JSON editor (the pattern mined from the legacy
 * ConfigEditor, applied to the one JSON-editable surface that exists today:
 * the active connection profile's non-secret AzureConfig).
 *
 * Contract:
 *   - Save is refused for anything that is not a JSON PLAIN OBJECT. The
 *     legacy editor accepted any parseable JSON (arrays, numbers, strings),
 *     which parseAzureConfig would then silently flatten to an empty config;
 *     here the user gets an error instead of a silent wipe.
 *   - A valid object is normalized through @soc/core's tolerant
 *     parseAzureConfig (the ONE codec), and everything the codec would drop
 *     or coerce is surfaced as a warning rather than disappearing silently:
 *     unknown keys (including a pasted clientSecret - never stored), known
 *     fields with non-string values (reset to ''), and an invalid setupPath
 *     (reset to 'existing').
 *
 * Pure: no IO, no fetch, no React.
 */

import { EMPTY_AZURE_CONFIG, parseAzureConfig } from "@soc/core";
import type { AzureConfig } from "@soc/core";

/** The verdict for one editor save attempt. */
export type ConfigJsonResult =
  | {
      ok: true;
      /** The normalized config exactly as parseAzureConfig produced it. */
      config: AzureConfig;
      /** The canonical pretty-printed form of `config` (editor re-display). */
      normalizedJson: string;
      /** What the codec dropped or coerced; empty for a clean round-trip. */
      warnings: string[];
    }
  | { ok: false; error: string };

/** The six known AzureConfig keys; everything else is dropped by the codec. */
const KNOWN_KEYS = new Set(Object.keys(EMPTY_AZURE_CONFIG));

/**
 * Validate raw editor text into a saveable AzureConfig, or a save-refusing
 * error. Never throws.
 */
export function validateConfigJson(text: string): ConfigJsonResult {
  const trimmed = text.trim();
  if (trimmed === "") {
    return {
      ok: false,
      error: "The editor is empty - provide a JSON object with the config fields.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return {
      ok: false,
      error: `Not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error:
        "The config must be a JSON object (for example {\"tenantId\": \"...\"}), " +
        "not an array, string, number, or null.",
    };
  }

  const input = parsed as Record<string, unknown>;
  const config = parseAzureConfig(trimmed);
  const warnings: string[] = [];

  for (const key of Object.keys(input)) {
    if (!KNOWN_KEYS.has(key)) {
      warnings.push(
        `Unknown key "${key}" was dropped - only the non-secret config fields ` +
          `(${[...KNOWN_KEYS].join(", ")}) are stored. Secrets are never saved here.`,
      );
    }
  }

  for (const key of KNOWN_KEYS) {
    if (key === "setupPath") {
      continue;
    }
    const value = input[key];
    if (value !== undefined && typeof value !== "string") {
      warnings.push(`"${key}" was not a string and was reset to "".`);
    }
  }

  const setupPath = input["setupPath"];
  if (setupPath !== undefined && setupPath !== config.setupPath) {
    warnings.push(
      `"setupPath" ${JSON.stringify(setupPath)} is not one of the valid values ` +
        `and was reset to "existing".`,
    );
  }

  return {
    ok: true,
    config,
    normalizedJson: JSON.stringify(config, null, 2),
    warnings,
  };
}
