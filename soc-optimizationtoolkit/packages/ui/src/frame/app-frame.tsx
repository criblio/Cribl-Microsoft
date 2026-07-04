/**
 * AppFrame - the shared application chrome both shells mount once the
 * acceptance gate and mode selection have passed: a sidebar built from a
 * route table, a mode chip, and a content area.
 *
 * Navigation is DERIVED, never duplicated: the visible items come from
 * @soc/core's filterNavItems over the routes' `requires` declarations, so the
 * nav can never disagree with the mode's capability predicates (the legacy
 * sidebar reimplemented the mode logic inline and was one of four independent
 * mode reads).
 *
 * The frame is presentation only: the SHELL owns mode persistence and passes
 * the resolved mode down; screens keep doing their IO through PortsContext.
 * `topBar` is the shell-chrome slot rendered above the active screen (the
 * cloud shell's connection bar lives there).
 */

import { useState } from "react";
import type { ReactNode } from "react";
import { filterNavItems } from "@soc/core";
import type { AppMode, NavRequirement } from "@soc/core";
import { MODE_LABELS } from "./frame-state";

/** Handed to route renderers so screen content can switch screens. */
export interface AppFrameNav {
  /**
   * Show the route with this id. Navigating to a route the current mode
   * hides falls back to the first visible route.
   */
  navigate: (routeId: string) => void;
}

/** One entry in the frame's route table. */
export interface AppRoute {
  /** Stable identifier (used by navigate and the active highlight). */
  id: string;
  /** Sidebar label. */
  label: string;
  /** What the route needs before it is shown; filtered by the active mode. */
  requires: NavRequirement;
  /** Render the route's content. */
  render: (nav: AppFrameNav) => ReactNode;
}

export interface AppFrameProps {
  /** Product name shown in the sidebar brand block. */
  title: string;
  /** Shell identifier under the title (e.g. "Cribl.Cloud shell"). */
  subtitle?: string;
  /** The ACTIVE mode; the shell resolves it before mounting the frame. */
  mode: AppMode;
  /** The full route table; the frame filters it by mode. */
  routes: readonly AppRoute[];
  /** Shell chrome rendered above the active screen (e.g. connection bar). */
  topBar?: ReactNode;
  /** Small line in the sidebar footer (e.g. version). */
  footerNote?: string;
  /** Route to show first; falls back to the first visible route. */
  initialRouteId?: string;
}

export function AppFrame(props: AppFrameProps) {
  const { title, subtitle, mode, routes, topBar, footerNote, initialRouteId } =
    props;
  const [routeId, setRouteId] = useState(initialRouteId ?? "");

  // Filter, then fall back: if the requested route is hidden by the current
  // mode (or unknown), the first visible route renders instead - the frame
  // never shows a screen the mode cannot use.
  const visible = filterNavItems(mode, routes);
  const active = visible.find((route) => route.id === routeId) ?? visible[0];
  const nav: AppFrameNav = { navigate: setRouteId };

  return (
    <div className="app-frame">
      <aside className="app-frame-sidebar">
        <div className="app-frame-brand">
          <div className="app-frame-title">{title}</div>
          {subtitle !== undefined && (
            <div className="app-frame-subtitle">{subtitle}</div>
          )}
        </div>
        <nav className="app-frame-nav">
          {visible.map((route) => (
            <button
              key={route.id}
              className={`app-frame-nav-item${
                route.id === active?.id ? " app-frame-nav-item-active" : ""
              }`}
              onClick={() => setRouteId(route.id)}
            >
              {route.label}
            </button>
          ))}
        </nav>
        <div className="app-frame-footer">
          {footerNote !== undefined && (
            <span className="app-frame-footer-note">{footerNote}</span>
          )}
          <span
            className={`mode-chip mode-chip-${mode}`}
            title="The active operating mode. Change it from Settings (Reconfigure)."
          >
            {MODE_LABELS[mode]}
          </span>
        </div>
      </aside>
      <main className="app-frame-main">
        <div className="app-frame-content">
          {topBar}
          {active !== undefined ? (
            active.render(nav)
          ) : (
            <p className="panel-desc">
              No screens are available in this mode. Reconfigure the mode from
              Settings.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
