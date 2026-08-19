// @vitest-environment happy-dom
/**
 * DOM pins for the sample-source picker (plan Phase 3, ADR 0003).
 *
 * The state module beside this covers what the picker DECIDES. These cover what
 * it SHOWS - the class of defect a state test structurally cannot see: a second
 * dropdown offered before a group is chosen, a retry that never renders, a
 * disabled source selected with no warning. The table-picker removal is the
 * cautionary tale: fourteen thoroughly-tested pure decisions behind a panel that
 * had quietly lost its job.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { buildSampleSourceInventory } from "@soc/core";
import { SampleSourcePicker } from "./sample-source-picker";

afterEach(cleanup);

const okBody = (items: unknown[]) => ({ status: 200, body: { items } });

const GROUPS = { streamGroupIds: ["default", "grp2"], notes: [], ok: true };

const full = buildSampleSourceInventory({
  groupsListed: true,
  searchGroupId: "default_search",
  searchDatasets: okBody([{ id: "pfsense", description: "Firewall" }]),
  criblSources: [
    { groupId: "default", section: okBody([{ id: "in_syslog", type: "syslog" }]) },
  ],
});

function renderPicker(over: Partial<Parameters<typeof SampleSourcePicker>[0]> = {}) {
  const props = {
    groups: GROUPS,
    inventory: full,
    selectedGroupId: "default",
    notes: [] as readonly string[],
    loadingGroups: false,
    loadingSources: false,
    enabled: true,
    value: "",
    onSelectGroup: vi.fn(),
    onChange: vi.fn(),
    onReload: vi.fn(),
    ...over,
  };
  return { ...render(<SampleSourcePicker {...props} />), props };
}

/** Every combobox on the panel, in DOM order. */
const combos = (container: HTMLElement) => container.querySelectorAll("input");

describe("SampleSourcePicker - the two stages", () => {
  it("offers ONLY the worker-group dropdown before a group is chosen", () => {
    // The whole point of the lazy load: nothing about sources is shown, or
    // fetched, until the operator says which group they mean.
    const { container } = renderPicker({ selectedGroupId: "", inventory: null });
    expect(container.querySelector(".sample-source-picker")?.getAttribute("data-status")).toBe(
      "awaiting-group",
    );
    expect(combos(container)).toHaveLength(1);
    expect(screen.getByText("Worker group")).toBeTruthy();
    expect(screen.queryByText("Dataset or source")).toBeNull();
  });

  it("offers BOTH dropdowns once a group's listing is in", () => {
    const { container } = renderPicker();
    expect(combos(container)).toHaveLength(2);
    expect(screen.getByText("Worker group")).toBeTruthy();
    expect(screen.getByText("Dataset or source")).toBeTruthy();
  });

  it("reports the chosen group upward", () => {
    const { container, props } = renderPicker({ selectedGroupId: "", inventory: null });
    // The combobox renders its options only while the popover is open, which
    // the control button toggles (see searchable-select.dom.test).
    const control = container.querySelector(".searchable-select-control");
    expect(control).toBeTruthy();
    fireEvent.click(control!);
    const option = [...container.querySelectorAll(".searchable-select-option")].find((o) =>
      o.textContent?.includes("grp2"),
    );
    expect(option).toBeTruthy();
    fireEvent.click(option!);
    expect(props.onSelectGroup).toHaveBeenCalledWith("grp2");
  });

  it("shows no dropdown at all before the group listing lands", () => {
    const { container } = renderPicker({
      groups: null,
      inventory: null,
      selectedGroupId: "",
      loadingGroups: true,
    });
    expect(combos(container)).toHaveLength(0);
    expect(container.querySelector(".sample-source-picker")?.getAttribute("data-status")).toBe(
      "loading",
    );
  });

  it("keeps the group dropdown while its sources load, but disables it", () => {
    // Leaving it enabled invites a second selection that races the first.
    const { container } = renderPicker({
      selectedGroupId: "default",
      inventory: null,
      loadingSources: true,
    });
    const all = combos(container);
    expect(all).toHaveLength(1);
    expect(all[0].disabled).toBe(true);
    expect(container.textContent).toContain('Listing what is available in "default"');
  });
});

describe("SampleSourcePicker - honesty and escape hatches", () => {
  it("always ends with upload as a way out, in EVERY dead end", () => {
    const failed = buildSampleSourceInventory({
      groupsListed: true,
      searchGroupId: "s",
      searchDatasets: { status: 403, body: "" },
      lakeDatasets: { status: 403, body: "" },
      criblSources: [{ groupId: "default", section: { status: 403, body: "" } }],
    });
    const { container: a } = renderPicker({ inventory: failed });
    expect(a.textContent).toContain("Uploading a file always works");

    cleanup();
    const { container: b } = renderPicker({ enabled: false, groups: null, inventory: null });
    expect(b.textContent).toContain("Uploading a file works either way");

    cleanup();
    const { container: c } = renderPicker({
      groups: { streamGroupIds: [], notes: [], ok: true },
      inventory: null,
      selectedGroupId: "",
    });
    expect(c.textContent).toContain("Upload a sample file instead");
  });

  it("offers RETRY when degraded, and not when everything worked", () => {
    const degraded = buildSampleSourceInventory({
      groupsListed: true,
      searchGroupId: "s",
      searchDatasets: { status: 500, body: "" },
      criblSources: [{ groupId: "default", section: okBody([{ id: "in_a" }]) }],
    });
    const { props } = renderPicker({ inventory: degraded });
    fireEvent.click(screen.getByText("Retry discovery"));
    expect(props.onReload).toHaveBeenCalledTimes(1);

    cleanup();
    renderPicker();
    expect(screen.queryByText("Retry discovery")).toBeNull();
  });

  it("does not offer retry while either stage is in flight", () => {
    renderPicker({ groups: null, inventory: null, loadingGroups: true });
    expect(screen.queryByText("Retry discovery")).toBeNull();
    cleanup();
    renderPicker({ inventory: null, loadingSources: true });
    expect(screen.queryByText("Retry discovery")).toBeNull();
  });

  it("warns when the SELECTED source is disabled", () => {
    // The likeliest reason a Phase 4 capture returns nothing, said at the
    // moment of choosing rather than after the capture comes back empty.
    const withDisabled = buildSampleSourceInventory({
      groupsListed: true,
      criblSources: [
        { groupId: "default", section: okBody([{ id: "in_off", type: "http", disabled: true }]) },
      ],
    });
    const { container } = renderPicker({
      inventory: withDisabled,
      value: "cribl-source:default:in_off",
    });
    expect(container.textContent).toContain("capture from it will return no events");
  });

  it("says nothing about disabled sources when the selection is fine", () => {
    const { container } = renderPicker({ value: "cribl-source:default:in_syslog" });
    expect(container.textContent).not.toContain("will return no events");
  });

  it("renders discovery notes verbatim", () => {
    const { container } = renderPicker({
      notes: ["The worker-group listing failed (boom)."],
    });
    expect(container.textContent).toContain("The worker-group listing failed (boom).");
  });

  it("stays quiet about surfaces nobody has asked for yet", () => {
    // Sources loaded, datasets not requested: the panel must not list two
    // "not listed yet" lines as if they were findings.
    const sourcesOnly = buildSampleSourceInventory({
      groupsListed: true,
      searchGroupId: "s",
      criblSources: [{ groupId: "default", section: okBody([{ id: "in_a" }]) }],
    });
    const { container } = renderPicker({ inventory: sourcesOnly });
    expect(container.querySelectorAll(".sample-source-picker-notes li")).toHaveLength(0);
  });
});
