/**
 * LoggingMapOutline - the Azure Logging Map as an accessible tree (AZR-19,
 * phase 1): the same visible scopes as the canvas, for screen readers,
 * keyboard users and tenants too large to read as a picture.
 *
 * WAI-ARIA tree pattern: role=tree / treeitem / group, aria-level,
 * aria-expanded on items that have children, aria-selected, and a ROVING
 * tabIndex (only the selected item is in the tab order). Arrow keys, Home and
 * End are handled by the pure `outlineKey` in logging-map-state.ts; this
 * component only forwards the key and moves focus to the newly selected item.
 * Selection is the screen's one `selectedScope`, shared with the canvas.
 */

import { useEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";

import {
  hiddenLabel,
  visibleScopes,
  type LoggingMapUiState,
  type UiLoggingMap,
  type VisibleScope,
} from "./logging-map-state";
import { KIND_TAG, isUnreadable } from "./logging-map-copy";

export interface LoggingMapOutlineProps {
  readonly map: UiLoggingMap;
  readonly state: LoggingMapUiState;
  readonly onSelect: (scopeId: string) => void;
  /** A navigation key (ArrowUp/Down/Left/Right, Home, End) for the reducer's outline-key action. */
  readonly onNavigate: (key: string) => void;
}

const NAV_KEYS = new Set(["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"]);

export function LoggingMapOutline({ map, state, onSelect, onNavigate }: LoggingMapOutlineProps) {
  const rows = useMemo(() => visibleScopes(map, state.collapsed, state.folded), [map, state.collapsed, state.folded]);
  const treeRef = useRef<HTMLUListElement>(null);
  const keyed = useRef(false);
  // The roving tab stop: the selected row, or the first row when the selection is not visible.
  const tabStop = rows.some((r) => r.id === state.selectedScope) ? state.selectedScope : (rows[0]?.id ?? null);

  // After a keyboard move, focus follows the selection.
  useEffect(() => {
    if (!keyed.current) return;
    keyed.current = false;
    const items = treeRef.current?.querySelectorAll<HTMLElement>("[data-lm-row]") ?? [];
    for (const el of items) {
      if (el.getAttribute("data-lm-row") === tabStop) {
        el.focus();
        break;
      }
    }
  }, [tabStop, rows]);

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (NAV_KEYS.has(e.key)) {
      e.preventDefault();
      keyed.current = true;
      onNavigate(e.key);
      return;
    }
    if ((e.key === "Enter" || e.key === " ") && tabStop !== null) {
      e.preventDefault();
      onSelect(tabStop);
    }
  };

  const childrenOf = new Map<string | null, VisibleScope[]>();
  const shown = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    const parent = r.parentId !== null && shown.has(r.parentId) ? r.parentId : null;
    const list = childrenOf.get(parent) ?? [];
    list.push(r);
    childrenOf.set(parent, list);
  }

  const renderRow = (r: VisibleScope): ReactNode => {
    const kids = childrenOf.get(r.id) ?? [];
    const n = map.nodesById.get(r.id);
    const setHere = (n?.setHere ?? [])
      .map((k) => map.assignmentsByKey.get(k))
      .filter((a) => a !== undefined);
    const selected = r.id === state.selectedScope;
    return (
      <li
        key={r.id}
        role="treeitem"
        className={selected ? "lm-outline-item is-selected" : "lm-outline-item"}
        data-lm-row={r.id}
        aria-level={r.depth}
        aria-expanded={r.hasChildren ? !r.collapsed : undefined}
        aria-selected={selected}
        tabIndex={r.id === tabStop ? 0 : -1}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(r.id);
        }}
      >
        <span className="lm-outline-row">
          <span className="lm-pill lm-pill-kind">{KIND_TAG[r.node.kind]}</span>
          <span className="lm-outline-name">{r.node.displayName}</span>
          {setHere.slice(0, 3).map((a) => (
            <span
              key={a.assignmentKey}
              className={a.ownership?.owner === "ours" ? "lm-pill lm-pill-ours" : "lm-pill lm-pill-other"}
            >
              {a.assignment.displayName !== "" ? a.assignment.displayName : a.assignment.name}
            </span>
          ))}
          {setHere.length > 3 && <span className="lm-outline-note">{`+${setHere.length - 3} more`}</span>}
          {isUnreadable(map, r.id) && <span className="lm-pill lm-pill-unread">can&apos;t be read</span>}
          {r.collapsed && <span className="lm-outline-note">{`${hiddenLabel(r.hidden)} hidden`}</span>}
          {r.foldedSubscriptions > 0 && (
            <span className="lm-outline-note">
              {`${hiddenLabel({ managementGroups: 0, subscriptions: r.foldedSubscriptions })} folded`}
            </span>
          )}
        </span>
        {kids.length > 0 && (
          <ul role="group" className="lm-outline-group">
            {kids.map(renderRow)}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="lm-outline">
      <ul ref={treeRef} role="tree" aria-label="Management group outline" className="lm-outline-tree" onKeyDown={onKeyDown}>
        {(childrenOf.get(null) ?? []).map(renderRow)}
      </ul>
    </div>
  );
}
