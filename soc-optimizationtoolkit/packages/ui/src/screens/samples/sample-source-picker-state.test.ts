/**
 * Pins for the sample-source picker's pure decisions (plan Phase 3, ADR 0003).
 *
 * The states this must keep apart, because several look identical if you only
 * count entries, and each sends the operator somewhere different:
 *   no connection / no mode chosen / no group chosen (capture) /
 *   chosen-and-empty / chosen-and-failed / chosen-and-found.
 */

import { describe, expect, it } from "vitest";
import { buildSampleSourceInventory } from "@soc/core";
import {
  MODE_CHOICES,
  derivePickerView,
  findEntry,
  formatBytes,
  groupOptions,
  kindLabel,
  sectionNote,
  sourceOptionValue,
} from "./sample-source-picker-state";

const okBody = (items: unknown[]) => ({ status: 200, body: { items } });

const GROUPS = { streamGroupIds: ["default", "grp2"], searchGroupId: "s", ok: true };

const lakeInv = buildSampleSourceInventory({
  lakeDatasets: okBody([
    { id: "cribl_logs", retentionPeriodInDays: 30, metrics: { currentSizeBytes: 5_368_709_120 } },
    { id: "Corelight", description: "Zeek" },
  ]),
});
const sourceInv = buildSampleSourceInventory({
  criblSources: [{ groupId: "default", section: okBody([{ id: "in_syslog", type: "syslog" }]) }],
});

const at = (over: Partial<Parameters<typeof derivePickerView>[0]>) =>
  derivePickerView({
    groups: GROUPS,
    inventory: null,
    mode: null,
    selectedGroupId: "",
    loadingGroups: false,
    loadingSources: false,
    enabled: true,
    ...over,
  });

describe("MODE_CHOICES", () => {
  it("offers exactly the two modes, each saying what it costs", () => {
    expect(MODE_CHOICES.map((c) => c.mode)).toEqual(["lake-query", "live-capture"]);
    // Lake's limit is needing Search; capture's is only seeing what flows.
    expect(MODE_CHOICES[0].detail).toContain("Search group");
    expect(MODE_CHOICES[1].detail).toContain("only sees what flows");
  });
});

describe("formatBytes", () => {
  it("uses the shortest honest unit", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(5_368_709_120)).toBe("5 GB");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("returns empty rather than NaN for nonsense", () => {
    expect(formatBytes(Number.NaN)).toBe("");
    expect(formatBytes(-1)).toBe("");
  });
});

describe("groupOptions", () => {
  it("offers every stream group, in leader order", () => {
    expect(groupOptions(GROUPS).map((o) => o.value)).toEqual(["default", "grp2"]);
  });

  it("is empty before the listing lands, so no dropdown is offered", () => {
    expect(groupOptions(null)).toEqual([]);
  });
});

describe("options are the CHOSEN mode's surface only", () => {
  it("lists Lake datasets in lake mode, with size and retention", () => {
    const view = at({ mode: "lake-query", inventory: lakeInv });
    expect(view.options.map((o) => o.label)).toEqual(["Corelight", "cribl_logs"]);
    const criblLogs = view.options.find((o) => o.label === "cribl_logs");
    expect(criblLogs?.hint).toContain("5 GB");
    expect(criblLogs?.hint).toContain("30d retention");
  });

  it("lists sources in capture mode, with the group", () => {
    const view = at({
      mode: "live-capture",
      selectedGroupId: "default",
      inventory: sourceInv,
    });
    expect(view.options.map((o) => o.label)).toEqual(["in_syslog"]);
    expect(view.options[0].hint).toContain("group default");
  });

  it("never leaks the other mode's surface into the options", () => {
    // Both surfaces populated; only the chosen one may appear.
    const both = buildSampleSourceInventory({
      lakeDatasets: okBody([{ id: "lake1" }]),
      criblSources: [{ groupId: "g", section: okBody([{ id: "in_a" }]) }],
    });
    expect(at({ mode: "lake-query", inventory: both }).options.map((o) => o.label)).toEqual([
      "lake1",
    ]);
    expect(
      at({ mode: "live-capture", selectedGroupId: "g", inventory: both }).options.map(
        (o) => o.label,
      ),
    ).toEqual(["in_a"]);
  });

  it("round-trips an entry through its option value", () => {
    const view = at({ mode: "lake-query", inventory: lakeInv });
    for (const option of view.options) {
      const entry = findEntry(lakeInv, option.value);
      expect(entry).not.toBeNull();
      expect(sourceOptionValue(entry!)).toBe(option.value);
    }
  });

  it("returns null for an unknown or empty value", () => {
    expect(findEntry(lakeInv, "")).toBeNull();
    expect(findEntry(lakeInv, "lake-dataset::nope")).toBeNull();
    expect(findEntry(null, "anything")).toBeNull();
  });
});

