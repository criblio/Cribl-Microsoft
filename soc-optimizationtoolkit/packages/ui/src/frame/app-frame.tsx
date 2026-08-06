/**
 * AppFrame - the shared application chrome both shells mount once the
 * acceptance gate and mode selection have passed: a sidebar built from a
 * route table, a mode chip, and a content area.
 *
 * Navigation ANNOTATES, it does not filter (capability-model-plan step 3). The
 * nav renders EVERY route in the table and marks what is unavailable and why,
 * from @soc/core's annotateNavItems over the routes' `requires` capabilities.
 * This inverts what the frame used to do - filterNavItems REMOVED what the mode
 * could not use - and the rule is now the opposite: an operator who declines
 * every permission still sees the whole product.
 *
 * Nothing here is ever DISABLED either. The audit informs and offers; Azure's
 * own 403 is the real gate, so an annotated route stays clickable and a stale or
 * wrong audit costs an annotation rather than the ability to work.
 *
 * Unit 6.5's SECTION grouping (journey steps first, then tools, then
 * diagnostics - ux-flow-plan 4.4) is pure presentation over the same full list.
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

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { annotateNavItems, emptyCapabilitySet } from "@soc/core";
import type { Capability, CapabilityContext, CapabilitySet } from "@soc/core";
import type { AppMode } from "@soc/core";
import {
  MODE_LABELS,
  NAV_FLAG_LABELS,
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
  /**
   * Whether the active mode currently shows this route - lets a screen HIDE
   * a cross-link instead of navigating into the fallback (2026-07-29, the
   * architecture deploy buttons).
   */
  canNavigate: (routeId: string) => boolean;
}

/** One entry in the frame's route table. */
export interface AppRoute {
  /** Stable identifier (used by navigate and the active highlight). */
  id: string;
  /** Sidebar label. */
  label: string;
  /**
   * Every capability the route needs. EMPTY means always available - the
   * generation-only surfaces that work with no connection at all.
   *
   * This NO LONGER decides whether the route is shown (capability-model-plan
   * step 3): every route appears, annotated with what is unavailable and why.
   */
  requires: readonly Capability[];
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
  /**
   * The full route table. EVERY entry renders in the nav - the frame annotates
   * rather than filters (capability-model-plan step 3).
   */
  routes: readonly AppRoute[];
  /**
   * What the connected identity was measured to be able to do. Absent (or
   * unaudited) is fine and reads honestly as "not checked yet" - the audit
   * informs, it never gates.
   */
  capabilities?: CapabilitySet;
  /**
   * The connection facts that resolve anything unmeasured. Absent is treated as
   * both sides connected, so unmeasured capabilities read "not checked yet"
   * rather than claiming a connection failure nothing established.
   */
  capabilityContext?: CapabilityContext;
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
    capabilities,
    capabilityContext,
    topBar,
    footerNote,
    initialRouteId,
    themeControl,
  } = props;
  const [routeId, setRouteId] = useState(initialRouteId ?? "");

  // ANNOTATE, never filter (capability-model-plan step 3). Every route reaches
  // the nav; what changes is the note beside it. This is the inversion of the
  // old filterNavItems pass, which removed what the mode could not use.
  const annotated = annotateNavItems(
    routes,
    capabilities ?? emptyCapabilitySet(),
    capabilityContext ?? { azureIdentityPresent: true, criblReachable: true },
  );
  const annotationById = new Map(
    annotated.map((entry) => [entry.item.id, entry] as const),
  );

  const navigate = useCallback((id: string) => setRouteId(id), []);
  // Every route in the table is navigable now that none are hidden. canNavigate
  // answers "does this route exist here?" - the honest question once capability
  // no longer removes anything, and the one cross-linking screens actually need.
  const routeIdKey = routes.map((route) => route.id).join(",");
  const nav = useMemo<AppFrameNav>(() => {
    const ids = new Set(routeIdKey.split(",").filter((id) => id !== ""));
    return { navigate, canNavigate: (id: string) => ids.has(id) };
  }, [navigate, routeIdKey]);
  const active = routes.find((route) => route.id === routeId) ?? routes[0];
  const activeId = active?.id;
  const sections = groupNavSections(routes);

  // Keep-alive: once a route becomes active it stays MOUNTED (hidden when
  // inactive) so its local state survives navigation - bouncing to another
  // screen and back no longer resets the page. Routes mount only on FIRST visit
  // (never eagerly), so unvisited screens run no data-loading effects. The ref
  // accumulates visited ids idempotently; reading it during render is safe.
  const visitedRef = useRef<Set<string>>(new Set());
  if (activeId !== undefined) {
    visitedRef.current.add(activeId);
  }
  const mounted = routes.filter((route) => visitedRef.current.has(route.id));

  // A route change opens the new screen at ITS top. Because routes stay
  // MOUNTED (keep-alive above) the window keeps whatever offset the previous
  // screen was scrolled to, so navigating from a scrolled page used to land
  // mid-content on the next one. Layout effect, so the jump happens before
  // paint rather than as a visible snap. The FIRST resolved route is skipped:
  // the page already loads at the top, and skipping leaves any inbound deep
  // link free to position itself. Home's next-action anchor scroll runs on a
  // 60ms timeout after navigating, so it still lands where it intends.
  const scrolledRouteRef = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (activeId === undefined || scrolledRouteRef.current === activeId) {
      return;
    }
    const isFirstRoute = scrolledRouteRef.current === undefined;
    scrolledRouteRef.current = activeId;
    if (!isFirstRoute) {
      window.scrollTo({ top: 0 });
    }
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
              {group.items.map((route) => {
                const entry = annotationById.get(route.id);
                const availability = entry?.availability ?? "available";
                // Every route stays CLICKABLE. The audit informs and offers; it
                // never forbids, and Azure's own 403 is the real gate.
                return (
                  <button
                    key={route.id}
                    className={
                      `app-frame-nav-item` +
                      (route.id === active?.id ? " app-frame-nav-item-active" : "") +
                      (availability === "available"
                        ? ""
                        : ` app-frame-nav-item-${availability}`)
                    }
                    onClick={() => setRouteId(route.id)}
                    title={entry?.reason ?? undefined}
                  >
                    <span className="app-frame-nav-item-label">{route.label}</span>
                    {availability !== "available" && (
                      <span
                        className={`app-frame-nav-flag app-frame-nav-flag-${availability}`}
                      >
                        {NAV_FLAG_LABELS[availability]}
                      </span>
                    )}
                  </button>
                );
              })}
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
          </div>
          {topBar}
          {active === undefined ? (
            // Only reachable with an EMPTY route table, which is a shell wiring
            // bug rather than a runtime state - capability can no longer empty
            // the nav, because it no longer removes anything from it.
            <p className="panel-desc">No screens are registered.</p>
          ) : (
            mounted.map((route) => {
              const isActive = route.id === activeId;
              return (
                <div
                  key={route.id}
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
