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
import { compareLogTypeCoverage, deriveExpectedLogTypes } from "@soc/core";
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

function renderFor(queries: string[], provided: string[], loaded = true) {
  const coverage = compareLogTypeCoverage(
    deriveExpectedLogTypes(queries.map((q, i) => rule(`R${i}`, q))),
    provided,
  );
  return render(
    <LogTypeRecommendation
      recommendation={deriveLogTypeRecommendation(coverage, loaded)}
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
    expect(first?.textContent).toContain("referenced by 2 detections");
  });

  it("uses the singular for a single referencing detection", () => {
    const { container } = renderFor(['T | where type == "TRAFFIC"'], []);
    const row = container.querySelector(".log-type-recommendation-list li");
    expect(row?.textContent).toContain("referenced by 1 detection");
    expect(row?.textContent).not.toContain("1 detections");
  });

  it("is ADVISORY: renders no button, no input and no gate", () => {
    const { container } = renderFor([THREE], []);

    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });

  it("states the lower-bound limit wherever it makes a claim", () => {
    const { container } = renderFor([THREE], ["TRAFFIC", "THREAT", "CONFIG"]);
    // Even when everything is covered - that is exactly when "you have all of
    // them" could be misread as "there is nothing else".
    expect(container.textContent).toContain("a minimum, not a catalog");
  });

  it("makes no claim, and no list, before the detections are read", () => {
    const { container } = renderFor([], ["traffic"], false);

    expect(container.querySelector(".log-type-recommendation")?.getAttribute("data-status"))
      .toBe("unknown");
    expect(container.querySelectorAll(".log-type-recommendation-list li")).toHaveLength(0);
    // No qualifier either: there is no claim to qualify.
    expect(container.textContent).not.toContain("a minimum, not a catalog");
  });

  it("says so plainly when the detections discriminate on nothing", () => {
    const { container } = renderFor(["T | count"], ["traffic"], true);

    expect(container.querySelector(".log-type-recommendation")?.getAttribute("data-status"))
      .toBe("no-signal");
    expect(container.textContent).toContain("cannot say which log types it needs");
    expect(container.querySelectorAll(".log-type-recommendation-list li")).toHaveLength(0);
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
