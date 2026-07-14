/**
 * Theme state - the UI-side decisions layered on the @soc/core app-theme
 * module (porting-plan dark-mode note, lands with Unit 6.5).
 *
 * CORE owns the model (domain/app-theme): ThemeChoice/ResolvedTheme, the
 * tolerant '{"theme":"..."}' codec (parse defaults to "system"), and the
 * ONE resolveTheme rule over the shell-read prefers-color-scheme signal.
 * The stylesheet owns the colors (custom properties on :root with the
 * [data-theme='dark'] override). This module owns only what rendering
 * needs, kept out of the components so it is unit-testable without a DOM:
 *
 *   - {@link APP_THEME_KEY}: the persisted-entry key both shells use (the
 *     appMode persistence pattern), exported so the two cannot drift.
 *   - {@link THEME_LABELS}: the ONE display map shared by the frame's
 *     toggle and the Settings Appearance control.
 *   - {@link nextThemeChoice}: the toggle's cycle order.
 *   - {@link themeToggleText}: the toggle's visible text - always shows
 *     the RESOLVED theme when the choice is 'system'.
 *
 * Pure: no IO, no fetch, no React, no Date.
 */

import type { ResolvedTheme, ThemeChoice } from "@soc/core";

/**
 * The persisted-entry key both shells use (plain KV / host-secrets entry,
 * the appMode persistence pattern), exported so the two cannot drift.
 */
export const APP_THEME_KEY = "appTheme";

/** The one display label per choice (toggle + Settings share it). */
export const THEME_LABELS: Readonly<Record<ThemeChoice, string>> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

/** The toggle's cycle: light -> dark -> system -> light. */
export function nextThemeChoice(choice: ThemeChoice): ThemeChoice {
  switch (choice) {
    case "light":
      return "dark";
    case "dark":
      return "system";
    case "system":
      return "light";
  }
}

/**
 * The toggle's visible text: the chosen theme, plus the resolved theme in
 * parentheses when the choice is 'system' (the control must always show
 * what actually renders).
 */
export function themeToggleText(
  choice: ThemeChoice,
  resolved: ResolvedTheme,
): string {
  const base = `Theme: ${THEME_LABELS[choice]}`;
  return choice === "system" ? `${base} (${resolved})` : base;
}
