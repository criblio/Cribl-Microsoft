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
  groupOptions,
  kindLabel,
  sourceOptionValue,
} from "./sample-source-picker-state";

const GROUPS = { streamGroupIds: ["default"], ok: true };

/** The common "groups listed, a group chosen, load finished" situation. */
const loaded = (inventory: Parameters<typeof derivePickerView>[0]["inventory"]) =>
  derivePickerView({
    groups: GROUPS,
    inventory,
    selectedGroupId: "default",
    loadingGroups: false,
    loadingSources: false,
    enabled: true,
  });

const okBody = (items: unknown[]) => ({ status: 200, body: { items } });

const full = buildSampleSourceInventory({
  searchGroupId: "default_search",
  searchDatasets: okBody([{ id: "pfsense", description: "Firewall" }]),
  lakeDatasets: okBody([{ id: "lake_ds", metrics: { currentSizeBytes: 5_368_709_120 } }]),
  criblSources: [{ groupId: "default", section: okBody([{ id: "in_syslog", type: "syslog" }]) }],
});

describe("groupOptions", () => {
  it("offers every stream group, in leader order", () => {
    const many = { streamGroupIds: ["default", "grp2", "AzureManaged"], ok: true };
    expect(groupOptions(many).map((o) => o.value)).toEqual([
      "default",
      "grp2",
      "AzureManaged",
    ]);
  });

  it("is empty before the listing lands, so no dropdown is offered", () => {
    expect(groupOptions(null)).toEqual([]);
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

describe("sourceOptionValue + findEntry", () => {
  it("round-trips an entry through its option value", () => {
    const view = loaded(full);
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
    const view = loaded(clash);
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
  const at = (over: Partial<Parameters<typeof derivePickerView>[0]>) =>
    derivePickerView({
      groups: GROUPS,
      inventory: null,
      selectedGroupId: "",
      loadingGroups: false,
      loadingSources: false,
      enabled: true,
      ...over,
    });

  it("IDLE when not enabled - we have not looked, so we blame nothing", () => {
    const view = at({ groups: null, enabled: false });
    expect(view.status).toBe("idle");
    expect(view.headline).toContain("Connect Cribl");
    expect(view.headline).toContain("Uploading a file works either way");
    expect(view.options).toEqual([]);
  });

  it("LOADING while the GROUP listing is in flight", () => {
    expect(at({ groups: null, loadingGroups: true }).status).toBe("loading");
  });

  it("AWAITING-GROUP once groups are listed but none is chosen", () => {
    // The state the lazy load added, and the one most likely to be collapsed
    // into "empty". Nothing has been asked yet, so nothing may be claimed.
    const view = at({});
    expect(view.status).toBe("awaiting-group");
    expect(view.headline).toContain("Pick one of this workspace's 1 worker groups");
    expect(view.headline).toContain("Nothing is loaded until you do");
    expect(view.options).toEqual([]);
    // Crucially it does NOT say the workspace has nothing.
    expect(view.headline).not.toContain("no Search datasets");
  });

  it("AWAITING-GROUP with zero groups says so without blaming the operator", () => {
    const view = at({ groups: { streamGroupIds: [], ok: true } });
    expect(view.status).toBe("awaiting-group");
    expect(view.headline).toContain("No Stream worker group is visible");
    expect(view.headline).toContain("Upload a sample file instead");
  });

  it("LOADING again while the SELECTED group's sources are in flight", () => {
    const view = at({ selectedGroupId: "default", loadingSources: true });
    expect(view.status).toBe("loading");
    expect(view.headline).toContain('"default"');
  });

  it("EMPTY when the group listing itself failed", () => {
    const view = at({ groups: { streamGroupIds: [], ok: false } });
    expect(view.status).toBe("empty");
    expect(view.headline).toContain("Nothing could be listed from Cribl");
  });

  it("keeps showing results during a reload rather than flashing empty", () => {
    const view = derivePickerView({
      groups: GROUPS,
      inventory: full,
      selectedGroupId: "default",
      loadingGroups: true,
      loadingSources: false,
      enabled: true,
    });
    expect(view.status).toBe("ready");
  });

  it("READY names how many places, and labels every surface", () => {
    const view = loaded(full);
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
    expect(loaded(one).headline).toBe("1 place to take samples from.");
  });

  it("DEGRADED when a listing failed but others produced entries", () => {
    const partial = buildSampleSourceInventory({
      searchGroupId: "s",
      searchDatasets: { status: 403, body: "" },
      criblSources: [{ groupId: "g", section: okBody([{ id: "in_a" }]) }],
    });
    const view = loaded(partial);
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
    const view = loaded(allFailed);
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
    const view = loaded(genuinelyEmpty);
    expect(view.status).toBe("empty");
    // Names the GROUP that was checked, so "try another group" is actionable.
    expect(view.headline).toContain('Worker group "default" has no sources');
    expect(view.headline).toContain("Try another group, or upload");
    expect(view.headline).not.toContain("permission");
  });

  it("says nothing about surfaces still PENDING - that is not news", () => {
    // Before the datasets have been requested, listing "not listed yet" for
    // each one turns the panel into a wall of non-answers.
    const sourcesOnly = buildSampleSourceInventory({
      groupsListed: true,
      searchGroupId: "s",
      criblSources: [{ groupId: "default", section: okBody([{ id: "in_a" }]) }],
    });
    const view = loaded(sourcesOnly);
    expect(view.status).toBe("ready");
    expect(view.sectionNotes).toEqual([]);
  });

  it("stays SILENT about surfaces that worked and have entries", () => {
    const view = loaded(full);
    expect(view.sectionNotes).toEqual([]);
  });

  it("explains every surface that has nothing to show, and why", () => {
    const mixed = buildSampleSourceInventory({
      searchGroupId: "s",
      searchDatasets: okBody([]),
      lakeDatasets: { status: 404, body: "" },
      criblSources: [{ groupId: "g", section: okBody([{ id: "in_a" }]) }],
    });
    const view = loaded(mixed);
    const byKind = Object.fromEntries(view.sectionNotes.map((n) => [n.kind, n.text]));
    expect(byKind["search-dataset"]).toContain("none in this workspace");
    expect(byKind["lake-dataset"]).toContain("not enabled in this workspace");
    // The one that worked says nothing.
    expect(byKind["cribl-source"]).toBeUndefined();
  });
});
