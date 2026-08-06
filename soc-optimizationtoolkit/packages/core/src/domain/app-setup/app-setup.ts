/**
 * App setup state - the two facts the shells persist about a first run:
 * whether the acceptable-use agreement was accepted, and whether the setup
 * wizard was completed.
 *
 * This module was app-mode. The four operating modes it used to own (AppMode,
 * hasAzure/hasCribl, filterNavItems and the NavRequirement model) were retired
 * by capability-model-plan step 5: modes were always a PROXY for what an
 * identity could do, and the capability audit measures the real thing. The
 * acceptance record stayed because it was only ever housed here, and the setup
 * record joins it because mode was doubling as the "wizard finished" signal -
 * a job that deserves its own name rather than a side effect of a mode value.
 *
 * Both codecs are TOLERANT and TOTAL: any untrusted string yields a usable
 * answer rather than throwing, mirroring parseAzureConfig.
 *
 * Pure: no IO, no clock. Timestamps are shell-injected.
 */

/** True when `value` is a plain (non-null, non-array) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Proof that the user accepted the acceptable-use agreement.
 *
 * The timestamp is an opaque string minted BY THE SHELL at acceptance time
 * (core never calls Date); it exists for audit display, not for comparison.
 */
export interface AcceptanceRecord {
  /** When the agreement was accepted (shell-injected ISO 8601 string). */
  acceptedAt: string;
}

/**
 * Serialize an acceptance record for persistence. Emits exactly the one known
 * field; extra properties on the caller's object are never written out.
 * Round-trips through {@link parseAcceptanceRecord}.
 */
export function serializeAcceptanceRecord(record: AcceptanceRecord): string {
  return JSON.stringify({ acceptedAt: record.acceptedAt });
}

/**
 * Parse an untrusted persisted blob into an acceptance record.
 *
 * TOLERANT and TOTAL - never throws. Returns a record only for a JSON plain
 * object carrying a non-empty string `acceptedAt` (the legacy blob
 * `{"accepted":true,"acceptedAt":"..."}` qualifies; its extra key is dropped).
 * Everything else - null/undefined, empty input, malformed JSON, non-objects,
 * a missing/empty/non-string `acceptedAt` - returns `null`, meaning "not
 * accepted": the shell must show the agreement gate. A load failure therefore
 * re-prompts rather than silently waving the user through.
 */
export function parseAcceptanceRecord(
  raw: string | null | undefined,
): AcceptanceRecord | null {
  if (typeof raw !== "string" || raw.trim() === "") {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isPlainObject(parsed)) {
    return null;
  }

  const acceptedAt = parsed["acceptedAt"];
  if (typeof acceptedAt !== "string" || acceptedAt.trim() === "") {
    return null;
  }
  return { acceptedAt };
}

// ---------------------------------------------------------------------------
// Setup completion
// ---------------------------------------------------------------------------

/**
 * Proof the operator finished the first-run wizard.
 *
 * Replaces the persisted app mode as the "show the wizard or the app?" signal.
 * Mode carried that meaning incidentally - a null mode meant "not yet chosen",
 * which the shells read as "not yet set up" - so deleting modes needed this
 * fact stated in its own right.
 */
export interface SetupRecord {
  /** When setup was completed (shell-injected ISO 8601 string). */
  completedAt: string;
}

/** What Reconfigure writes to reopen the wizard: an EMPTY JSON object. */
export const EMPTY_SETUP_RECORD = "{}";

/**
 * Serialize a setup record. Emits exactly the one known field; extra properties
 * on the caller's object are never written out.
 */
export function serializeSetupRecord(record: SetupRecord): string {
  return JSON.stringify({ completedAt: record.completedAt });
}

/**
 * Parse a persisted setup record, or null when setup has not been completed.
 *
 * TOTAL: unparseable text, a non-object, and the EMPTY_SETUP_RECORD that
 * Reconfigure writes all read as null - "not set up" - so a corrupt entry
 * reopens the wizard rather than stranding the operator in a half-configured
 * app.
 */
export function parseSetupRecord(raw: string | null | undefined): SetupRecord | null {
  if (raw === null || raw === undefined || raw === "") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) {
    return null;
  }
  const completedAt = parsed["completedAt"];
  return typeof completedAt === "string" && completedAt.trim() !== ""
    ? { completedAt }
    : null;
}
