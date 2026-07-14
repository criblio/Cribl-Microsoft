/**
 * Tests for the UI-side theme decisions (Unit 6.5). The codec and the
 * resolveTheme rule are pinned in @soc/core's app-theme tests; these pin
 * the layer on top: the shared storage key, the total label map, the
 * toggle's cycle, and the always-show-resolved toggle text.
 */
import { describe, expect, it } from "vitest";
import { THEME_CHOICES } from "@soc/core";
import type { ThemeChoice } from "@soc/core";
import {
  APP_THEME_KEY,
  THEME_LABELS,
  nextThemeChoice,
  themeToggleText,
} from "./theme-state";

describe("APP_THEME_KEY", () => {
  it("is the appTheme entry both shells persist under (the plan's key)", () => {
    expect(APP_THEME_KEY).toBe("appTheme");
  });
});

describe("nextThemeChoice", () => {
  it("cycles light -> dark -> system -> light", () => {
    expect(nextThemeChoice("light")).toBe("dark");
    expect(nextThemeChoice("dark")).toBe("system");
    expect(nextThemeChoice("system")).toBe("light");
  });

  it("visits every core choice exactly once per cycle", () => {
    const seen = new Set<ThemeChoice>();
    let current: ThemeChoice = "light";
    for (let i = 0; i < THEME_CHOICES.length; i++) {
      seen.add(current);
      current = nextThemeChoice(current);
    }
    expect(current).toBe("light");
    expect(seen.size).toBe(THEME_CHOICES.length);
  });
});

describe("labels and toggle text", () => {
  it("labels every core choice (THEME_LABELS is total over THEME_CHOICES)", () => {
    for (const choice of THEME_CHOICES) {
      expect(THEME_LABELS[choice].trim()).not.toBe("");
    }
  });

  it("shows the resolved theme only for the system choice", () => {
    expect(themeToggleText("system", "dark")).toBe("Theme: System (dark)");
    expect(themeToggleText("system", "light")).toBe("Theme: System (light)");
    expect(themeToggleText("dark", "dark")).toBe("Theme: Dark");
    expect(themeToggleText("light", "light")).toBe("Theme: Light");
  });
});
