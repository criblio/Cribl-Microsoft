// @vitest-environment happy-dom
/**
 * DOM pins for the vendor-identity block.
 *
 * The defect these guard is a DEAD END, not a crash (user report 2026-08-12):
 * a value could be set but never changed. Picking NSSWeblog left a read-only
 * row whose hint pointed at another section, so correcting a one-click choice
 * meant leaving the card you made it on - and a SAMPLE-provided value could not
 * be corrected at all, which is how a wrong DeviceProduct in the data became
 * unfixable in the app.
 *
 * Nothing can catch that except rendering it. The core resolvers were, and
 * still are, thoroughly unit-tested - they were never wrong. What was wrong was
 * that the satisfied state had no controls, and a resolver test cannot see a
 * missing button.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IdentityFieldStatus, VendorIdentity } from "@soc/core";
import { IdentityBlock } from "./identity-block";

afterEach(cleanup);

const ZSCALER: VendorIdentity = {
  vendor: "Zscaler",
  productOptions: ["NSSWeblog", "NSSFWlog"],
};

function renderBlock(statuses: IdentityFieldStatus[], onAdd = vi.fn(() => true)) {
  render(
    <IdentityBlock
      tableName="CommonSecurityLog"
      statuses={statuses}
      identity={ZSCALER}
      onAdd={onAdd}
    />,
  );
  return onAdd;
}

describe("IdentityBlock - a set value stays changeable", () => {
  it("offers the candidates on an ALREADY-SET enrichment value", () => {
    // The report. Before this, a satisfied field rendered as text and the
    // chips disappeared with it - so NSSWeblog could not become NSSFWlog.
    const onAdd = renderBlock([
      { field: "DeviceProduct", status: "enrichment", value: "NSSWeblog" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "NSSFWlog" }));
    expect(onAdd).toHaveBeenCalledWith("DeviceProduct", "NSSFWlog");
  });

  it("offers a typed replacement on an already-set value", () => {
    const onAdd = renderBlock([
      { field: "DeviceProduct", status: "enrichment", value: "NSSWeblog" },
    ]);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "NSSFWlog" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(onAdd).toHaveBeenCalledWith("DeviceProduct", "NSSFWlog");
  });

  it("lets a SAMPLE-provided value be overridden", () => {
    // The other half: a wrong DeviceProduct carried by the data (the reported
    // "NSS") was previously unfixable - the row said "provided by the sample
    // data" and offered nothing.
    const onAdd = renderBlock([
      { field: "DeviceProduct", status: "sample", value: "NSS" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "NSSWeblog" }));
    expect(onAdd).toHaveBeenCalledWith("DeviceProduct", "NSSWeblog");
  });

  it("says what overriding a sample value COSTS", () => {
    // A constant replaces the per-event value for every event. That is
    // sometimes right and sometimes destructive, so it is stated rather than
    // discovered.
    renderBlock([{ field: "DeviceProduct", status: "sample", value: "NSS" }]);
    expect(screen.getByText(/overwrites the per-event value/i)).toBeTruthy();
  });

  it("still shows the current value, so a replacement is an informed choice", () => {
    renderBlock([
      { field: "DeviceProduct", status: "enrichment", value: "NSSWeblog" },
    ]);
    // The text appears twice on purpose - once as the current value and once as
    // a candidate chip - so this asserts the NON-button one exists. Matching it
    // loosely would pass on the chip alone, which is not the value display.
    const shown = screen
      .getAllByText("NSSWeblog")
      .filter((el) => el.tagName !== "BUTTON");
    expect(shown.length).toBeGreaterThan(0);
  });

  it("keeps the Required treatment while the field is MISSING", () => {
    // The gate that blocks the pack build must not soften just because the row
    // now looks the same in every state.
    renderBlock([{ field: "DeviceProduct", status: "missing" }]);
    expect(screen.getByText("Required")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
    expect(screen.getByText(/Required before the pack can be built/i)).toBeTruthy();
  });

  it("NEVER auto-picks a candidate - offering is not choosing", () => {
    // The wrong constant silently breaks Sentinel's content filters, so the
    // choice stays human even though the app knows the options.
    const onAdd = renderBlock([{ field: "DeviceProduct", status: "missing" }]);
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "NSSWeblog" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "NSSFWlog" })).toBeTruthy();
  });
});
