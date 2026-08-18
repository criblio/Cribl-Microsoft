// @vitest-environment happy-dom
/**
 * DOM pins for accepting a suggested route filter.
 *
 * The derivation withholds a filter it cannot back with enough events, and a
 * curated sample corpus is exactly the thin case - 8 of 10 Zscaler log types
 * shipped placeholdered, several with a correct filter derived and then
 * withheld. Showing that filter and making the operator retype it into
 * route.yml was the worst of both, so Accept exists.
 *
 * These are DOM pins because the state tests cannot see any of it. Those pins
 * prove that an override REACHES route.yml; none of them can tell whether a
 * button exists to produce one, whether it reports the right log type, or
 * whether an accepted filter leaves any trace on screen. The identity-block
 * defect (a value that could be set but never changed) was exactly this shape:
 * resolvers correct, controls missing, and no resolver test can see a missing
 * button.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EMPTY_OVERFLOW_TRIAGE } from "@soc/core";
import type { GapReport } from "@soc/core";
import { PipelinePreviewSection } from "./pipeline-preview-section";

afterEach(cleanup);

function report(logType: string): GapReport {
  return {
    tableName: "CommonSecurityLog",
    logType,
    stats: [],
    sourceFieldCount: 0,
    destFieldCount: 0,
    passthroughCount: 0,
    dcrHandledCount: 0,
    criblHandledCount: 0,
    overflowCount: 0,
    dcrRenames: [],
    dcrCoercions: [],
    criblRenames: [],
    criblCoercions: [],
    dcrHandlesSummary: "DCR handles: 0 rename(s), 0 coercion(s)",
    criblHandlesSummary: "Cribl handles: 1 rename(s), 0 coercion(s)",
    routeCondition: "true",
    fieldMappings: [
      {
        source: "src",
        dest: "SourceIP",
        sourceType: "string",
        destType: "string",
        confidence: "alias",
        action: "rename",
        needsCoercion: false,
        description: "",
      },
    ],
    destSchema: [{ name: "SourceIP", type: "string" }],
    overflowLossy: false,
    overflowTriage: EMPTY_OVERFLOW_TRIAGE,
    warnings: [],
  };
}

/** Two CEF log types telling themselves apart by ONE value, on 2 events each -
 *  under the 3-event threshold, so the filters are suggested and not applied. */
const THIN_VALUES = {
  firewall: { logType: "firewall", eventCount: 2, values: { act: ["Allow", "Allow"] } },
  dns: { logType: "dns", eventCount: 2, values: { act: ["Query", "Query"] } },
};

function renderPreview(props: {
  routeFilterOverrides?: Readonly<Record<string, string>>;
  onAccept?: (logType: string, filter: string) => void;
  onUndo?: (logType: string) => void;
}) {
  render(
    <PipelinePreviewSection
      inputs={{
        solutionName: "Vendor",
        reports: [report("firewall"), report("dns")],
        sampleFormats: { firewall: "cef", dns: "cef" },
        sampleFieldValues: THIN_VALUES,
        ...(props.routeFilterOverrides !== undefined
          ? { routeFilterOverrides: props.routeFilterOverrides }
          : {}),
        approved: true,
      }}
      packName="vendor-sentinel"
      {...(props.onAccept !== undefined
        ? { onAcceptRouteFilter: props.onAccept }
        : {})}
      {...(props.onUndo !== undefined ? { onUndoRouteFilter: props.onUndo } : {})}
    />,
  );
}
/**
 * The accepted-filters list and Undo. These SURVIVED the removal of the
 * suggestion tier because they serve the hand-written path too: whatever the
 * operator applies, from wherever, has to be visible and reversible.
 *
 * What went with the tier: "offers an Accept per suggestion", "moves an
 * accepted filter out of the suggestions", and the pin that a suggested log
 * type gets no write-a-filter field. All three described a block that no
 * longer renders, because a value naming its log type is now APPLIED and one
 * that does not is not offered at all. Deleted deliberately rather than left
 * asserting against markup that cannot appear.
 */
