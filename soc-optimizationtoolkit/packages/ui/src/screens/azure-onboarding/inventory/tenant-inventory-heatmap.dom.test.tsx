// @vitest-environment happy-dom
/**
 * The tenant inventory heat map: cards, drill-down, and the honesty rules (a
 * state is always in words, a could-not-check tile never says "not collected",
 * a null share is a word, never 0%).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { activityLogCells, categoryCards, entraCells, toListing, withArchive } from "@soc/core";
import type { DiagnosticSettingRead, TenantInventory } from "@soc/core";
import { TenantInventoryHeatmap } from "./tenant-inventory-heatmap";
import { cardSummary, cellLabel, destinationLabel, shareLabel } from "./tenant-inventory-state";

afterEach(cleanup);

const setting = (over: Partial<DiagnosticSettingRead>): DiagnosticSettingRead => ({
  id: "",
  name: "to-law",
  ruleId: "",
  hub: "",
  enabled: [],
  enabledGroups: [],
  workspaceId: "",
  storageAccountId: "",
  partnerId: "",
  ...over,
});

function inventory(): TenantInventory {
  const entra = entraCells({
    kind: "read",
    settings: toListing([
      setting({
        name: "entra-to-law",
        enabled: ["SignInLogs"],
        workspaceId: "/subscriptions/s/resourceGroups/rg/providers/Microsoft.OperationalInsights/workspaces/law-soc-prod",
      }),
    ]),
  });
  const activity = activityLogCells([{ subscriptionId: "sub-1", kind: "unread", reason: "the read was refused (403)" }]);
  const cells = withArchive([...entra, ...activity], { namespacePath: null, lakeRoutedSources: [] });
  return {
    readAt: "2026-01-02T03:04:05Z",
    subscriptions: toListing([{ id: "sub-1", name: "one" }]),
    cells,
    cards: categoryCards(cells),
    requests: 3,
  };
}

describe("TenantInventoryHeatmap", () => {
  it("before a read: the button and the nothing-is-changed sentence", () => {
    const onRead = vi.fn();
    render(<TenantInventoryHeatmap inventory={null} reading={false} disabledReason={null} onRead={onRead} />);
    fireEvent.click(screen.getByRole("button", { name: "Read the tenant's logging" }));
    expect(onRead).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Nothing is changed/)).toBeTruthy();
  });

  it("a disabled read says why in visible text", () => {
    render(<TenantInventoryHeatmap inventory={null} reading={false} disabledReason="Connect Azure first." onRead={() => {}} />);
    expect((screen.getByRole("button", { name: "Read the tenant's logging" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Connect Azure first.")).toBeTruthy();
  });

  it("renders seven cards, the read time, and the not-built reason on four", () => {
    const inv = inventory();
    const { container } = render(<TenantInventoryHeatmap inventory={inv} reading={false} disabledReason={null} onRead={() => {}} />);
    expect(inv.cards).toHaveLength(7);
    expect(container.querySelectorAll("button.tih-card")).toHaveLength(7);
    for (const card of inv.cards) {
      expect(screen.getByText(card.title)).toBeTruthy();
    }
    expect(screen.getAllByText(/Not checked yet/)).toHaveLength(4);
    expect(screen.getByText(/2026-01-02T03:04:05Z/)).toBeTruthy();
  });

  it("a not-built card says not checked yet and never could not check", () => {
    const inv = inventory();
    const { container } = render(<TenantInventoryHeatmap inventory={inv} reading={false} disabledReason={null} onRead={() => {}} />);
    const notBuilt = Array.from(container.querySelectorAll("button.tih-card")).filter((b) => b.textContent!.includes("Not checked yet"));
    expect(notBuilt).toHaveLength(4);
    for (const b of notBuilt) {
      expect(b.textContent).toContain("not checked yet");
      expect(b.textContent!.toLowerCase()).not.toContain("could not check");
    }
  });

  it("opens Entra ID to 15 tiles with the collector and destination", () => {
    render(<TenantInventoryHeatmap inventory={inventory()} reading={false} disabledReason={null} onRead={() => {}} />);
    const card = screen.getByRole("button", { name: /Entra ID/ });
    fireEvent.click(card);
    expect(card.getAttribute("aria-expanded")).toBe("true");
    const tiles = screen.getAllByRole("listitem");
    expect(tiles).toHaveLength(15);
    const signIn = tiles.find((t) => within(t).queryByText("SignInLogs") !== null)!;
    expect(within(signIn).getByText(/entra-to-law/)).toBeTruthy();
    expect(within(signIn).getByText(/workspace law-soc-prod/)).toBeTruthy();
    expect(within(signIn).getByText(/Collected, /)).toBeTruthy();
  });

  it("a could-not-check tile gives its reason and never says not collected", () => {
    render(<TenantInventoryHeatmap inventory={inventory()} reading={false} disabledReason={null} onRead={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Activity Log/ }));
    const tiles = screen.getAllByRole("listitem");
    expect(tiles.length).toBeGreaterThan(0);
    for (const t of tiles) {
      expect(t.textContent).toMatch(/Could not check: the read was refused \(403\)/);
      expect(t.textContent!.toLowerCase()).not.toContain("not collected");
    }
  });
});

describe("tenant-inventory-state", () => {
  it("shares are whole percentages and null is a word", () => {
    expect(shareLabel(0.3333)).toBe("33%");
    expect(shareLabel(0)).toBe("0%");
    expect(shareLabel(null)).toBe("not known");
  });

  it("destinationLabel is the last segment plus the kind", () => {
    expect(destinationLabel({ kind: "workspace", resourceId: "/a/b/law-soc-prod" })).toBe("workspace law-soc-prod");
  });

  it("cellLabel states a partly cell with its scope counts", () => {
    const cell = {
      category: "activityLog",
      logType: "Write",
      title: "Write",
      collectors: [],
      state: { kind: "partly", scopes: { collected: 2, read: 3, unread: 1 } },
      archive: { kind: "not-archived" },
    } as const;
    expect(cellLabel(cell)).toBe("Partly collected (2 of 3 read), not archived, 1 could not be read");
  });

  it("cellLabel and cardSummary state the state in words", () => {
    const inv = inventory();
    const signIn = inv.cells.find((c) => c.logType === "SignInLogs")!;
    expect(cellLabel(signIn)).toMatch(/^Collected, not archived/);
    const entra = inv.cards.find((c) => c.id === "entraId")!;
    expect(cardSummary(entra)).toContain("collected, not archived");
    const activity = inv.cards.find((c) => c.id === "activityLog")!;
    expect(cardSummary(activity)).toMatch(/could not check/);
    expect(cardSummary(inv.cards.find((c) => c.id === "nsgFlowLogs")!)).toMatch(/Not checked yet/);
  });
});
