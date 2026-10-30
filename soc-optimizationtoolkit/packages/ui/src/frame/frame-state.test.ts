import { describe, expect, it } from "vitest";
import type { AcceptanceRecord } from "@soc/core";
import {
  AUA_SCROLL_SLACK_PX,
  DEFAULT_NAV_SECTION,
  NAV_SECTION_LABELS,
  NAV_SECTION_ORDER,
  groupNavSections,
  isScrolledToBottom,
  loadableSetupFromRead,
  resolveFramePhase,
} from "./frame-state";
import type { NavSection } from "./frame-state";
import { ROUTE_CAPABILITIES, capabilitiesForRoute } from "./route-capabilities";

const ACCEPTED: AcceptanceRecord = { acceptedAt: "2026-07-03T00:00:00.000Z" };

describe("resolveFramePhase", () => {
  // The phase order is UNCHANGED by capability-model-plan step 5; only its
  // fourth step is renamed. "mode-select" became "setup" (the first-run wizard),
  // and "ready" no longer carries a mode because the frame no longer has one.
  it("reports loading while acceptance is still loading, whatever setup says", () => {
    // The never-flash contract: an already-accepted user must not see the gate
    // while their persisted acceptance is in flight.
    expect(resolveFramePhase("loading", true)).toEqual({ phase: "loading" });
    expect(resolveFramePhase("loading", null)).toEqual({ phase: "loading" });
    expect(resolveFramePhase("loading", "loading")).toEqual({ phase: "loading" });
  });

  it("shows the acceptance gate before anything else once acceptance is known-absent", () => {
    expect(resolveFramePhase(null, "loading")).toEqual({ phase: "aua" });
    expect(resolveFramePhase(null, null)).toEqual({ phase: "aua" });
    expect(resolveFramePhase(null, true)).toEqual({ phase: "aua" });
  });

  it("reports loading while setup state is still loading for an accepted user", () => {
    expect(resolveFramePhase(ACCEPTED, "loading")).toEqual({ phase: "loading" });
  });

  it("routes an accepted user who has not finished setup into the wizard", () => {
    expect(resolveFramePhase(ACCEPTED, null)).toEqual({ phase: "setup" });
    expect(resolveFramePhase(ACCEPTED, false)).toEqual({ phase: "setup" });
  });

  it("never routes an unreadable setup record into the wizard (DBT-145)", () => {
    // A rejected read is not "not set up": the setup flow for a finished
    // install is the defect this state exists to prevent.
    expect(resolveFramePhase(ACCEPTED, "unreadable")).toEqual({ phase: "setup-unreadable" });
    // The acceptance gate still comes first.
    expect(resolveFramePhase(null, "unreadable")).toEqual({ phase: "aua" });
  });

  it("is ready once accepted and set up, carrying nothing else", () => {
    expect(resolveFramePhase(ACCEPTED, true)).toEqual({ phase: "ready" });
  });
});

describe("loadableSetupFromRead", () => {
  it("reports a rejected read as unreadable, not as not-set-up (DBT-145)", () => {
    expect(
      loadableSetupFromRead({ status: "rejected", reason: new Error("KV get setupComplete failed: 502") }),
    ).toBe("unreadable");
  });

  it("parses a fulfilled read: a record is set up, null or empty is not", () => {
    expect(
      loadableSetupFromRead({ status: "fulfilled", value: JSON.stringify({ completedAt: "2026-07-03T00:00:00.000Z" }) }),
    ).toBe(true);
    expect(loadableSetupFromRead({ status: "fulfilled", value: null })).toBe(false);
    expect(loadableSetupFromRead({ status: "fulfilled", value: "" })).toBe(false);
  });
});

// The EMPTY_MODE_RECORD and MODE_OPTIONS blocks lived here. The Reconfigure
// contract they pinned survives as EMPTY_SETUP_RECORD in core (pinned in
// domain/app-setup); the chooser list has no successor, because what an
// operator can do is MEASURED by the capability audit rather than chosen.

describe("groupNavSections", () => {
  interface Item {
    id: string;
    section?: NavSection;
  }

  it("orders sections journey -> tools -> development -> diagnostics regardless of input order", () => {
    const items: Item[] = [
      { id: "harness", section: "diagnostics" },
      { id: "dcr-automation", section: "development" },
      { id: "options", section: "tools" },
      { id: "home", section: "journey" },
    ];
    expect(groupNavSections(items).map((g) => g.section)).toEqual([
      "journey",
      "tools",
      "development",
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
      { id: "dcr-automation", section: "journey" },
    ];
    const groups = groupNavSections(items);
    expect(groups[0]?.items.map((i) => i.id)).toEqual([
      "home",
      "azure-target",
      "dcr-automation",
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

describe("azure-logging-map route capability", () => {
  // capabilitiesForRoute falls back to [] for an UNKNOWN id, so asserting the
  // [] alone would pass even if the entry were never added. hasOwn pins that
  // the route's empty requirement is a recorded decision (the taxonomy gap),
  // not the silent fallback.
  it("is an explicit, empty entry rather than the unknown-id fallback", () => {
    expect(Object.hasOwn(ROUTE_CAPABILITIES, "azure-logging-map")).toBe(true);
    expect(capabilitiesForRoute("azure-logging-map")).toEqual([]);
  });
});
