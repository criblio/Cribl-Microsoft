/**
 * App theme - ONE codec and ONE resolution rule for light/dark mode.
 *
 * Ships with the guided-journey shell (Unit 6.5) per the porting-plan
 * dark-mode note: the theme choice persists as a plain 'appTheme' entry
 * following the appMode pattern (bare string, JSON string literal, or a
 * small object wrapper), and both shells resolve it through the single
 * {@link resolveTheme} rule so the frame toggle and the Settings screen can
 * never disagree.
 *
 * One deliberate difference from the appMode codec: the parse DEFAULTS to
 * "system" instead of returning null. A mode must route the user to a
 * selection screen when unchosen, but a theme must always resolve to
 * something renderable - and "follow the OS preference" is the safe,
 * assumption-free reading of "never chosen" or "blob corrupted".
 *
 * The systemPrefersDark signal is SHELL-OWNED (a matchMedia
 * prefers-color-scheme listener in the browser); core only combines it with
 * the choice. Caveat carried from the plan note: inside the Cribl iframe,
 * "system" follows the OS preference, not Cribl's own UI theme - no platform
 * theme signal exists.
 *
 * Pure: no IO, no fetch, no React, no Date, no crypto.
 */

/** The persisted user choice: an explicit theme, or follow the OS. */
export type ThemeChoice = "light" | "dark" | "system";

/** All valid {@link ThemeChoice} values, for runtime validation and UI listing. */
export const THEME_CHOICES: readonly ThemeChoice[] = [
  "light",
  "dark",
  "system",
];

/** What {@link parseThemeChoice} yields for anything unrecognized. */
export const DEFAULT_THEME_CHOICE: ThemeChoice = "system";

/** A concrete renderable theme after resolution ("system" is resolved away). */
export type ResolvedTheme = "light" | "dark";

/** Narrow an unknown to a valid {@link ThemeChoice}, else null. */
function asThemeChoice(value: unknown): ThemeChoice | null {
  return THEME_CHOICES.includes(value as ThemeChoice)
    ? (value as ThemeChoice)
    : null;
}

/** True when `value` is a plain (non-null, non-array) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Serialize a theme choice for persistence. Emits the `{"theme":"..."}`
 * object shape, mirroring the appMode codec's wrapper convention.
 * Round-trips through {@link parseThemeChoice}.
 */
export function serializeThemeChoice(choice: ThemeChoice): string {
  return JSON.stringify({ theme: choice });
}

/**
 * Parse an untrusted persisted blob into a theme choice.
 *
 * TOLERANT and TOTAL - never throws. Accepts, in order:
 *   - a bare choice string, surrounding whitespace ignored (`"dark"`)
 *   - a JSON string literal encoding a choice (`'"dark"'`)
 *   - a JSON object with a `theme` key (`'{"theme":"dark"}'` - the
 *     {@link serializeThemeChoice} output; extra keys are dropped)
 *
 * Anything else - null/undefined, empty input, malformed JSON, unknown
 * names, wrong types, wrong casing - returns "system": the app follows the
 * OS preference until the user explicitly picks a theme.
 */
export function parseThemeChoice(raw: string | null | undefined): ThemeChoice {
  if (typeof raw !== "string") {
    return DEFAULT_THEME_CHOICE;
  }

  const trimmed = raw.trim();
  if (trimmed === "") {
    return DEFAULT_THEME_CHOICE;
  }

  const bare = asThemeChoice(trimmed);
  if (bare !== null) {
    return bare;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return DEFAULT_THEME_CHOICE;
  }

  if (typeof parsed === "string") {
    return asThemeChoice(parsed.trim()) ?? DEFAULT_THEME_CHOICE;
  }
  if (isPlainObject(parsed)) {
    return asThemeChoice(parsed["theme"]) ?? DEFAULT_THEME_CHOICE;
  }
  return DEFAULT_THEME_CHOICE;
}

/**
 * Resolve a choice to a renderable theme. Explicit choices win outright;
 * "system" follows the shell-provided prefers-color-scheme signal.
 */
export function resolveTheme(
  choice: ThemeChoice,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (choice === "system") {
    return systemPrefersDark ? "dark" : "light";
  }
  return choice;
}
