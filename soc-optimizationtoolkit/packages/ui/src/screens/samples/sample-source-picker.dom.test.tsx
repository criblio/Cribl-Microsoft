// @vitest-environment happy-dom
/**
 * DOM pins for the sample-source picker (plan Phase 3, ADR 0003).
 *
 * The state module beside this covers what the picker DECIDES. These cover what
 * it SHOWS - the class of defect a state test structurally cannot see: a retry
 * that never renders, a dropdown offered when there is nothing to pick, a
 * disabled source selected with no warning. The table-picker removal is the
 * cautionary tale: fourteen thoroughly-tested pure decisions behind a panel that
 * had lost its job.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { buildSampleSourceInventory } from "@soc/core";
import { SampleSourcePicker } from "./sample-source-picker";

afterEach(cleanup);

const okBody = (items: unknown[]) => ({ status: 200, body: { items } });

const full = buildSampleSourceInventory({
  searchGroupId: "default_search",
  searchDatasets: okBody([{ id: "pfsense", description: "Firewall" }]),
  criblSources: [
    { groupId: "default", section: okBody([{ id: "in_syslog", type: "syslog" }]) },
  ],
});

function renderPicker(over: Partial<Parameters<typeof SampleSourcePicker>[0]> = {}) {
  const props = {
    inventory: full,
    notes: [] as readonly string[],
    loading: false,
    enabled: true,
    value: "",
    onChange: vi.fn(),
    onReload: vi.fn(),
    ...over,
  };
  return { ...render(<SampleSourcePicker {...props} />), props };
}

describe("SampleSourcePicker", () => {
  it("offers a dropdown when there is something to pick", () => {
    const { container } = renderPicker();
    expect(container.querySelector(".sample-source-picker")?.getAttribute("data-status")).toBe(
      "ready",
    );
    expect(container.querySelector("input")).toBeTruthy();
    expect(screen.getByText("2 places to take samples from.")).toBeTruthy();
  });

  it("offers NO dropdown when there is nothing to pick", () => {
    // An empty combobox is worse than none: it looks like a control that is
    // simply not working.
    const empty = buildSampleSourceInventory({
      criblSources: [{ groupId: "g", section: okBody([]) }],
    });
    const { container } = renderPicker({ inventory: empty });
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector(".sample-source-picker")?.getAttribute("data-status")).toBe(
      "empty",
    );
  });

  it("always ends with upload as a way out, in EVERY dead end", () => {
    // The whole reason discovery is advisory: a failed Search read must not
    // leave the operator thinking they are stuck.
    const failed = buildSampleSourceInventory({
      searchGroupId: "s",
      searchDatasets: { status: 403, body: "" },
      lakeDatasets: { status: 403, body: "" },
      criblSources: [{ groupId: "g", section: { status: 403, body: "" } }],
    });
    const { container: a } = renderPicker({ inventory: failed });
    expect(a.textContent).toContain("Uploading a file always works");

    cleanup();
    const { container: b } = renderPicker({ enabled: false, inventory: null });
    expect(b.textContent).toContain("Uploading a file works either way");
  });

  it("offers RETRY when degraded, and not when everything worked", () => {
    const degraded = buildSampleSourceInventory({
      searchGroupId: "s",
      searchDatasets: { status: 500, body: "" },
      criblSources: [{ groupId: "g", section: okBody([{ id: "in_a" }]) }],
    });
    const { props } = renderPicker({ inventory: degraded });
    const retry = screen.getByText("Retry discovery");
    fireEvent.click(retry);
    expect(props.onReload).toHaveBeenCalledTimes(1);

    cleanup();
    renderPicker();
    expect(screen.queryByText("Retry discovery")).toBeNull();
  });

  it("does not offer retry while a load is in flight", () => {
    renderPicker({ inventory: null, loading: true });
    expect(screen.queryByText("Retry discovery")).toBeNull();
  });

  it("warns when the SELECTED source is disabled", () => {
    // The likeliest reason a Phase 4 capture returns nothing, said at the
    // moment of choosing rather than after the capture comes back empty.
    const withDisabled = buildSampleSourceInventory({
      criblSources: [
        { groupId: "g", section: okBody([{ id: "in_off", type: "http", disabled: true }]) },
      ],
    });
    const value = "cribl-source:g:in_off";
    const { container } = renderPicker({ inventory: withDisabled, value });
    expect(container.textContent).toContain("capture from it will return no events");
  });

  it("says nothing about disabled sources when the selection is fine", () => {
    const { container } = renderPicker({ value: "cribl-source:default:in_syslog" });
    expect(container.textContent).not.toContain("will return no events");
  });

  it("renders discovery notes verbatim - a silent cap reads as completeness", () => {
    const { container } = renderPicker({
      notes: ["Sources were read from the first 6 of 15 worker groups."],
    });
    expect(container.textContent).toContain("first 6 of 15 worker groups");
  });

  it("explains each surface that has nothing to show", () => {
    const mixed = buildSampleSourceInventory({
      searchGroupId: "s",
      searchDatasets: okBody([]),
      criblSources: [{ groupId: "g", section: okBody([{ id: "in_a" }]) }],
    });
    const { container } = renderPicker({ inventory: mixed });
    const notes = container.querySelectorAll(".sample-source-picker-notes li");
    // Search (empty) and Lake (never attempted) explain themselves; the source
    // listing worked and stays silent.
    expect(notes.length).toBe(2);
    expect(container.textContent).toContain("none in this workspace");
  });
});
