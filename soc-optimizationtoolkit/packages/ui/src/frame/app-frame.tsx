/**
 * AppFrame - the shared application chrome both shells mount once the
 * acceptance gate and mode selection have passed: a sidebar built from a
 * route table, a mode chip, and a content area.
 *
 * Navigation is DERIVED, never duplicated: the visible items come from
 * @soc/core's filterNavItems over the routes' `requires` declarations, so the
 * nav can never disagree with the mode's capability predicates (the legacy
 * sidebar reimplemented the mode logic inline and was one of four independent
 * mode reads). Unit 6.5 adds SECTION grouping (journey steps first, then
 * tools, then diagnostics - ux-flow-plan 4.4): pure presentation applied
 * AFTER the one filterNavItems pass, so mode filtering is untouched.
 *
 * The frame is presentation only: the SHELL owns mode persistence and passes
 * the resolved mode down; screens keep doing their IO through PortsContext.
 * `topBar` is the shell-chrome slot rendered above the active screen (the
 * cloud shell's connection bar lives there). Theming: the shell resolves the
 * user's light/dark/system choice and passes it via `themeControl`; the
 * frame sets data-theme on its root wrapper (the stylesheet's
 * [data-theme='dark'] token override does the rest) and renders the
 * ThemeToggle at the top of the content area.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { filterNavItems } from "@soc/core";
import type { AppMode, NavRequirement } from "@soc/core";
import {
  MODE_LABELS,
  NAV_SECTION_LABELS,
  groupNavSections,
} from "./frame-state";
import type { NavSection } from "./frame-state";
import { ThemeToggle } from "./theme-toggle";
import type { ThemeControl } from "./theme-toggle";

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
  /** Sidebar section (ux-flow-plan 4.4); defaults to 'tools'. */
  section?: NavSection;
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
  /**
   * Shell-provided theme wiring. When present the frame sets data-theme to
   * the shell-resolved theme on its root wrapper and renders the topBar
   * ThemeToggle. Absent = light rendering, no toggle.
   */
  themeControl?: ThemeControl;
}

export function AppFrame(props: AppFrameProps) {
  const {
    title,
    subtitle,
    mode,
    routes,
    topBar,
    footerNote,
    initialRouteId,
    themeControl,
  } = props;
  const [routeId, setRouteId] = useState(initialRouteId ?? "");
  const [resetNonces, setResetNonces] = useState<Record<string, number>>({});

  const navigate = useCallback((id: string) => setRouteId(id), []);
  const nav = useMemo<AppFrameNav>(() => ({ navigate }), [navigate]);

  // Filter, then fall back: if the requested route is hidden by the current
  // mode (or unknown), the first visible route renders instead - the frame
  // never shows a screen the mode cannot use. ONE filterNavItems pass;
  // grouping below is presentation only.
  const visible = filterNavItems(mode, routes);
  const active = visible.find((route) => route.id === routeId) ?? visible[0];
  const activeId = active?.id;
  const sections = groupNavSections(visible);

  // Keep-alive: once a route becomes active it stays MOUNTED (hidden when
  // inactive) so its local state survives navigation - bouncing to another
  // screen and back no longer resets the page. Routes mount only on FIRST visit
  // (never eagerly), so unvisited screens run no data-loading effects. The ref
  // accumulates visited ids idempotently; reading it during render is safe.
  const visitedRef = useRef<Set<string>>(new Set());
  if (activeId !== undefined) {
    visitedRef.current.add(activeId);
  }
  const mounted = visible.filter((route) => visitedRef.current.has(route.id));

  // "Start over" remounts the active screen fresh by bumping its reset nonce:
  // the wrapper key changes, so React discards the old instance (and its state)
  // and re-runs the screen's default-loading effects.
  const startOver = useCallback(() => {
    if (activeId === undefined) {
      return;
    }
    setResetNonces((prev) => ({ ...prev, [activeId]: (prev[activeId] ?? 0) + 1 }));
  }, [activeId]);

  return (
    <div className="app-frame" data-theme={themeControl?.resolvedTheme}>
      <aside className="app-frame-sidebar">
        <div className="app-frame-brand">
          <div className="app-frame-title">{title}</div>
          {subtitle !== undefined && (
            <div className="app-frame-subtitle">{subtitle}</div>
          )}
        </div>
        <nav className="app-frame-nav">
          {sections.map((group) => (
            <div className="app-frame-nav-section" key={group.section}>
              <div className="app-frame-nav-section-label">
                {NAV_SECTION_LABELS[group.section]}
              </div>
              {group.items.map((route) => (
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
            </div>
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
          <div className="app-frame-theme-row">
            {themeControl !== undefined && (
              <ThemeToggle
                theme={themeControl.theme}
                resolvedTheme={themeControl.resolvedTheme}
                onThemeChange={themeControl.onThemeChange}
              />
            )}
            {activeId !== undefined && (
              <button
                type="button"
                className="app-frame-startover"
                title="Clear this page's inputs and reload it with defaults."
                onClick={startOver}
              >
                Start over
              </button>
            )}
          </div>
          {topBar}
          {active === undefined ? (
            <p className="panel-desc">
              No screens are available in this mode. Reconfigure the mode from
              Settings.
            </p>
          ) : (
            mounted.map((route) => {
              const isActive = route.id === activeId;
              return (
                <div
                  key={`${route.id}:${resetNonces[route.id] ?? 0}`}
                  className="app-frame-route"
                  style={isActive ? undefined : { display: "none" }}
                  {...(isActive ? {} : { "aria-hidden": true })}
                >
                  {route.render(nav)}
                </div>
              );
            })
          )}
        </div>
      </main>
    </div>
  );
}
