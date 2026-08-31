// @vitest-environment happy-dom
/**
 * Pins for the tab strip's optionally-controlled selection (TBL-3).
 *
 * The screen owned its selection outright until the Tables tab needed to send
 * an operator to Single with a table already filled in. Making it optionally
 * controlled is the kind of seam that breaks quietly: the UNCONTROLLED path is
 * what every existing caller uses, so the first two pins here exist to prove
 * that path did not change at all.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DcrAutomationScreen } from "./dcr-automation-screen";

afterEach(cleanup);

const panels = {
  single: <p>SINGLE PANEL</p>,
  batch: <p>BATCH PANEL</p>,
  inventory: <p>INVENTORY PANEL</p>,
  tables: <p>TABLES PANEL</p>,
};

describe("uncontrolled - the behaviour every existing caller relies on", () => {
  it("lands on Inventory and switches on click, with no host involvement", () => {
    render(
      <DcrAutomationScreen
        single={panels.single}
        batch={panels.batch}
        inventory={panels.inventory}
      />,
    );
    expect(screen.getByText("INVENTORY PANEL")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Batch" }));
    expect(screen.getByText("BATCH PANEL")).toBeTruthy();
  });

  it("renders no Tables tab when the shell provides no tables panel", () => {
    render(<DcrAutomationScreen single={panels.single} batch={panels.batch} />);
    expect(screen.queryByRole("tab", { name: "Tables" })).toBeNull();
  });
});

describe("controlled - the Tables to Single hand-off", () => {
  it("shows the tab the HOST names, ignoring its own state", () => {
    render(
      <DcrAutomationScreen
        {...panels}
        activeTab="tables"
        onTabChange={vi.fn()}
      />,
    );
    // Inventory is present, so the uncontrolled default would have been
    // Inventory. The host wins.
    expect(screen.getByText("TABLES PANEL")).toBeTruthy();
    expect(screen.queryByText("INVENTORY PANEL")).toBeNull();
  });

  it("reports a click upward instead of switching on its own", () => {
    const onTabChange = vi.fn();
    render(
      <DcrAutomationScreen {...panels} activeTab="tables" onTabChange={onTabChange} />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Single table" }));
    expect(onTabChange).toHaveBeenCalledWith("single");
    // The host has not re-rendered with a new activeTab, so the view must NOT
    // have moved - otherwise the screen and its host disagree about the truth.
    expect(screen.getByText("TABLES PANEL")).toBeTruthy();
  });

  it("still honours the Single-disabled rule while controlled", () => {
    // A host asking for a tab the operator cannot use must not produce an
    // unusable view - the resolve rule outranks the host.
    render(
      <DcrAutomationScreen
        {...panels}
        activeTab="single"
        onTabChange={vi.fn()}
        singleDisabledReason="no Cribl"
      />,
    );
    expect(screen.getByText("BATCH PANEL")).toBeTruthy();
  });

  it("does NOT bounce the azure-only Tables tab when Single is disabled", () => {
    render(
      <DcrAutomationScreen
        {...panels}
        activeTab="tables"
        onTabChange={vi.fn()}
        singleDisabledReason="no Cribl"
      />,
    );
    expect(screen.getByText("TABLES PANEL")).toBeTruthy();
  });
});
