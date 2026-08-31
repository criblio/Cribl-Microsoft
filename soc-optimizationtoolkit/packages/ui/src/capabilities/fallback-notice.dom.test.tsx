// @vitest-environment happy-dom
/**
 * Tests for the fallback offer (capability-model-plan step 4).
 *
 * The pins are about TONE and AFFORDANCE as much as content, because the failure
 * mode here is subtle: an offer that reads like an error would talk an operator
 * out of an action Azure has not actually refused. Rule 3 keeps the live control
 * available, so this notice must sit beside it, never replace it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { fallbackFor, IDENTITY_FALLBACK } from "@soc/core";
import { FallbackNotice } from "./fallback-notice";
import {
  FALLBACK_POINTER_LABEL,
  fallbackActionLabel,
  fallbackHint,
  fallbackRunPointer,
  isInlineArtifact,
} from "./fallback-notice-state";
import type { CapabilityFallbackKind } from "@soc/core";

afterEach(cleanup);

const ALL_KINDS: CapabilityFallbackKind[] = [
  "dcr-arm-bodies",
  "table-arm-bodies",
  "arm-template",
  "role-assignment-request",
  "app-registration-request",
  "cribl-pack",
];

describe("copy decisions", () => {
  it("labels every artifact kind", () => {
    for (const kind of ALL_KINDS) {
      expect(fallbackActionLabel(kind), kind).not.toBe("");
    }
  });

  it("separates artifacts produced HERE from those produced by a run", () => {
    // The change requests are built from data the app already holds; the ARM
    // bodies and the pack come out of a run, so the offer must not imply a
    // button here produces them.
    expect(isInlineArtifact("role-assignment-request")).toBe(true);
    expect(isInlineArtifact("app-registration-request")).toBe(true);
    expect(isInlineArtifact("dcr-arm-bodies")).toBe(false);
    expect(isInlineArtifact("cribl-pack")).toBe(false);
  });

  it("says a run makes no live changes, so the offer is safe to take", () => {
    expect(fallbackHint("dcr-arm-bodies")).toContain("no live changes");
  });

  it("names the run for every RUN kind, and none for the kinds made here", () => {
    // HON-7 / D-2. A surface that cannot start the run must still be able to
    // say which one makes the artifact, because the alternative it was reaching
    // for - assembling the body itself - hands over an imitation of something
    // the run resolves against live Azure reads. An inline kind has no run to
    // point at, and saying it does would send someone to the wrong screen.
    for (const kind of ALL_KINDS) {
      const pointer = fallbackRunPointer(kind);
      if (isInlineArtifact(kind)) {
        expect(pointer, kind).toBeNull();
        continue;
      }
      // A named surface is the whole content: "produced by a run somewhere" is
      // what the hint already said and is not actionable.
      expect(pointer, kind).toMatch(/Batch tab|Deploy section/);
    }
  });
});

describe("the notice names the artifact", () => {
  it("renders the catalog's label and handoff wording", () => {
    const fallback = fallbackFor("dcr.write")!;
    render(<FallbackNotice fallback={fallback} />);
    expect(screen.getByText(fallback.label)).toBeTruthy();
    expect(screen.getByText(fallback.action)).toBeTruthy();
  });

  it("shows the blocking reason alongside the remedy", () => {
    render(
      <FallbackNotice
        fallback={fallbackFor("dcr.write")!}
        reason="The connected identity cannot do this."
      />,
    );
    expect(screen.getByText(/cannot do this/)).toBeTruthy();
  });

  it("still names the artifact when this surface cannot produce it", () => {
    // Silence about a blocked action is worse than an offer with no button.
    render(<FallbackNotice fallback={IDENTITY_FALLBACK} />);
    expect(screen.getByText(IDENTITY_FALLBACK.label)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("the offer is an offer, not an error", () => {
  it("produces the artifact when asked", () => {
    const onProduce = vi.fn();
    render(
      <FallbackNotice fallback={fallbackFor("dcr.write")!} onProduce={onProduce} />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onProduce).toHaveBeenCalledOnce();
  });

  it("disables only with a stated reason, never silently", () => {
    render(
      <FallbackNotice
        fallback={fallbackFor("dcr.write")!}
        onProduce={() => {}}
        disabledReason="A run is already in flight."
      />,
    );
    const button = screen.getByRole("button");
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("title")).toContain("already in flight");
  });

  it("labels the control with what the click DOES, not with a promised file", () => {
    // HON-7. Three surfaces wire a producer and one of them can only POINT at
    // the run (the DCR inventory panel builds no ARM bodies of its own). A
    // control reading "Download the ARM request bodies" that answers with a
    // sentence about another screen is the same dishonesty as no control at
    // all, so a pointing surface overrides the label.
    render(
      <FallbackNotice
        fallback={fallbackFor("dcr.write")!}
        onProduce={() => {}}
        produceLabel={FALLBACK_POINTER_LABEL}
      />,
    );
    const button = screen.getByRole("button");
    expect(button.textContent).toBe(FALLBACK_POINTER_LABEL);
    expect(button.textContent).not.toMatch(/Download/);
  });

  it("still promises the download when the surface really produces it", () => {
    // The other half: overriding must stay opt-in, or a producing surface would
    // stop naming what it hands over.
    render(
      <FallbackNotice fallback={fallbackFor("dcr.write")!} onProduce={() => {}} />,
    );
    expect(screen.getByRole("button").textContent).toBe(
      fallbackActionLabel("dcr-arm-bodies"),
    );
  });

  it("carries no error role or alert semantics", () => {
    // It must not announce itself as a failure - the live action is still
    // available, and Azure's 403 is the real gate.
    const { container } = render(
      <FallbackNotice fallback={fallbackFor("dcr.write")!} onProduce={() => {}} />,
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector(".error, .status-failed")).toBeNull();
  });
});
