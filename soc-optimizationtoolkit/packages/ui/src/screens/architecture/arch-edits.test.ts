// Pins for the canvas-arrangement reload rule.
//
// The defect these exist for (2026-08-26): the reload effect was keyed on the
// diagram OBJECT as well as the storage key, and the diagram is rebuilt on
// every view toggle - a flow ticked, a pack expanded - none of which is in the
// key. So a redraw reloaded from storage and cleared undo/redo. Since the save
// is debounced by 400 ms and its cleanup cancels the pending write, a node
// dragged inside that window was never persisted AND its history was gone:
// drag, tick a flow, lose the drag with nothing to undo.

import { describe, expect, it } from "vitest";
import { shouldReloadEdits } from "./arch-edits";

describe("shouldReloadEdits", () => {
  it("does NOT reload when the key is unchanged", () => {
    // The whole defect in one line. Every redraw arrived here with the same key.
    expect(shouldReloadEdits("live:g1:all", "live:g1:all")).toBe(false);
  });

  it("reloads when the key changes", () => {
    // A different worker group, or the Azure filter flipped, is a different
    // picture and legitimately has its own saved arrangement.
    expect(shouldReloadEdits("live:g1:all", "live:g1:az")).toBe(true);
    expect(shouldReloadEdits("live:g1:all", "live:g2:all")).toBe(true);
  });

  it("reloads on the first render, when nothing has been loaded yet", () => {
    expect(shouldReloadEdits(undefined, "live:g1:all")).toBe(true);
  });

  it("always resets when there is no key to reload from", () => {
    // The unsaved-canvas case: nothing was persisted, so a new diagram starts
    // clean. This is the one time a redraw SHOULD discard the arrangement, and
    // the fix must not take it away.
    expect(shouldReloadEdits(undefined, undefined)).toBe(true);
    expect(shouldReloadEdits("live:g1:all", undefined)).toBe(true);
  });
});
