// @vitest-environment happy-dom
/**
 * DOM pins for the vendor-identity mismatch advisory.
 *
 * Two opposite failures, and the second is why this block is easy to get wrong:
 *
 *   SILENCE when the rules disagree - the whole point. A vendor string that does
 *   not match what the content filters on deploys and ingests cleanly and never
 *   fires a rule, so this advisory is the only moment it can be noticed.
 *
 *   NOISE when they do not. A card that always shows a warning trains operators
 *   to ignore it, and then the real one is invisible too. It must render nothing
 *   when the sample agrees, when the rules never mention the field, and once the
 *   correction has been applied.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CefIdentityFinding } from "@soc/core";
import { IdentityMismatchBlock } from "./identity-mismatch-block";

afterEach(cleanup);

const mismatch: CefIdentityFinding = {
  field: "DeviceVendor",
  sampleValue: "Acme",
  expected: ["Zscaler"],
  status: "mismatch",
  suggested: "Zscaler",
};

function renderBlock(
  findings: CefIdentityFinding[],
  override: Record<string, string> = {},
) {
  const onOverrideChange = vi.fn();
  render(
    <IdentityMismatchBlock
      findings={findings}
      override={override}
      onOverrideChange={onOverrideChange}
    />,
  );
  return onOverrideChange;
}

describe("IdentityMismatchBlock - speaks up only when it should", () => {
  it("NAMES BOTH SIDES on a mismatch", () => {
    // Not "this looks wrong" - the operator needs what the sample sends and
    // what the rules want, to judge which one is actually mistaken.
    renderBlock([mismatch]);
    expect(screen.getByText(/sends "Acme"/)).toBeTruthy();
    expect(screen.getByText(/compare against "Zscaler"/)).toBeTruthy();
  });

  it("states the CONSEQUENCE, since nothing else will", () => {
    renderBlock([mismatch]);
    expect(screen.getByText(/will ever match this data/i)).toBeTruthy();
  });

  it("offers only the value the CONTENT named", () => {
    const onChange = renderBlock([mismatch]);
    fireEvent.click(screen.getByRole("button", { name: /Zscaler/ }));
    expect(onChange).toHaveBeenCalledWith({ DeviceVendor: "Zscaler" });
  });

  it("renders NOTHING when the sample already agrees", () => {
    const { container } = render(
      <IdentityMismatchBlock
        findings={[{ ...mismatch, status: "match", suggested: null }]}
        override={{}}
        onOverrideChange={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders NOTHING when the rules never constrain the field", () => {
    // `unknown` is not a problem to report - there is no expectation to fail.
    const { container } = render(
      <IdentityMismatchBlock
        findings={[
          { ...mismatch, status: "unknown", expected: [], suggested: null },
        ]}
        override={{}}
        onOverrideChange={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders NOTHING when there are no findings at all", () => {
    const { container } = render(
      <IdentityMismatchBlock findings={[]} override={{}} onOverrideChange={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("keeps a case-mismatch DISTINCT from a wrong vendor", () => {
    // `=~` rules match either way and `==` rules do not, so this is a partial
    // failure. Calling it a mismatch would send operators chasing a difference
    // half the corpus ignores.
    renderBlock([
      { ...mismatch, sampleValue: "zscaler", status: "case-mismatch" },
    ]);
    expect(screen.getByText(/some detections fire and some never will/i)).toBeTruthy();
  });

  it("shows what the pipeline WILL send once applied, and can undo it", () => {
    const onChange = renderBlock([mismatch], { DeviceVendor: "Zscaler" });
    expect(screen.getByText(/Pipeline will send "Zscaler"/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    // DELETED, not blanked: blank means "leave it" throughout this feature, and
    // an empty DeviceVendor makes CEF reconstruction fail outright.
    expect(onChange).toHaveBeenCalledWith({});
  });
});