describe("derivePickerView - the states", () => {
  it("IDLE when not enabled - and names CRIBL as the missing connection", () => {
    // DBT-53. The old copy read "Connect Cribl to pull samples from a Lake
    // dataset or a live source", and the Integrate screen reached it whenever no
    // AZURE subscription had been committed - so it blamed the one system that
    // was working, and asked for an action that does not exist inside a
    // Cribl.Cloud workspace. Restoring that sentence kills this pin.
    const view = at({ groups: null, enabled: false });
    expect(view.status).toBe("idle");
    expect(view.headline).toContain("Cribl is not reachable");
    expect(view.headline).not.toMatch(/Connect Cribl/i);
    // It must not read as a fact about their workspace either - we did not look.
    expect(view.headline).toContain("that is our connection, not your workspace");
    // Every dead end still ends with the path that needs no Cribl access - the
    // wording sample-source-picker.dom.test.tsx pins across all of them.
    expect(view.headline).toContain("Uploading a file works either way");
  });

  it("LOADING while the group listing is in flight", () => {
    expect(at({ groups: null, loadingGroups: true }).status).toBe("loading");
  });

  it("EMPTY when the group listing itself failed", () => {
    const view = at({ groups: { streamGroupIds: [], ok: false } });
    expect(view.status).toBe("empty");
    expect(view.headline).toContain("Nothing could be listed from Cribl");
  });

  it("AWAITING-MODE once the workspace is reachable but no mode is chosen", () => {
    const view = at({});
    expect(view.status).toBe("awaiting-mode");
    expect(view.headline).toContain("Nothing is loaded until you pick one");
    expect(view.options).toEqual([]);
    // No claim about either surface has been made.
    expect(view.headline).not.toContain("no Lake datasets");
    expect(view.showGroupPicker).toBe(false);
  });

  it("lake mode shows NO group picker - it is a leader route", () => {
    const view = at({ mode: "lake-query", inventory: lakeInv });
    expect(view.showGroupPicker).toBe(false);
    expect(view.status).toBe("ready");
    expect(view.headline).toBe("2 Lake datasets to choose from.");
  });

  it("capture mode asks for a group FIRST, and shows its picker", () => {
    const view = at({ mode: "live-capture" });
    expect(view.status).toBe("awaiting-group");
    expect(view.showGroupPicker).toBe(true);
    expect(view.headline).toContain("Pick one of this workspace's 2 worker groups");
  });

  it("capture mode with zero groups points at the other mode", () => {
    const view = at({ mode: "live-capture", groups: { streamGroupIds: [], ok: true } });
    expect(view.status).toBe("awaiting-group");
    expect(view.headline).toContain("Query a Lake dataset instead");
    expect(view.showGroupPicker).toBe(false);
  });

  it("LOADING names which surface it is reading", () => {
    expect(at({ mode: "lake-query", loadingSources: true }).headline).toContain(
      "Lake datasets",
    );
    expect(
      at({ mode: "live-capture", selectedGroupId: "default", loadingSources: true }).headline,
    ).toContain('"default"');
  });

  it("uses the singular for one entry", () => {
    const one = buildSampleSourceInventory({ lakeDatasets: okBody([{ id: "only" }]) });
    expect(at({ mode: "lake-query", inventory: one }).headline).toBe(
      "1 Lake dataset to choose from.",
    );
  });

  it("EMPTY-after-failure reads as a permission problem, not an empty workspace", () => {
    const failed = buildSampleSourceInventory({ lakeDatasets: { status: 403, body: "" } });
    const view = at({ mode: "lake-query", inventory: failed });
    expect(view.status).toBe("empty");
    expect(view.headline).toContain("may be a permission problem rather than an empty workspace");
  });

  it("EMPTY-with-no-failures states it as a fact, and offers the other mode", () => {
    const none = buildSampleSourceInventory({ lakeDatasets: okBody([]) });
    const view = at({ mode: "lake-query", inventory: none });
    expect(view.status).toBe("empty");
    expect(view.headline).toContain("no Cribl Lake datasets");
    expect(view.headline).toContain("Capture from a live source instead");
    expect(view.headline).not.toContain("permission");
  });

  it("EMPTY in capture mode names the group that was checked", () => {
    const none = buildSampleSourceInventory({
      criblSources: [{ groupId: "default", section: okBody([]) }],
    });
    const view = at({ mode: "live-capture", selectedGroupId: "default", inventory: none });
    expect(view.headline).toContain('Worker group "default" has no sources');
    expect(view.headline).toContain("Try another group");
  });
});

