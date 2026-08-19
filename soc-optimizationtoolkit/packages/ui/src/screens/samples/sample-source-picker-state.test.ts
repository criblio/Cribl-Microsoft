/**
 * Pins for the sample-source picker's pure decisions (plan Phase 3, ADR 0003).
 *
 * The four states this must keep apart - because three of them look identical
 * if you only count entries, and each sends the operator somewhere different:
 *   not looked yet / looked-and-found-nothing / looked-and-the-read-failed /
 *   looked-and-found-things.
 */

import { describe, expect, it } from "vitest";
import { buildSampleSourceInventory } from "@soc/core";
import {
  derivePickerView,
  findEntry,
  formatBytes,
  kindLabel,
  sourceOptionValue,
} from "./sample-source-picker-state";

const okBody = (items: unknown[]) => ({ status: 200, body: { items } });

const full = buildSampleSourceInventory({
  searchGroupId: "default_search",
  searchDatasets: okBody([{ id: "pfsense", description: "Firewall" }]),
  lakeDatasets: okBody([{ id: "lake_ds", metrics: { currentSizeBytes: 5_368_709_120 } }]),
  criblSources: [{ groupId: "default", section: okBody([{ id: "in_syslog", type: "syslog" }]) }],
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

describe("sourceOptionValue + findEntry", () => {
  it("round-trips an entry through its option value", () => {
    const view = derivePickerView(full, false, true);
    for (const option of view.options) {
      const entry = findEntry(full, option.value);
      expect(entry).not.toBeNull();
      expect(sourceOptionValue(entry!)).toBe(option.value);
    }
  });

  it("distinguishes same-named entries on DIFFERENT surfaces", () => {
    // A Lake dataset and a Search dataset can share a name; the id must not
    // collapse them or picking one would silently select the other.
    const clash = buildSampleSourceInventory({
      searchGroupId: "s",
      searchDatasets: okBody([{ id: "shared" }]),
      lakeDatasets: okBody([{ id: "shared" }]),
    });
    const view = derivePickerView(clash, false, true);
    expect(view.options).toHaveLength(2);
    expect(new Set(view.options.map((o) => o.value)).size).toBe(2);
    expect(findEntry(clash, view.options[0].value)?.kind).toBe("search-dataset");
    expect(findEntry(clash, view.options[1].value)?.kind).toBe("lake-dataset");
  });

  it("returns null for an unknown or empty value", () => {
    expect(findEntry(full, "")).toBeNull();
    expect(findEntry(full, "search-dataset::nope")).toBeNull();
    expect(findEntry(null, "anything")).toBeNull();
  });
});

describe("derivePickerView", () => {
  it("IDLE when not enabled - we have not looked, so we blame nothing", () => {
    const view = derivePickerView(null, false, false);
    expect(view.status).toBe("idle");
    expect(view.headline).toContain("Connect Cribl");
    expect(view.headline).toContain("Uploading a file works either way");
    expect(view.options).toEqual([]);
  });

  it("LOADING only before the first result, never after", () => {
    expect(derivePickerView(null, true, true).status).toBe("loading");
    // A reload with an inventory already in hand keeps showing it.
    expect(derivePickerView(full, true, true).status).toBe("ready");
  });

  it("READY names how many places, and labels every surface", () => {
    const view = derivePickerView(full, false, true);
    expect(view.status).toBe("ready");
    expect(view.headline).toBe("3 places to take samples from.");
    expect(view.options.map((o) => o.label)).toEqual(["pfsense", "lake_ds", "in_syslog"]);
    expect(view.options[0].hint).toContain(kindLabel("search-dataset"));
    expect(view.options[1].hint).toContain("5 GB");
    expect(view.options[2].hint).toContain("group default");
  });

  it("uses the singular for one place", () => {
    const one = buildSampleSourceInventory({
      criblSources: [{ groupId: "g", section: okBody([{ id: "only" }]) }],
    });
    expect(derivePickerView(one, false, true).headline).toBe("1 place to take samples from.");
  });

  it("DEGRADED when a listing failed but others produced entries", () => {
    const partial = buildSampleSourceInventory({
      searchGroupId: "s",
      searchDatasets: { status: 403, body: "" },
      criblSources: [{ groupId: "g", section: okBody([{ id: "in_a" }]) }],
    });
    const view = derivePickerView(partial, false, true);
    expect(view.status).toBe("degraded");
    // The honest bit: it does not claim the list is complete.
    expect(view.headline).toContain("there may be more");
    expect(view.options).toHaveLength(1);
  });

  it("EMPTY-after-failure reads as a permission problem, not an empty workspace", () => {
    const allFailed = buildSampleSourceInventory({
      searchGroupId: "s",
      searchDatasets: { status: 403, body: "" },
      lakeDatasets: { status: 403, body: "" },
      criblSources: [{ groupId: "g", section: { status: 403, body: "" } }],
    });
    const view = derivePickerView(allFailed, false, true);
    expect(view.status).toBe("empty");
    expect(view.headline).toContain("permission problem rather than an empty workspace");
  });

  it("EMPTY-with-no-failures states it as a fact about the workspace", () => {
    const genuinelyEmpty = buildSampleSourceInventory({
      searchGroupId: "s",
      searchDatasets: okBody([]),
      lakeDatasets: okBody([]),
      criblSources: [{ groupId: "g", section: okBody([]) }],
    });
    const view = derivePickerView(genuinelyEmpty, false, true);
    expect(view.status).toBe("empty");
    expect(view.headline).toContain("has no Search datasets, Lake datasets or sources");
    expect(view.headline).not.toContain("permission");
  });

  it("stays SILENT about surfaces that worked and have entries", () => {
    const view = derivePickerView(full, false, true);
    expect(view.sectionNotes).toEqual([]);
  });

  it("explains every surface that has nothing to show, and why", () => {
    const mixed = buildSampleSourceInventory({
      searchGroupId: "s",
      searchDatasets: okBody([]),
      lakeDatasets: { status: 404, body: "" },
      criblSources: [{ groupId: "g", section: okBody([{ id: "in_a" }]) }],
    });
    const view = derivePickerView(mixed, false, true);
    const byKind = Object.fromEntries(view.sectionNotes.map((n) => [n.kind, n.text]));
    expect(byKind["search-dataset"]).toContain("none in this workspace");
    expect(byKind["lake-dataset"]).toContain("not enabled in this workspace");
    // The one that worked says nothing.
    expect(byKind["cribl-source"]).toBeUndefined();
  });
});
