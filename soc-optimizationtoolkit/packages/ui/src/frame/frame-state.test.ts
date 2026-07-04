import { describe, expect, it } from "vitest";
import { APP_MODES, parseAppMode } from "@soc/core";
import type { AcceptanceRecord } from "@soc/core";
import {
  AUA_SCROLL_SLACK_PX,
  DEFAULT_NAV_SECTION,
  EMPTY_MODE_RECORD,
  MODE_LABELS,
  MODE_OPTIONS,
  NAV_SECTION_LABELS,
  NAV_SECTION_ORDER,
  groupNavSections,
  isScrolledToBottom,
  resolveFramePhase,
} from "./frame-state";
import type { NavSection } from "./frame-state";

const ACCEPTED: AcceptanceRecord = { acceptedAt: "2026-07-03T00:00:00.000Z" };

describe("resolveFramePhase", () => {
  it("reports loading while acceptance is still loading, even with a known mode", () => {
    // The never-flash contract: an already-accepted user must not see the
    // gate while their persisted acceptance is in flight.
    expect(resolveFramePhase("loading", "full")).toEqual({ phase: "loading" });
    expect(resolveFramePhase("loading", null)).toEqual({ phase: "loading" });
    expect(resolveFramePhase("loading", "loading")).toEqual({
      phase: "loading",
    });
  });

  it("shows the acceptance gate before anything else once acceptance is known-absent", () => {
    expect(resolveFramePhase(null, "loading")).toEqual({ phase: "aua" });
    expect(resolveFramePhase(null, null)).toEqual({ phase: "aua" });
    expect(resolveFramePhase(null, "air-gapped")).toEqual({ phase: "aua" });
  });

  it("reports loading while the mode is still loading for an accepted user", () => {
    expect(resolveFramePhase(ACCEPTED, "loading")).toEqual({
      phase: "loading",
    });
  });

  it("routes an accepted user without a mode into mode selection", () => {
    expect(resolveFramePhase(ACCEPTED, null)).toEqual({
      phase: "mode-select",
    });
  });

  it("is ready with the narrowed mode once both are known", () => {
    for (const mode of APP_MODES) {
      expect(resolveFramePhase(ACCEPTED, mode)).toEqual({
        phase: "ready",
        mode,
      });
    }
  });
});

describe("EMPTY_MODE_RECORD (the Reconfigure contract)", () => {
  it("parses back to null, routing the next load into mode selection", () => {
    expect(parseAppMode(EMPTY_MODE_RECORD)).toBeNull();
  });

  it("is the legacy empty-object shape", () => {
    expect(JSON.parse(EMPTY_MODE_RECORD)).toEqual({});
  });
});

describe("MODE_OPTIONS", () => {
  it("covers every core mode exactly once, in APP_MODES order", () => {
    expect(MODE_OPTIONS.map((o) => o.mode)).toEqual([...APP_MODES]);
  });

  it("uses the shared MODE_LABELS so the chooser and the chip cannot drift", () => {
    for (const option of MODE_OPTIONS) {
      expect(option.label).toBe(MODE_LABELS[option.mode]);
    }
  });

  it("gives every option a non-empty single-line description", () => {
    for (const option of MODE_OPTIONS) {
      expect(option.description.trim()).not.toBe("");
      expect(option.description).not.toContain("\n");
    }
  });

  it("labels every mode (MODE_LABELS is total over APP_MODES)", () => {
    for (const mode of APP_MODES) {
      expect(MODE_LABELS[mode].trim()).not.toBe("");
    }
  });
});

describe("groupNavSections", () => {
  interface Item {
    id: string;
    section?: NavSection;
  }

  it("orders sections journey -> tools -> diagnostics regardless of input order", () => {
    const items: Item[] = [
      { id: "harness", section: "diagnostics" },
      { id: "options", section: "tools" },
      { id: "home", section: "journey" },
    ];
    expect(groupNavSections(items).map((g) => g.section)).toEqual([
      "journey",
      "tools",
      "diagnostics",
    ]);
  });

  it("defaults undeclared routes to the tools section", () => {
    expect(DEFAULT_NAV_SECTION).toBe("tools");
    const groups = groupNavSections<Item>([{ id: "settings" }]);
    expect(groups).toEqual([
      { section: "tools", items: [{ id: "settings" }] },
    ]);
  });

  it("keeps route-table order within each section", () => {
    const items: Item[] = [
      { id: "home", section: "journey" },
      { id: "options" },
      { id: "azure-target", section: "journey" },
      { id: "logs" },
      { id: "onboard", section: "journey" },
    ];
    const groups = groupNavSections(items);
    expect(groups[0]?.items.map((i) => i.id)).toEqual([
      "home",
      "azure-target",
      "onboard",
    ]);
    expect(groups[1]?.items.map((i) => i.id)).toEqual(["options", "logs"]);
  });

  it("omits empty sections and never re-filters items", () => {
    const groups = groupNavSections<Item>([{ id: "home", section: "journey" }]);
    expect(groups).toEqual([
      { section: "journey", items: [{ id: "home", section: "journey" }] },
    ]);
    expect(groupNavSections<Item>([])).toEqual([]);
  });

  it("labels every section (NAV_SECTION_LABELS is total over the order)", () => {
    for (const section of NAV_SECTION_ORDER) {
      expect(NAV_SECTION_LABELS[section].trim()).not.toBe("");
    }
  });
});

describe("isScrolledToBottom", () => {
  it("is true exactly at the bottom", () => {
    // scrollHeight 1000, clientHeight 400 -> max scrollTop 600.
    expect(isScrolledToBottom(600, 400, 1000)).toBe(true);
  });

  it("is true within the slack of the bottom", () => {
    expect(isScrolledToBottom(600 - (AUA_SCROLL_SLACK_PX - 1), 400, 1000)).toBe(
      true,
    );
  });

  it("is false above the slack threshold", () => {
    expect(isScrolledToBottom(600 - AUA_SCROLL_SLACK_PX, 400, 1000)).toBe(
      false,
    );
    expect(isScrolledToBottom(0, 400, 1000)).toBe(false);
  });

  it("is true for content that does not scroll at all", () => {
    // The legacy soft-lock: without a scrollbar no scroll event ever fires,
    // so the gate must count unscrollable content as already reviewed.
    expect(isScrolledToBottom(0, 400, 400)).toBe(true);
    expect(isScrolledToBottom(0, 400, 200)).toBe(true);
  });
});
