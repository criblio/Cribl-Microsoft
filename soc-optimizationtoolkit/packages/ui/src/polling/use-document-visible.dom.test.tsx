// @vitest-environment happy-dom
/**
 * Pins for useDocumentVisible (AZR-33): it must FLIP on visibilitychange,
 * because a screen poll gates on it to stop spending the request budget in a
 * hidden tab. A hook that read visibility once on mount would pass a
 * "starts visible" check and never pause.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { useDocumentVisible } from "./use-document-visible";

let state: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", {
  configurable: true,
  get: () => state,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  state = "visible";
});

function Probe(props: { onValue: (v: boolean) => void }): ReactNode {
  props.onValue(useDocumentVisible());
  return null;
}

function setVisibility(next: DocumentVisibilityState): void {
  state = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useDocumentVisible", () => {
  it("flips with visibilitychange", () => {
    let value: boolean | undefined;
    render(<Probe onValue={(v) => (value = v)} />);
    expect(value).toBe(true);
    act(() => setVisibility("hidden"));
    expect(value).toBe(false);
    act(() => setVisibility("visible"));
    expect(value).toBe(true);
  });

  it("starts hidden when the document is hidden at mount", () => {
    state = "hidden";
    let value: boolean | undefined;
    render(<Probe onValue={(v) => (value = v)} />);
    expect(value).toBe(false);
  });

  it("removes the exact visibilitychange listener it added on unmount", () => {
    // A re-render-based check cannot fail here: an unmounted Probe never
    // renders again, leaked listener or not. Pin the add/remove pairing.
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const view = render(<Probe onValue={() => undefined} />);
    const added = addSpy.mock.calls.filter((c) => c[0] === "visibilitychange");
    expect(added).toHaveLength(1);
    const handler = added[0]?.[1];
    expect(removeSpy.mock.calls.filter((c) => c[0] === "visibilitychange")).toHaveLength(0);
    view.unmount();
    const removed = removeSpy.mock.calls.filter((c) => c[0] === "visibilitychange");
    expect(removed).toHaveLength(1);
    expect(removed[0]?.[1]).toBe(handler);
  });
});
