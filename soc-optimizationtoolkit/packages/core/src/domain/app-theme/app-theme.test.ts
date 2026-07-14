/**
 * Contract tests for the app-theme module:
 *   - tolerant parsing (bare string, JSON string literal, {"theme":...}
 *     wrapper; everything unrecognized -> "system", never null, never throw)
 *   - serialize/parse round-trips
 *   - the full resolution matrix (3 choices x systemPrefersDark)
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME_CHOICE,
  THEME_CHOICES,
  parseThemeChoice,
  resolveTheme,
  serializeThemeChoice,
} from "./index";

describe("parseThemeChoice", () => {
  it("parses each valid bare choice string", () => {
    for (const choice of THEME_CHOICES) {
      expect(parseThemeChoice(choice)).toBe(choice);
    }
  });

  it("ignores surrounding whitespace on a bare choice string", () => {
    expect(parseThemeChoice("  dark\n")).toBe("dark");
  });

  it("parses a JSON string literal", () => {
    expect(parseThemeChoice('"light"')).toBe("light");
  });

  it("parses the {\"theme\":...} wrapper shape", () => {
    expect(parseThemeChoice('{"theme":"dark"}')).toBe("dark");
  });

  it("drops extra keys on the wrapper shape", () => {
    expect(parseThemeChoice('{"theme":"light","stale":true}')).toBe("light");
  });

  it("defaults to system for null, undefined, and empty input", () => {
    expect(parseThemeChoice(null)).toBe("system");
    expect(parseThemeChoice(undefined)).toBe("system");
    expect(parseThemeChoice("")).toBe("system");
    expect(parseThemeChoice("   ")).toBe("system");
  });

  it("defaults to system for unknown names in every accepted shape", () => {
    expect(parseThemeChoice("midnight")).toBe("system");
    expect(parseThemeChoice('"midnight"')).toBe("system");
    expect(parseThemeChoice('{"theme":"midnight"}')).toBe("system");
  });

  it("defaults to system for malformed JSON and wrong-typed payloads", () => {
    expect(parseThemeChoice("{not json")).toBe("system");
    expect(parseThemeChoice("42")).toBe("system");
    expect(parseThemeChoice("true")).toBe("system");
    expect(parseThemeChoice('["dark"]')).toBe("system");
    expect(parseThemeChoice('{"theme":42}')).toBe("system");
    expect(parseThemeChoice('{"theme":null}')).toBe("system");
    expect(parseThemeChoice("{}")).toBe("system");
  });

  it("is case-sensitive (choice names are exact tokens)", () => {
    expect(parseThemeChoice("Dark")).toBe("system");
    expect(parseThemeChoice("LIGHT")).toBe("system");
  });

  it("exposes the default as a named constant", () => {
    expect(DEFAULT_THEME_CHOICE).toBe("system");
  });
});

describe("serializeThemeChoice", () => {
  it("round-trips every choice through parseThemeChoice", () => {
    for (const choice of THEME_CHOICES) {
      expect(parseThemeChoice(serializeThemeChoice(choice))).toBe(choice);
    }
  });

  it("emits the wrapper object shape", () => {
    expect(JSON.parse(serializeThemeChoice("dark"))).toEqual({
      theme: "dark",
    });
  });
});

describe("resolveTheme", () => {
  it("resolves the full choice x system-preference matrix", () => {
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
  });
});
