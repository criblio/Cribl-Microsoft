// @vitest-environment happy-dom
/**
 * DOM pins for the log-type recommendation panel (ADR 0003).
 *
 * The panel replaces a BUTTON that opened a modal, and the thing that made that
 * modal wrong was not its logic but its surface: it presented a ranked list of
 * files as if the ranking meant fit. So the pins here are about what the panel
 * SHOWS and does not show - a state model test cannot see an "Advisory" claim
 * broken by a button, and cannot see a lower bound rendered as a checklist.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  compareLogTypeCoverage,
  deriveExpectedLogTypes,
  documentedLogTypesForSolution,
  mergeLogTypeSources,
} from "@soc/core";
import type { ContentItem } from "@soc/core";
import { LogTypeRecommendation } from "./log-type-recommendation";
import { deriveLogTypeRecommendation } from "./sample-coverage-state";

afterEach(cleanup);

const rule = (name: string, query: string): ContentItem => ({
  type: "alert-rule",
  id: name,
  name,
  queries: [query],
});

function renderFor(
  queries: string[],
  provided: string[],
  loaded = true,
  solution = "",
) {
  const items = queries.map((q, i) => rule(`R${i}`, q));
  const expected = deriveExpectedLogTypes(items);
  const coverage = compareLogTypeCoverage(expected, provided);
  const merged = mergeLogTypeSources({
    expected,
    vendorLogTypes: documentedLogTypesForSolution(solution),
    provided,
  });
  return render(
    <LogTypeRecommendation
      recommendation={deriveLogTypeRecommendation(
        merged,
        coverage.unreferenced,
        loaded,
      )}
    />,
  );
}

const THREE = 'T | where type in ("TRAFFIC","THREAT","CONFIG")';

describe("LogTypeRecommendation", () => {
  it("lists every expected log type with its provided state", () => {
    const { container } = renderFor([THREE], ["TRAFFIC"]);

    const rows = container.querySelectorAll(".log-type-recommendation-list li");
    expect(rows).toHaveLength(3);
    // Counts, not existence: exactly one provided and two outstanding.
    expect(container.querySelectorAll(".log-type-recommendation-have")).toHaveLength(1);
    expect(container.querySelectorAll(".log-type-recommendation-need")).toHaveLength(2);
    expect(screen.getByText("TRAFFIC")).toBeTruthy();
    expect(screen.getByText("THREAT")).toBeTruthy();
    expect(screen.getByText("CONFIG")).toBeTruthy();
  });

  it("shows the provenance of each suggestion, not just the name", () => {
    // The browser asked to be trusted. This one shows its working: which field
    // the content compares against and how many detections depend on it.
    const { container } = renderFor(
      ['T | where type == "TRAFFIC"', THREE],
      [],
    );
    const first = container.querySelector(".log-type-recommendation-list li");
    expect(first?.textContent).toContain("type");
    expect(first?.textContent).toContain("a shipped detection filters on it");
    expect(first?.textContent).toContain("2 items");
  });

  it("uses the singular for a single referencing item", () => {
    const { container } = renderFor(['T | where type == "TRAFFIC"'], []);
    const row = container.querySelector(".log-type-recommendation-list li");
    expect(row?.textContent).toContain("1 item");
    expect(row?.textContent).not.toContain("1 items");
  });

  it("is ADVISORY: renders no button, no input and no gate", () => {
    const { container } = renderFor([THREE], []);

    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelectorAll("input")).toHaveLength(0);
  });

  it("the only links it renders are OUT to vendor documentation", () => {
    // A doc link is not a control - it is the citation that lets the operator
    // check a vendor-tier suggestion rather than take it on faith. Content
    // entries cite nothing external and so render no link at all.
    const { container: content } = renderFor([THREE], []);
    expect(content.querySelectorAll("a")).toHaveLength(0);

    const { container: vendor } = renderFor([], [], true, "Zscaler");
    const links = vendor.querySelectorAll("a");
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute("href")).toContain("zscaler");
      // Opens away from the app, and cannot reach back into it.
      expect(link.getAttribute("rel")).toContain("noopener");
    }
  });

  it("states the lower-bound limit wherever it makes a claim", () => {
    const { container } = renderFor([THREE], ["TRAFFIC", "THREAT", "CONFIG"]);
    // Even when everything is covered - that is exactly when "you have all of
    // them" could be misread as "there is nothing else".
    expect(container.textContent).toContain("A minimum, not a catalog");
  });

  it("makes no claim, and no list, before the detections are read", () => {
    const { container } = renderFor([], ["traffic"], false);

    expect(container.querySelector(".log-type-recommendation")?.getAttribute("data-status"))
      .toBe("unknown");
    expect(container.querySelectorAll(".log-type-recommendation-list li")).toHaveLength(0);
    // No qualifier either: there is no claim to qualify.
    expect(container.textContent).not.toContain("A minimum, not a catalog");
  });

  it("says so plainly when the detections discriminate on nothing", () => {
    const { container } = renderFor(["T | count"], ["traffic"], true);

    expect(container.querySelector(".log-type-recommendation")?.getAttribute("data-status"))
      .toBe("no-signal");
    expect(container.textContent).toContain("cannot say which log types it needs");
    expect(container.querySelectorAll(".log-type-recommendation-list li")).toHaveLength(0);
  });

  it("falls back to the VENDOR tier when the solution names nothing", () => {
    // The case this whole tier exists for: a solution shipping no detections
    // used to produce an empty panel saying "cannot advise".
    const { container } = renderFor([], [], true, "Zscaler Internet Access");

    const rows = container.querySelectorAll(".log-type-recommendation-list li");
    // Not a fixed 5 (2026-08-20): that held only while the generated vendor
    // tier was empty, and it is populated now. What this test is actually
    // about survives - the panel is NOT empty, the cited hand feeds are the
    // ones shown, and every row is labelled vendor so none of it can be read
    // as something the solution's content asked for.
    expect(rows.length).toBeGreaterThan(0);
    expect(container.textContent).toContain("ZIA Web");
    expect(container.textContent).toContain("ZIA Firewall");
    expect(container.querySelectorAll(".log-type-evidence-vendor")).toHaveLength(
      rows.length,
    );
    // And it is still ZIA's list, not its sibling's - the generated tier
    // reintroduced that bleed before the exclusions overlay closed it.
    expect(container.textContent).not.toContain("browser_access");
  });

  it("does NOT claim a vendor-derived list is what the solution needs", () => {
    // The distinction the tiers exist to protect: a catalog is not a
    // requirement, and saying otherwise would send an operator collecting data
    // their content never mentions.
    const { container } = renderFor([], [], true, "Zscaler");
    expect(container.textContent).toContain("ships no detections that name a log type");
    expect(container.textContent).toContain("Zscaler documents");
    expect(container.textContent).not.toContain("This solution's content needs");
  });

  it("labels each row with WHICH tier vouched for it", () => {
    // A detection and a vendor doc must never look alike on the row.
    const { container } = renderFor(
      ['T | where type == "TRAFFIC"'],
      [],
      true,
      "Palo Alto Networks",
    );
    expect(container.querySelectorAll(".log-type-evidence-detection")).toHaveLength(1);
    expect(
      container.querySelectorAll(".log-type-evidence-vendor").length,
    ).toBeGreaterThan(0);
    expect(container.textContent).toContain("the vendor documents this feed");
  });

  it("reports unreferenced samples neutrally, never as something to fix", () => {
    const { container } = renderFor(
      ['T | where type == "TRAFFIC"'],
      ["TRAFFIC", "hipmatch"],
    );

    expect(container.textContent).toContain("hipmatch");
    expect(container.textContent).toContain("referenced by no detection");
    // hipmatch is not one of the expected rows - it is a note, not a gap.
    expect(container.querySelectorAll(".log-type-recommendation-need")).toHaveLength(0);
  });
});