describe("PipelinePreviewSection - what the operator applied", () => {
  it("lists an applied filter with an Undo", () => {
    // Without this the filter would vanish into the plan with no trace of what
    // was applied or any way back to the placeholder.
    renderPreview({
      routeFilterOverrides: { firewall: "act === 'Allow'" },
      onAccept: vi.fn(),
      onUndo: vi.fn(),
    });
    expect(screen.getByText("Route filters you accepted")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
  });

  it("reports the right log type to Undo", () => {
    const onUndo = vi.fn();
    renderPreview({
      routeFilterOverrides: { firewall: "act === 'Allow'" },
      onAccept: vi.fn(),
      onUndo,
    });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onUndo).toHaveBeenCalledWith("firewall");
  });

  it("stops naming an applied log type as needing a filter", () => {
    // The placeholder banner is a call to action. Leaving firewall in it after
    // its filter is in force reads as outstanding work that is already done.
    renderPreview({
      routeFilterOverrides: { firewall: "act === 'Allow'" },
      onAccept: vi.fn(),
    });
    const banner =
      screen.getByText(/needs a route filter/).parentElement?.textContent ?? "";
    expect(banner).toContain("dns");
    expect(banner).not.toContain("firewall");
  });

  it("agrees with itself about how many log types are left", () => {
    // The count, the verb and the pronoun are three separate ternaries over
    // the same length. "1 log type need a route filter before it can" shipped
    // because only the count and pronoun were pluralized.
    renderPreview({
      routeFilterOverrides: { firewall: "act === 'Allow'" },
      onAccept: vi.fn(),
    });
    const banner = screen.getByText(/needs a route filter/).textContent ?? "";
    expect(banner).toContain("1 log type needs a route filter before it can");
  });

  it("does not offer Undo for an override whose log type left the plan", () => {
    // Overrides outlive solution changes. An Undo control for a log type that
    // is not on screen is a control with no visible effect.
    renderPreview({
      routeFilterOverrides: { gone: "act === 'Nope'" },
      onAccept: vi.fn(),
      onUndo: vi.fn(),
    });
    expect(screen.queryByText("Route filters you accepted")).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("offers a write-a-filter field to EVERY placeholdered log type", () => {
    // Was "does not offer one to a log type that HAS a suggestion". With the
    // tier gone, a placeholdered log type is by definition one nothing could
    // be derived for, so every one of them gets a field.
    renderPreview({ onAccept: vi.fn() });
    expect(screen.getAllByLabelText(/^Route filter for/)).toHaveLength(2);
  });
});


/**
 * The log types with NO candidate. Accept cannot reach them - there is nothing
 * to accept - and on the Zscaler corpus that was 5 of 10. Before this they
 * shipped placeholdered and the operator had to finish the pack by editing
 * route.yml in Cribl after install.
 */
describe("PipelinePreviewSection - writing a filter by hand", () => {
  /** One field per log type, so nothing is column-shaped and nothing is
   *  suggested - the no-candidate case, not the thin-evidence one. */
  const NO_CANDIDATE = {
    firewall: { logType: "firewall", eventCount: 9, values: { onlyFirewall: ["a"] } },
    dns: { logType: "dns", eventCount: 9, values: { onlyDns: ["b"] } },
  };

  function renderNoCandidate(onAccept?: (l: string, f: string) => void) {
    render(
      <PipelinePreviewSection
        inputs={{
          solutionName: "Vendor",
          reports: [report("firewall"), report("dns")],
          sampleFormats: { firewall: "json", dns: "json" },
          sampleFieldValues: NO_CANDIDATE,
          approved: true,
        }}
        packName="vendor-sentinel"
        {...(onAccept !== undefined ? { onAcceptRouteFilter: onAccept } : {})}
      />,
    );
  }

  it("offers a field for a log type nothing could be suggested for", () => {
    renderNoCandidate(vi.fn());
    expect(screen.getByLabelText("Route filter for firewall")).toBeTruthy();
    expect(screen.getByLabelText("Route filter for dns")).toBeTruthy();
    // Nothing was suggestable, so there is nothing to Accept.
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  });

  it("applies what was typed, to the log type it was typed for", () => {
    const onAccept = vi.fn();
    renderNoCandidate(onAccept);
    fireEvent.change(screen.getByLabelText("Route filter for dns"), {
      target: { value: "event_type === 'dns'" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Apply" })[1]!);
    expect(onAccept).toHaveBeenCalledWith("dns", "event_type === 'dns'");
  });

  it("applies on Enter, so one expression does not need the mouse", () => {
    const onAccept = vi.fn();
    renderNoCandidate(onAccept);
    const input = screen.getByLabelText("Route filter for firewall");
    fireEvent.change(input, { target: { value: "event_type === 'fw'" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAccept).toHaveBeenCalledWith("firewall", "event_type === 'fw'");
  });

  it("refuses a blank or whitespace filter", () => {
    // A blank filter applies verbatim and matches nothing - the same inert
    // route as the placeholder, minus the banner explaining it.
    const onAccept = vi.fn();
    renderNoCandidate(onAccept);
    const input = screen.getByLabelText("Route filter for dns");
    const apply = screen.getAllByRole("button", { name: "Apply" })[1]!;
    expect(apply).toHaveProperty("disabled", true);

    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("trims what it applies", () => {
    const onAccept = vi.fn();
    renderNoCandidate(onAccept);
    const input = screen.getByLabelText("Route filter for dns");
    fireEvent.change(input, { target: { value: "  event_type === 'dns'  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAccept).toHaveBeenCalledWith("dns", "event_type === 'dns'");
  });

  it("renders nothing when the caller cannot persist the choice", () => {
    renderNoCandidate();
    expect(screen.queryByLabelText(/^Route filter for/)).toBeNull();
  });
});

/**
 * CSV needs different guidance, and the difference is not cosmetic.
 *
 * Cribl routes run BEFORE the pipeline, so a CSV event is still a positional
 * line in `_raw` with no parsed fields - which is exactly why both
 * discriminators refuse to derive a filter for CSV at all. Every CSV log type
 * in a multi-log-type pack therefore placeholders by construction, making this
 * hint the ONLY routing guidance a CSV vendor's operator ever gets. Offering
 * `event_type === 'dns'` there invites the one filter that cannot work.
 *
 * Found by validating CSV route derivation 2026-08-17.
 */
describe("PipelinePreviewSection - CSV cannot be filtered on parsed fields", () => {
  function renderCsv(format: string) {
    render(
      <PipelinePreviewSection
        inputs={{
          solutionName: "Vendor",
          reports: [report("Allowed"), report("Blocked")],
          sampleFormats: { Allowed: format, Blocked: format },
          approved: true,
        }}
        packName="vendor-sentinel"
        onAcceptRouteFilter={vi.fn()}
      />,
    );
  }

  it("offers a _raw example for CSV, not a field test", () => {
    renderCsv("csv");
    const input = screen.getByLabelText("Route filter for Allowed");
    expect(input.getAttribute("placeholder")).toContain("_raw");
    expect(input.getAttribute("placeholder")).not.toContain("event_type ===");
  });

  it("explains WHY a field test fails on CSV", () => {
    // Without the reason, the _raw example reads as an arbitrary style choice
    // and the operator "fixes" it back to a field test.
    renderCsv("csv");
    expect(screen.getByText(/reach the route unparsed/)).toBeTruthy();
  });

  it("keeps the field-test example for parsed formats", () => {
    renderCsv("json");
    const input = screen.getByLabelText("Route filter for Allowed");
    expect(input.getAttribute("placeholder")).toContain("event_type ===");
    expect(screen.queryByText(/reach the route unparsed/)).toBeNull();
  });
});
