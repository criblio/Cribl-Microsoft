/**
 * ThemeToggle - the frame topBar's theme control: one small button cycling
 * light -> dark -> system, always showing the RESOLVED theme (so 'system'
 * never hides what actually renders). The shell owns everything stateful:
 * the persisted choice, the prefers-color-scheme reading, and the resolve -
 * this component only displays the pair and reports the next choice.
 *
 * The same {@link ThemeControl} bag plumbs the Settings screen's theme
 * select, so the two controls can never disagree about the model.
 */

import type { ResolvedTheme, ThemeChoice } from "@soc/core";
import {
  THEME_LABELS,
  nextThemeChoice,
  themeToggleText,
} from "./theme-state";

/** The shell-provided theme wiring (frame topBar + Settings share it). */
export interface ThemeControl {
  /** The user's current choice (light | dark | system). */
  theme: ThemeChoice;
  /** What actually renders after resolving 'system' (shell-resolved). */
  resolvedTheme: ResolvedTheme;
  /** Adopt and persist a new choice. The shell owns storage. */
  onThemeChange: (choice: ThemeChoice) => void | Promise<void>;
}

export type ThemeToggleProps = ThemeControl;

export function ThemeToggle({
  theme,
  resolvedTheme,
  onThemeChange,
}: ThemeToggleProps) {
  const next = nextThemeChoice(theme);
  return (
    <button
      className="theme-toggle"
      title={`Cycle the color theme (next: ${THEME_LABELS[next]}). System follows the operating system's color-scheme preference, not the host UI's own theme setting.`}
      onClick={() => void onThemeChange(next)}
    >
      {themeToggleText(theme, resolvedTheme)}
    </button>
  );
}
