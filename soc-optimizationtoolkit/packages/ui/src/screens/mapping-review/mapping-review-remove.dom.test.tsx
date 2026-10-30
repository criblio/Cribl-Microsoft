// @vitest-environment happy-dom
/**
 * DBT-143: removing one log type's sample prunes its gap-analysis card and
 * leaves every other table's review - approvals included - standing.
 *
 * WHY THIS IS A DOM PIN. Before this, the reducer could have dropped the key
 * and the section would still have failed the operator: the removed card
 * stayed, the joined staleness string changed, and the only way forward was
 * Re-analyze, which resets EVERY approval. The pure pins cover the reducer and
 * the signature; this drives the real section through Analyze, Approve and a
 * removal and reads what the operator would see.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { parseSampleContent } from "@soc/core";
import type { GapReport, SchemaCatalog, TaggedSample } from "@soc/core";
import { MappingReviewSection } from "./mapping-review-section";
import type { MappingReviewSectionProps } from "./mapping-review-section";

afterEach(cleanup);

const catalog: SchemaCatalog = {
  resolveSchema: async () => [
    { name: "TimeGenerated", type: "datetime" },
    { name: "SourceIP", type: "string" },
  ],
};

function sampleOf(logType: string, record: Record<string, string>): TaggedSample {
  const parsed = parseSampleContent(JSON.stringify(record), {
    sourceName: `${logType}.json`,
  });
  return { logType, format: parsed.format, rawEvents: parsed.rawEvents, parsed };
}

const TRAFFIC = sampleOf("Traffic", { src: "10.0.0.1", action: "allow" });
const DECRYPTION = sampleOf("Decryption", { src: "10.0.0.2", tls: "1.3" });

function buttonNamed(container: HTMLElement, pattern: RegExp): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) =>
    pattern.test(b.textContent ?? ""),
  );
  if (found === undefined) throw new Error(`no button matching ${pattern}`);
  return found;
}

const cardNames = (container: HTMLElement): string[] =>
  [...container.querySelectorAll(".mapping-review-logtype")].map(
    (n) => n.textContent ?? "",
  );

async function analyzedAndApproved(extra: Partial<MappingReviewSectionProps> = {}) {
  const seen = { reports: [] as GapReport[], gate: false };
  const base: MappingReviewSectionProps = {
    solutionName: "",
    samples: [TRAFFIC, DECRYPTION],
    catalog,
    onReportsChange: (r) => {
      seen.reports = r;
    },
    onGateChange: (g) => {
      seen.gate = g;
    },
    ...extra,
  };
  const view = render(<MappingReviewSection {...base} />);
  fireEvent.click(buttonNamed(view.container, /analyze/i));
  await waitFor(() => expect(seen.reports.length).toBe(2));
  fireEvent.click(buttonNamed(view.container, /^Approve Traffic$/));
  fireEvent.click(buttonNamed(view.container, /^Approve Decryption$/));
  await waitFor(() => expect(seen.gate).toBe(true));
  return { ...view, seen, base };
}

describe("mapping review - remove one log type (DBT-143)", () => {
  it("prunes the removed card and keeps the other table approved and fresh", async () => {
    const { container, rerender, seen, base } = await analyzedAndApproved();

    rerender(
      <MappingReviewSection
        {...base}
        samples={[TRAFFIC]}
        removeEvent={{ logType: "Decryption", nonce: 1 }}
      />,
    );

    await waitFor(() => expect(cardNames(container)).toEqual(["Traffic"]));
    expect(seen.reports.map((r) => r.logType)).toEqual(["Traffic"]);
    // The surviving approval stands - no re-analysis, no re-consent.
    expect(seen.gate).toBe(true);
    expect(container.textContent).not.toMatch(/re-analyze to refresh/i);
    expect(container.textContent).toContain(
      "Approved. You can still edit the mappings above.",
    );
  });

  it("still goes stale when a sample is ADDED, so pruning is not a blanket pass", async () => {
    const { container, rerender, base } = await analyzedAndApproved();
    const threat = sampleOf("Threat", { src: "10.0.0.3", severity: "high" });

    rerender(
      <MappingReviewSection {...base} samples={[TRAFFIC, DECRYPTION, threat]} />,
    );

    await waitFor(() =>
      expect(container.textContent).toMatch(/re-analyze to refresh/i),
    );
  });

  it("the card's Remove asks the page and does not prune on its own", async () => {
    const asked: string[] = [];
    const { container } = await analyzedAndApproved({
      onRemoveLogType: (logType) => asked.push(logType),
    });

    fireEvent.click(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Remove Decryption sample"]',
      )!,
    );

    expect(asked).toEqual(["Decryption"]);
    // One prune path: until the page answers with a removeEvent, nothing moves.
    expect(cardNames(container)).toEqual(["Traffic", "Decryption"]);
  });

  it("renders no Remove when the host cannot delete samples", async () => {
    const { container } = await analyzedAndApproved();
    expect(
      container.querySelectorAll("button.mapping-review-remove").length,
    ).toBe(0);
  });
});

describe("mapping review - one status line, enrichment on request (DBT-229)", () => {
  it("puts destination and unused fields in one status line and keeps enrichment closed", async () => {
    const { container } = await analyzedAndApproved();
    const line = container.querySelector(".gap-status-line");
    expect(line).not.toBeNull();
    // The destination and the unused-fields policy are IN the line, not stacked above it.
    expect(line!.querySelector(".gap-provenance")).not.toBeNull();
    expect(line!.querySelector(".unused-policy-bar")).not.toBeNull();
    const enrichment = container.querySelector("details.gap-enrichment-details") as HTMLDetailsElement;
    expect(enrichment).not.toBeNull();
    expect(enrichment.open).toBe(false);
  });
});