describe("the Search-group warning", () => {
  it("warns in LAKE mode when the workspace has no Search group", () => {
    // A Lake dataset is queried THROUGH Search. Saying so here beats letting
    // the operator pick a dataset and hit a wall in Phase 4.
    const view = at({
      mode: "lake-query",
      inventory: lakeInv,
      groups: { streamGroupIds: ["default"], ok: true },
    });
    expect(view.modeWarning).toContain("no Cribl Search group");
    // NOT a gate: the datasets still list.
    expect(view.options).toHaveLength(2);
    expect(view.status).toBe("ready");
  });

  it("does not warn when a Search group exists", () => {
    expect(at({ mode: "lake-query", inventory: lakeInv }).modeWarning).toBeNull();
  });

  it("never warns in CAPTURE mode - capture does not use Search", () => {
    const view = at({
      mode: "live-capture",
      selectedGroupId: "default",
      inventory: sourceInv,
      groups: { streamGroupIds: ["default"], ok: true },
    });
    expect(view.modeWarning).toBeNull();
  });
});

describe("sectionNote", () => {
  it("describes only the CHOSEN mode's surface", () => {
    const both = buildSampleSourceInventory({
      lakeDatasets: { status: 403, body: "" },
      criblSources: [{ groupId: "g", section: okBody([{ id: "in_a" }]) }],
    });
    expect(sectionNote(both, "lake-query")).toContain("403");
    // The chosen surface worked, so nothing is said about the failed other one.
    expect(sectionNote(both, "live-capture")).toBeNull();
  });

  it("says nothing for a PENDING surface - that is not news", () => {
    const lakeOnly = buildSampleSourceInventory({ lakeDatasets: okBody([{ id: "a" }]) });
    expect(sectionNote(lakeOnly, "live-capture")).toBeNull();
  });

  it("says nothing at all before a mode is chosen", () => {
    expect(sectionNote(lakeInv, null)).toBeNull();
  });

  it("names an empty-but-successful surface", () => {
    const none = buildSampleSourceInventory({ lakeDatasets: okBody([]) });
    expect(sectionNote(none, "lake-query")).toContain("none in this workspace");
  });
});

describe("kindLabel", () => {
  it("names both surfaces", () => {
    expect(kindLabel("lake-dataset")).toBe("Lake dataset");
    expect(kindLabel("cribl-source")).toBe("Cribl source");
  });
});
