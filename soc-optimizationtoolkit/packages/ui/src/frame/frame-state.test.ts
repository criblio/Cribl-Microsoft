import { describe, expect, it } from "vitest";
import { APP_MODES, parseAppMode } from "@soc/core";
import type { AcceptanceRecord } from "@soc/core";
import {
  AUA_SCROLL_SLACK_PX,
  EMPTY_MODE_RECORD,
  MODE_LABELS,
  MODE_OPTIONS,
  isScrolledToBottom,
  resolveFramePhase,
} from "./frame-state";

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
