/**
 * arch-edits - the ONE model of everything a user changes on the dataflow
 * canvas (2026-07-30 "do all of them" ergonomics slice): dragged node
 * positions, per-edge bend waypoints and label offsets, removals, and
 * free-text annotation notes. The canvas edits it, undo/redo snapshots it,
 * localStorage persists it per diagram, and the SVG exporter applies it so
 * what you arranged is what you export.
 */

import type { EdgePoint } from "./arch-layout";

/** One edge's user edits, keyed by the stable edgeKey (from>to). */
export interface EdgeEdit {
  /** Ordered bend waypoints the line routes through. */
  bends: EdgePoint[];
  /** The label pill's drag offset from its computed anchor. */
  labelOffset?: { dx: number; dy: number };
}

/** A free-floating annotation note on the canvas. */
export interface DiagramNote {
  id: string;
  text: string;
  x: number;
  y: number;
}

/** Everything the user changed on the canvas, serializable. */
export interface DiagramEditState {
  /** Dragged node positions (top-left, flow coordinates), by node id. */
  positions: Record<string, { x: number; y: number }>;
  /** Per-edge edits, by edgeKey (from>to). */
  edges: Record<string, EdgeEdit>;
  removedNodes: string[];
  removedEdges: string[];
  notes: DiagramNote[];
}

export function emptyEdits(): DiagramEditState {
  return { positions: {}, edges: {}, removedNodes: [], removedEdges: [], notes: [] };
}

export function isEmptyEdits(state: DiagramEditState): boolean {
  return (
    Object.keys(state.positions).length === 0 &&
    Object.keys(state.edges).length === 0 &&
    state.removedNodes.length === 0 &&
    state.removedEdges.length === 0 &&
    state.notes.length === 0
  );
}

const STORAGE_PREFIX = "soc-dataflow-edits:";

/**
 * Load the persisted edits for a diagram key. Storage failures (sandboxed
 * iframe without storage access, quota, corrupt JSON) degrade to null -
 * arrangements are a convenience, never a dependency.
 */
export function loadEdits(key: string): DiagramEditState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
    if (raw === null) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<DiagramEditState>;
    return {
      positions: parsed.positions ?? {},
      edges: parsed.edges ?? {},
      removedNodes: parsed.removedNodes ?? [],
      removedEdges: parsed.removedEdges ?? [],
      notes: parsed.notes ?? [],
    };
  } catch {
    return null;
  }
}

/**
 * Whether a redraw should discard the in-memory arrangement and reload from
 * storage. Pure so the rule can be stated without a canvas.
 *
 * THE ARRANGEMENT BELONGS TO THE KEY, NOT TO EVERY REDRAW. The diagram object
 * is rebuilt whenever the view state moves - a flow ticked, a pack expanded -
 * and none of that is in the key. Reloading on every rebuild threw away
 * whatever had not yet been written by the 400 ms debounced save, and cleared
 * the undo history that would have recovered it.
 *
 * No key means nothing to reload from, so a new diagram resets: that is the
 * unsaved-canvas case and it is the one time a redraw should start clean.
 */
export function shouldReloadEdits(
  loadedKey: string | undefined,
  nextKey: string | undefined,
): boolean {
  if (nextKey === undefined) return true;
  return loadedKey !== nextKey;
}

/** Persist (or clear, when empty) the edits for a diagram key. */
export function saveEdits(key: string, state: DiagramEditState): void {
  try {
    if (isEmptyEdits(state)) {
      window.localStorage.removeItem(STORAGE_PREFIX + key);
    } else {
      window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(state));
    }
  } catch {
    // Best effort by design.
  }
}
