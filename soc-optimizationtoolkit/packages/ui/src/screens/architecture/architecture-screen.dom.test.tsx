// @vitest-environment happy-dom
/**
 * DBT-134 WIRING for the Dataflow page's two live views.
 *
 * Both list worker groups only when asked, and both used to say nothing - or
 * the wrong thing - about an EMPTY listing: the Live Workgroup View rendered
 * no select and no sentence, and the Live Edge View stated "No Edge Fleets
 * reported by this leader" off a listing that may simply have been filtered
 * to nothing by the caller's role.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LEGACY_INPUT_MATCH_SUFFIX, LEGACY_INPUT_MATCH_TIP, toListing } from "@soc/core";
import type { CriblClient } from "@soc/core";
import { ArchitectureScreen } from "./architecture-screen";

afterEach(cleanup);

function criblWith(listGroups: ReturnType<typeof vi.fn>): CriblClient {
  return {
    listGroups,
    request: vi.fn().mockResolvedValue({ status: 200, body: { items: [] } }),
  } as unknown as CriblClient;
}

function openTab(name: string) {
  fireEvent.click(screen.getByRole("tab", { name }));
}

describe("ArchitectureScreen - live views and an empty groups listing (DBT-134)", () => {
  it("Live Workgroup View hedges an empty listing instead of rendering nothing", async () => {
    const listGroups = vi.fn().mockResolvedValue(toListing([]));
    render(<ArchitectureScreen cribl={criblWith(listGroups)} />);
    openTab("Live Workgroup View");
    // On demand: nothing is listed until the operator asks.
    expect(listGroups).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Load worker groups" }));
    await waitFor(() =>
      expect(screen.getByText(/Cribl returned no worker groups this account can see/)).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: "Retry loading groups" })).toBeTruthy();
  });

  it("Live Workgroup View offers only the Stream groups", async () => {
    const { container } = render(
      <ArchitectureScreen
        cribl={criblWith(
          vi.fn().mockResolvedValue(
            toListing([
              { id: "default_fleet", product: "edge" },
              { id: "prod", product: "stream" },
            ]),
          ),
        )}
      />,
    );
    openTab("Live Workgroup View");
    fireEvent.click(screen.getByRole("button", { name: "Load worker groups" }));
    await waitFor(() =>
      expect(container.querySelector<HTMLSelectElement>(".panel-controls select")?.value).toBe("prod"),
    );
    const ids = [...container.querySelectorAll(".panel-controls select option")].map(
      (o) => o.textContent,
    );
    expect(ids).toEqual(["prod"]);
  });

  it("Live Edge View does not claim there are no fleets off an EMPTY listing", async () => {
    render(<ArchitectureScreen cribl={criblWith(vi.fn().mockResolvedValue(toListing([])))} />);
    openTab("Live Edge View");
    fireEvent.click(screen.getByRole("button", { name: "Load Live Edge View" }));
    await waitFor(() =>
      expect(
        screen.getByText(/cannot confirm whether any Edge Fleets exist/),
      ).toBeTruthy(),
    );
    expect(screen.queryByText(/No Edge Fleets reported by this leader/)).toBeNull();
  });

  it("Live Edge View states the measured zero when groups came back and none is a fleet", async () => {
    render(
      <ArchitectureScreen
        cribl={criblWith(vi.fn().mockResolvedValue(toListing([{ id: "prod", product: "stream" }])))}
      />,
    );
    openTab("Live Edge View");
    fireEvent.click(screen.getByRole("button", { name: "Load Live Edge View" }));
    await waitFor(() =>
      expect(screen.getByText(/No Edge Fleets reported by this leader/)).toBeTruthy(),
    );
    expect(screen.queryByText(/cannot confirm whether any Edge Fleets exist/)).toBeNull();
  });
});

/**
 * DBT-170: a route that reaches its input ONLY by the bare id is drawn, but
 * the Dataflow screen must not present it as confirmed - the Azure onboarding
 * screen already calls the same route unconfirmed.
 */
describe("ArchitectureScreen - Live Workgroup View flags a bare-id route (DBT-170)", () => {
  const SECTIONS: Record<string, unknown> = {
    "/system/inputs": {
      items: [
        { id: "syslog_bare", type: "syslog" },
        { id: "syslog_typed", type: "syslog" },
      ],
    },
    "/system/outputs": { items: [{ id: "sentinel_dest", type: "sentinel" }] },
    "/routes": {
      id: "default",
      routes: [
        { id: "r1", name: "bare", filter: "__inputId=='syslog_bare'", output: "sentinel_dest", final: true },
        { id: "r2", name: "typed", filter: "__inputId=='syslog:syslog_typed'", output: "sentinel_dest", final: true },
      ],
    },
  };
  function liveCribl(): CriblClient {
    return {
      listGroups: vi.fn().mockResolvedValue(toListing([{ id: "prod", product: "stream" }])),
      request: vi.fn(({ path }: { path: string }) =>
        Promise.resolve({ status: 200, body: SECTIONS[path] ?? { items: [] } }),
      ),
    } as unknown as CriblClient;
  }

  it("names the bare-id flow as unconfirmed, with an explanation, and leaves the typed flow alone", async () => {
    render(<ArchitectureScreen cribl={liveCribl()} />);
    openTab("Live Workgroup View");
    fireEvent.click(screen.getByRole("button", { name: "Load worker groups" }));
    // The load button enables once the listed group is picked.
    const load = screen.getByRole<HTMLButtonElement>("button", { name: "Load Live Workgroup View" });
    await waitFor(() => expect(load.disabled).toBe(false));
    fireEvent.click(load);
    const region = await screen.findByRole("region", { name: "Unconfirmed routes" });
    const rows = [...region.querySelectorAll("li")];
    expect(rows.map((li) => li.firstElementChild?.textContent)).toEqual([
      `syslog_bare -> bare -> sentinel_dest${LEGACY_INPUT_MATCH_SUFFIX}`,
    ]);
    // The (i) carries the explanation, one per flagged flow.
    const tips = region.querySelectorAll(".info-tip-pop");
    expect(tips.length).toBe(1);
    expect(tips[0].textContent).toBe(LEGACY_INPUT_MATCH_TIP);
    expect(region.textContent).not.toContain("syslog_typed");
  });

  it("renders no unconfirmed-routes note when every route is typed", async () => {
    SECTIONS["/routes"] = {
      id: "default",
      routes: [
        { id: "r2", name: "typed", filter: "__inputId=='syslog:syslog_typed'", output: "sentinel_dest", final: true },
      ],
    };
    const { container } = render(<ArchitectureScreen cribl={liveCribl()} />);
    openTab("Live Workgroup View");
    fireEvent.click(screen.getByRole("button", { name: "Load worker groups" }));
    // The load button enables once the listed group is picked.
    const load = screen.getByRole<HTMLButtonElement>("button", { name: "Load Live Workgroup View" });
    await waitFor(() => expect(load.disabled).toBe(false));
    fireEvent.click(load);
    await screen.findByRole("button", { name: "Refresh" });
    expect(screen.queryByRole("region", { name: "Unconfirmed routes" })).toBeNull();
    expect(container.textContent).not.toContain(LEGACY_INPUT_MATCH_SUFFIX);
  });
});
