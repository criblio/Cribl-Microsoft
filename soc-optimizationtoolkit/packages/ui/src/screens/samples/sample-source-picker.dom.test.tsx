// @vitest-environment happy-dom
/**
 * DOM pins for the sample-source picker (plan Phase 3, ADR 0003).
 *
 * The state module covers what the picker DECIDES. These cover what it SHOWS -
 * the class of defect a state test structurally cannot see: a dropdown offered
 * before a choice is made, a group picker rendered for a mode that has no
 * groups, a retry that never appears. The table-picker removal is the
 * cautionary tale: fourteen thoroughly-tested pure decisions behind a panel that
 * had quietly lost its job.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { buildSampleSourceInventory } from "@soc/core";
import { SampleSourcePicker } from "./sample-source-picker";

afterEach(cleanup);

const okBody = (items: unknown[]) => ({ status: 200, body: { items } });

const GROUPS = {
  streamGroupIds: ["default", "grp2"],
  searchGroupId: "s",
  notes: [],
  ok: true,
};

const lakeInv = buildSampleSourceInventory({
  lakeDatasets: okBody([{ id: "cribl_logs" }, { id: "Corelight" }]),
});
const sourceInv = buildSampleSourceInventory({
  criblSources: [{ groupId: "default", section: okBody([{ id: "in_syslog", type: "syslog" }]) }],
});

function renderPicker(over: Partial<Parameters<typeof SampleSourcePicker>[0]> = {}) {
  const props = {
    groups: GROUPS,
    inventory: null,
    mode: null,
    selectedGroupId: "",
    notes: [] as readonly string[],
    loadingGroups: false,
    loadingSources: false,
    enabled: true,
    value: "",
    onSelectMode: vi.fn(),
    onSelectGroup: vi.fn(),
    onChange: vi.fn(),
    onReload: vi.fn(),
    ...over,
  };
  return { ...render(<SampleSourcePicker {...props} />), props };
}

const combos = (c: HTMLElement) => c.querySelectorAll(".searchable-select-control");
const modeButtons = (c: HTMLElement) => c.querySelectorAll(".acquisition-mode");

describe("SampleSourcePicker - the choice", () => {
  it("offers exactly two modes, and NO dropdown, before one is chosen", () => {
    const { container } = renderPicker();
    expect(container.querySelector(".sample-source-picker")?.getAttribute("data-status")).toBe(
      "awaiting-mode",
    );
    expect(modeButtons(container)).toHaveLength(2);
    expect(combos(container)).toHaveLength(0);
    expect(screen.getByText("Query a Cribl Lake dataset")).toBeTruthy();
    expect(screen.getByText("Capture from a live source")).toBeTruthy();
  });

  it("reports the chosen mode upward and marks it selected", () => {
    const { props } = renderPicker();
    fireEvent.click(screen.getByText("Query a Cribl Lake dataset"));
    expect(props.onSelectMode).toHaveBeenCalledWith("lake-query");

    cleanup();
    const { container: c2 } = renderPicker({ mode: "lake-query", inventory: lakeInv });
    const active = c2.querySelectorAll(".acquisition-mode-active");
    expect(active).toHaveLength(1);
    expect(active[0].getAttribute("aria-checked")).toBe("true");
  });

  it("offers no modes at all before the workspace is reachable", () => {
    const { container } = renderPicker({ groups: null, loadingGroups: true });
    expect(modeButtons(container)).toHaveLength(0);
  });
});

describe("SampleSourcePicker - lake mode", () => {
  it("shows the dataset dropdown and NO worker-group picker", () => {
    // Listing Lake datasets is a leader route; asking for a group would be
    // asking a question whose answer is never used.
    const { container } = renderPicker({ mode: "lake-query", inventory: lakeInv });
    expect(combos(container)).toHaveLength(1);
    expect(screen.getByText("Lake dataset")).toBeTruthy();
    expect(screen.queryByText("Worker group")).toBeNull();
  });

  it("warns up front when the workspace has no Search group, without gating", () => {
    const { container } = renderPicker({
      mode: "lake-query",
      inventory: lakeInv,
      groups: { streamGroupIds: ["default"], notes: [], ok: true },
    });
    expect(container.textContent).toContain("cannot be queried from here");
    // Still lists them - the operator may want to see what exists.
    expect(combos(container)).toHaveLength(1);
  });

  it("does not warn when a Search group exists", () => {
    const { container } = renderPicker({ mode: "lake-query", inventory: lakeInv });
    expect(container.textContent).not.toContain("cannot be queried from here");
  });
});

describe("SampleSourcePicker - capture mode", () => {
  it("asks for a worker group FIRST, with no source dropdown yet", () => {
    const { container } = renderPicker({ mode: "live-capture" });
    expect(container.querySelector(".sample-source-picker")?.getAttribute("data-status")).toBe(
      "awaiting-group",
    );
    expect(combos(container)).toHaveLength(1);
    expect(screen.getByText("Worker group")).toBeTruthy();
    expect(screen.queryByText("Source")).toBeNull();
  });

  it("shows BOTH dropdowns once the group's sources are in", () => {
    const { container } = renderPicker({
      mode: "live-capture",
      selectedGroupId: "default",
      inventory: sourceInv,
    });
    expect(combos(container)).toHaveLength(2);
    expect(screen.getByText("Worker group")).toBeTruthy();
    expect(screen.getByText("Source")).toBeTruthy();
  });

  it("reports the chosen group upward", () => {
    const { container, props } = renderPicker({ mode: "live-capture" });
    fireEvent.click(combos(container)[0]);
    const option = [...container.querySelectorAll(".searchable-select-option")].find((o) =>
      o.textContent?.includes("grp2"),
    );
    expect(option).toBeTruthy();
    fireEvent.click(option!);
    expect(props.onSelectGroup).toHaveBeenCalledWith("grp2");
  });

  it("warns when the SELECTED source is disabled", () => {
    // The likeliest reason a Phase 4 capture returns nothing, said at the
    // moment of choosing rather than after the capture comes back empty.
    const withDisabled = buildSampleSourceInventory({
      criblSources: [
        { groupId: "default", section: okBody([{ id: "in_off", type: "http", disabled: true }]) },
      ],
    });
    const { container } = renderPicker({
      mode: "live-capture",
      selectedGroupId: "default",
      inventory: withDisabled,
      value: "cribl-source:default:in_off",
    });
    expect(container.textContent).toContain("capture from it will return no events");
  });
});

describe("SampleSourcePicker - honesty and escape hatches", () => {
  it("always ends with upload as a way out, in EVERY dead end", () => {
    const failed = buildSampleSourceInventory({ lakeDatasets: { status: 403, body: "" } });
    const { container: a } = renderPicker({ mode: "lake-query", inventory: failed });
    expect(a.textContent).toContain("Uploading a file always works");

    cleanup();
    const { container: b } = renderPicker({ enabled: false, groups: null });
    expect(b.textContent).toContain("Uploading a file works either way");

    cleanup();
    const { container: c } = renderPicker({
      groups: { streamGroupIds: [], notes: [], ok: false },
    });
    expect(c.textContent).toContain("Upload a sample file instead");
  });

  it("points at the OTHER mode when one has nothing", () => {
    const none = buildSampleSourceInventory({ lakeDatasets: okBody([]) });
    const { container } = renderPicker({ mode: "lake-query", inventory: none });
    expect(container.textContent).toContain("Capture from a live source instead");
  });

  it("offers RETRY when degraded or empty, and not when everything worked", () => {
    const failed = buildSampleSourceInventory({ lakeDatasets: { status: 500, body: "" } });
    const { props } = renderPicker({ mode: "lake-query", inventory: failed });
    fireEvent.click(screen.getByText("Retry"));
    expect(props.onReload).toHaveBeenCalledTimes(1);

    cleanup();
    renderPicker({ mode: "lake-query", inventory: lakeInv });
    expect(screen.queryByText("Retry")).toBeNull();
  });

  it("does not offer retry, or a mode change, while a load is in flight", () => {
    const { container } = renderPicker({ mode: "lake-query", loadingSources: true });
    expect(screen.queryByText("Retry")).toBeNull();
    // Changing mode mid-load would race the response that is already coming.
    expect([...modeButtons(container)].every((b) => (b as HTMLButtonElement).disabled)).toBe(
      true,
    );
  });

  it("renders discovery notes verbatim", () => {
    const { container } = renderPicker({
      notes: ["The worker-group listing failed (boom)."],
    });
    expect(container.textContent).toContain("The worker-group listing failed (boom).");
  });
});
