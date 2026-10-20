// @vitest-environment happy-dom
/**
 * DBT-134: a tester saw a worker-group picker with nothing in it.
 *
 * The four states pinned here used to be one: an empty listing, a listing of
 * only Edge / Search groups and (on two surfaces) a failed listing all
 * rendered as an enabled select whose popover read "No matches", or as no
 * control at all. The screens' own pins prove each one is WIRED to this
 * field; these prove what the field says in each state.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toListing } from "@soc/core";
import type { CriblClient, CriblGroupSummary, Listing } from "@soc/core";
import { SearchableSelect } from "./searchable-select";
import { WorkerGroupField } from "./worker-group-field";
import {
  noStreamGroupsText,
  useStreamWorkerGroups,
} from "./worker-group-listing";

afterEach(cleanup);

function clientListing(...answers: Array<Listing<CriblGroupSummary> | Error>) {
  const listGroups = vi.fn();
  for (const a of answers) {
    if (a instanceof Error) listGroups.mockRejectedValueOnce(a);
    else listGroups.mockResolvedValueOnce(a);
  }
  return { request: vi.fn(), listGroups } as unknown as CriblClient & {
    listGroups: ReturnType<typeof vi.fn>;
  };
}

/** The field the way every screen uses it: a select as the rows' picker. */
function Harness({ cribl, auto = true }: { cribl: CriblClient; auto?: boolean }) {
  const { state, reload } = useStreamWorkerGroups(cribl, { auto });
  return (
    <label className="field">
      <span className="field-label">Cribl worker group</span>
      <WorkerGroupField state={state} onRetry={reload}>
        {(groups) => (
          <SearchableSelect
            options={groups.map((g) => ({ value: g.id, label: g.id }))}
            value=""
            onChange={() => {}}
            ariaLabel="Filter worker groups"
          />
        )}
      </WorkerGroupField>
    </label>
  );
}

const HEDGE = /Cribl returned no worker groups this account can see/;

describe("WorkerGroupField", () => {
  it("hedges an EMPTY listing instead of rendering a select that says 'No matches'", async () => {
    const { container } = render(<Harness cribl={clientListing(toListing([]))} />);
    await waitFor(() => expect(screen.getByText(HEDGE)).toBeTruthy());
    // Names the likely causes rather than asserting there are none.
    expect(container.textContent).toMatch(/Cribl role/);
    expect(container.textContent).toMatch(/re-approve this app's policies/);
    expect(container.textContent).not.toMatch(/No matches/);
    // No select at all - there is nothing to choose, so nothing to open.
    expect(container.querySelector(".searchable-select")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry loading groups" })).toBeTruthy();
  });

  it("Retry lists again and renders the picker once groups come back", async () => {
    const cribl = clientListing(toListing([]), toListing([{ id: "default", product: "stream" }]));
    const { container } = render(<Harness cribl={cribl} />);
    await waitFor(() => expect(screen.getByText(HEDGE)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Retry loading groups" }));
    await waitFor(() => expect(container.querySelector(".searchable-select")).not.toBeNull());
    expect(cribl.listGroups).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toMatch(HEDGE);
  });

  it("names the non-Stream groups when every listed group is excluded", async () => {
    const { container } = render(
      <Harness
        cribl={clientListing(
          toListing([
            { id: "default_fleet", product: "edge" },
            { id: "default_search", product: "search" },
          ]),
        )}
      />,
    );
    await waitFor(() => expect(screen.getByText(/none is a Stream worker group/)).toBeTruthy());
    expect(container.textContent).toMatch(/Cribl returned 2 groups/);
    expect(container.textContent).toMatch(/default_fleet \(edge\)/);
    expect(container.textContent).toMatch(/default_search \(search\)/);
    // A measured fact, so it does not borrow the empty listing's hedge.
    expect(container.textContent).not.toMatch(HEDGE);
    expect(container.querySelector(".searchable-select")).toBeNull();
  });

  it("shows a refused listing as the error, with Retry", async () => {
    const { container } = render(
      <Harness cribl={clientListing(new Error("GET /master/groups: HTTP 403"))} />,
    );
    await waitFor(() =>
      expect(screen.getByText(/Could not list worker groups: Error: GET \/master\/groups: HTTP 403/)).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: "Retry loading groups" })).toBeTruthy();
    expect(container.textContent).not.toMatch(/Loading worker groups/);
  });

  it("says Loading only while the call is out", () => {
    const listGroups = vi.fn(() => new Promise<never>(() => {}));
    render(<Harness cribl={{ request: vi.fn(), listGroups } as unknown as CriblClient} />);
    expect(screen.getByText("Loading worker groups...")).toBeTruthy();
  });

  it("renders nothing and lists nothing until asked, when auto is off", () => {
    const cribl = clientListing(toListing([]));
    const { container } = render(<Harness cribl={cribl} auto={false} />);
    expect(cribl.listGroups).not.toHaveBeenCalled();
    expect(container.querySelector(".field-hint")).toBeNull();
  });

  it("lets only the LATEST call write state", async () => {
    // A slow first call that fails must not overwrite a Retry that succeeded.
    let failFirst: (err: Error) => void = () => {};
    const listGroups = vi
      .fn()
      .mockImplementationOnce(() => new Promise((_, reject) => (failFirst = reject)))
      .mockResolvedValueOnce(toListing([{ id: "default", product: "stream" }]));
    const cribl = { request: vi.fn(), listGroups } as unknown as CriblClient;
    function Twice() {
      const { state, reload } = useStreamWorkerGroups(cribl);
      return (
        <>
          <button type="button" onClick={reload}>again</button>
          <WorkerGroupField state={state} onRetry={reload}>
            {(groups) => <span>picked {groups[0].id}</span>}
          </WorkerGroupField>
        </>
      );
    }
    render(<Twice />);
    fireEvent.click(screen.getByRole("button", { name: "again" }));
    await waitFor(() => expect(screen.getByText("picked default")).toBeTruthy());
    failFirst(new Error("late timeout"));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/late timeout/)).toBeNull();
    expect(screen.getByText("picked default")).toBeTruthy();
  });
});

describe("noStreamGroupsText", () => {
  it("is null when there are Stream groups to pick from", () => {
    expect(
      noStreamGroupsText({ stream: toListing([{ id: "default" }]), excluded: [] }),
    ).toBeNull();
  });

  it("uses the singular for one excluded group", () => {
    expect(
      noStreamGroupsText({
        stream: { kind: "none" },
        excluded: [{ id: "default_outpost", product: "outpost" }],
      }),
    ).toBe(
      "Cribl returned 1 group, but none is a Stream worker group: default_outpost (outpost). " +
        "This app deploys to Stream worker groups only.",
    );
  });
});
