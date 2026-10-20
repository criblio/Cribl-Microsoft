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
import { toListing } from "@soc/core";
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
