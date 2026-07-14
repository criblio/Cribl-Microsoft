/**
 * App mode - THE ONE SOURCE OF TRUTH FOR WHAT THE APP MAY TOUCH.
 *
 * The legacy Electron app read its integration mode from disk in four
 * independent places (App.tsx module-level `integrationMode`, Sidebar's
 * `sidebarMode` state, Sidebar's ModeIndicator, and the settings surface),
 * each with its own default and its own staleness window. This module is the
 * fix: ONE mode model, ONE tolerant codec, ONE pair of capability predicates,
 * and ONE nav filter derived from those predicates. Shells load the persisted
 * mode once and thread the parsed value through; nothing else re-reads storage.
 *
 * The four modes:
 *
 *   full        - live Azure AND live Cribl connections.
 *   azure-only  - live Azure; Cribl artifacts are generated for download.
 *   cribl-only  - live Cribl; Azure artifacts are generated for download.
 *   air-gapped  - NEITHER live connection. Everything the app would deploy
 *                 (packs, ARM templates, destination configs, instructions)
 *                 is generated as downloadable artifacts instead, so the user
 *                 can review and apply every change manually.
 *
 * `null` consistently means "not yet chosen": parse returns it for anything
 * unrecognized, and every predicate treats it as having NO live capability
 * (the safe default while onboarding has not completed).
 *
 * Also owned here: the AcceptanceRecord for the acceptable-use agreement.
 * Same tolerance discipline - `null` means "not accepted", and the timestamp
 * is injected by the shell (core never calls Date).
 *
 * Pure: no IO, no fetch, no React.
 */

/** The four operating modes. See the module header for what each may touch. */
export type AppMode = "full" | "azure-only" | "cribl-only" | "air-gapped";

/** All valid {@link AppMode} values, for runtime validation and UI listing. */
export const APP_MODES: readonly AppMode[] = [
  "full",
  "azure-only",
  "cribl-only",
  "air-gapped",
];

/** Narrow an unknown to a valid {@link AppMode}, else null. */
function asAppMode(value: unknown): AppMode | null {
  return APP_MODES.includes(value as AppMode) ? (value as AppMode) : null;
}

/**
 * Serialize a mode for persistence.
 *
 * Emits the `{"mode":"..."}` object shape (the shape the legacy app persisted
 * as integration-mode.json), so blobs written by this codec also parse under
 * legacy-shaped readers during migration. Round-trips through
 * {@link parseAppMode}.
 */
export function serializeAppMode(mode: AppMode): string {
  return JSON.stringify({ mode });
}

/** True when `value` is a plain (non-null, non-array) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse an untrusted persisted blob into a mode.
 *
 * TOLERANT and TOTAL - never throws. Accepts, in order:
 *   - a bare mode string, surrounding whitespace ignored (`"full"`)
 *   - a JSON string literal encoding a mode (`'"full"'`)
 *   - a JSON object with a `mode` key (`'{"mode":"full"}'` - the legacy
 *     integration-mode.json shape and the {@link serializeAppMode} output)
 *
 * Anything else - null/undefined, empty input, malformed JSON, unknown mode
 * names, wrong types - returns `null`, meaning "not yet chosen". Callers must
 * treat `null` as "route the user to mode selection", never as a default mode.
 */
export function parseAppMode(raw: string | null | undefined): AppMode | null {
  if (typeof raw !== "string") {
    return null;
  }

  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }

  const bare = asAppMode(trimmed);
  if (bare !== null) {
    return bare;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof parsed === "string") {
    return asAppMode(parsed.trim());
  }
  if (isPlainObject(parsed)) {
    return asAppMode(parsed["mode"]);
  }
  return null;
}

/**
 * Whether this mode has a LIVE Azure connection.
 *
 * False for `air-gapped` (no live connections by definition), `cribl-only`,
 * and `null` (mode not yet chosen - no capability until the user decides).
 */
export function hasAzure(mode: AppMode | null): boolean {
  return mode === "full" || mode === "azure-only";
}

/**
 * Whether this mode has a LIVE Cribl connection.
 *
 * False for `air-gapped`, `azure-only`, and `null` (not yet chosen).
 */
export function hasCribl(mode: AppMode | null): boolean {
  return mode === "full" || mode === "cribl-only";
}

/**
 * What a navigation item needs before it is shown:
 *
 *   none  - always shown (generation-only surfaces work even air-gapped)
 *   cribl - needs a live Cribl connection
 *   azure - needs a live Azure connection
 *   both  - needs BOTH live connections (only `full` qualifies)
 */
export type NavRequirement = "cribl" | "azure" | "both" | "none";

/** The minimal shape {@link filterNavItems} needs; items may carry more. */
export interface NavItemRequirement {
  /** Stable identifier for the nav item (route id, not display text). */
  id: string;
  /** What the item needs before it is shown. */
  requires: NavRequirement;
}

/** True when `mode` satisfies a single {@link NavRequirement}. */
export function satisfiesRequirement(
  mode: AppMode | null,
  requires: NavRequirement,
): boolean {
  switch (requires) {
    case "none":
      return true;
    case "cribl":
      return hasCribl(mode);
    case "azure":
      return hasAzure(mode);
    case "both":
      return hasAzure(mode) && hasCribl(mode);
  }
}

/**
 * Filter navigation items to those the current mode can actually use.
 *
 * Derived entirely from {@link hasAzure}/{@link hasCribl} so the nav can never
 * disagree with the capability predicates (the legacy filter reimplemented the
 * mode logic inline and was one of the four independent reads). Order and any
 * extra fields on the items are preserved. With `mode` null (not yet chosen)
 * only `requires: "none"` items survive.
 */
export function filterNavItems<T extends NavItemRequirement>(
  mode: AppMode | null,
  items: readonly T[],
): T[] {
  return items.filter((item) => satisfiesRequirement(mode, item.requires));
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
