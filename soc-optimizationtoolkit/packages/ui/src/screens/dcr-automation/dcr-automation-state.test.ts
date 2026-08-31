import { describe, it, expect } from "vitest";
import { initialDcrTab, resolveActiveDcrTab } from "./dcr-automation-state";

describe("initialDcrTab", () => {
  it("defaults to Single when Single is enabled", () => {
    expect(initialDcrTab(false)).toBe("single");
  });

  it("defaults to Batch when Single is disabled (no Cribl)", () => {
    expect(initialDcrTab(true)).toBe("batch");
  });
});

describe("resolveActiveDcrTab", () => {
  it("shows the selected tab when Single is enabled", () => {
    expect(resolveActiveDcrTab("single", false)).toBe("single");
    expect(resolveActiveDcrTab("batch", false)).toBe("batch");
  });

  it("forces Batch when Single is selected but disabled", () => {
    expect(resolveActiveDcrTab("single", true)).toBe("batch");
  });

  it("keeps Batch selected regardless of Single being disabled", () => {
    expect(resolveActiveDcrTab("batch", true)).toBe("batch");
  });

  it("passes the azure-only tabs through even when Single is disabled", () => {
    // Inventory and Tables need no Cribl, so a missing Cribl connection must
    // not bounce an operator out of either one.
    expect(resolveActiveDcrTab("inventory", true)).toBe("inventory");
    expect(resolveActiveDcrTab("tables", true)).toBe("tables");
  });
});
