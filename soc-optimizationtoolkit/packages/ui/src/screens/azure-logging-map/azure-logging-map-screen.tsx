/**
 * AzureLoggingMapScreen - the Azure Logging Map (AZR-19, phase 1, READ-ONLY):
 * where each logging policy is assigned in the tenant, what it reaches by
 * inheritance, and where it stops.
 *
 * All reading and judging is the pure @soc/core logging-map domain plus the
 * readLoggingMap usecase; this component drives it through the AzureManagement
 * port (ZERO direct fetch) and renders the result.
 *
 * SHELL DUTIES it owns:
 * - PACING. readLoggingMap runs every ARM call through paceAzureManagement at
 *   60 requests per minute, leaving headroom in the 100 req/min proxy budget
 *   (cribl-app-kit). The clock and the sleep are the shell's, injected.
 * - NO ABORT through the port (azure-management.ts has no signal), so a RUN
 *   TOKEN stands in: every run takes a token; leaving the route or starting a
 *   new run retires it. A retired run's results and progress are dropped, and
 *   its remaining requests are refused locally by a wrapper before they reach
 *   the proxy, so an abandoned read stops spending the budget instead of
 *   finishing in the background.
 * - WORDS FOR WHAT WAS NOT READ: the banner names the scopes above the tree
 *   that were not read (the Tenant Root Group, when refused) and the role that
 *   would reveal them, and the counts say how many reads were refused.
 *
 * The read is started by the operator, not on mount: a tenant read is two
 * requests per scope plus definitions and roles, paced, so it can take
 * minutes and should not be spent on every visit to the route.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  normaliseScopeId,
  readLoggingMap,
  type AzureManagement,
  type LoggingMapProgress,
  type ReadLoggingMapResult,
} from "@soc/core";

import { usePorts } from "../../ports-context";
import {
  initialState,
  loggingMapReducer,
  shownAssignments,
  toolbarCounts,
  type LoggingMapAction,
  type LoggingMapUiState,
  type UiLoggingMap,
} from "./logging-map-state";
import { LoggingMapCanvas } from "./logging-map-canvas";
import { LoggingMapOutline } from "./logging-map-outline";
import { LoggingMapPanel } from "./logging-map-panel";
import { LoggingMapLegend, LoggingMapToolbar, type LoggingMapView } from "./logging-map-toolbar";
import { SCREEN_LEAD, TENANT_ROOT_ROLE } from "./logging-map-copy";

/** Requests per minute for the map read: headroom under the 100 req/min proxy budget. */
export const LOGGING_MAP_REQUESTS_PER_MINUTE = 60;

const PHASE_WORD: Readonly<Record<LoggingMapProgress["phase"], string>> = {
  hierarchy: "management groups",
  subscriptions: "subscriptions",
  scopes: "assignments and exemptions",
  definitions: "policy definitions",
  roles: "identity roles",
};

type Run =
  | { readonly kind: "idle" }
  | { readonly kind: "reading"; readonly progress: LoggingMapProgress | null }
  | { readonly kind: "done"; readonly result: ReadLoggingMapResult; readonly readAt: string }
  | { readonly kind: "failed"; readonly message: string };

/** The error a retired run's requests are refused with, before they reach the proxy. */
const RETIRED = "The map read was abandoned: the screen was left or a new read started.";

/** A port that refuses every call once `live()` turns false. */
function guardedPort(azure: AzureManagement, live: () => boolean): AzureManagement {
  const guarded: AzureManagement = {
    request: (opts) => (live() ? azure.request(opts) : Promise.reject(new Error(RETIRED))),
  };
  const byUrl = azure.requestUrl?.bind(azure);
  if (byUrl !== undefined) {
    guarded.requestUrl = (opts) => (live() ? byUrl(opts) : Promise.reject(new Error(RETIRED)));
  }
  return guarded;
}

function Banner({ result }: { result: ReadLoggingMapResult }) {
  const lines: string[] = [];
  const { start, map } = result;
  const rootNotRead = start.notRead.length > 0;
  if (start.kind === "highest-readable") {
    lines.push(
      rootNotRead
        ? `The Tenant Root Group could not be read, so the tree starts at the highest management groups this identity can see. Anything above them was not read. ${TENANT_ROOT_ROLE} would reveal it.`
        : `No tenant id is set, so the Tenant Root Group was not read; the tree starts at the highest management groups this identity can see. ${TENANT_ROOT_ROLE} would reveal what is above them.`,
    );
  } else if (start.kind === "subscriptions-only") {
    lines.push(
      `${rootNotRead ? "The Tenant Root Group could not be read" : "The Tenant Root Group was not read"}, and no management group could be read either, so subscriptions are shown without their place in the tree. ${TENANT_ROOT_ROLE} would reveal it.`,
    );
  }
  if (map.counts.unreadOrigin > 0) {
    lines.push(
      `${map.counts.unreadOrigin} scope${map.counts.unreadOrigin === 1 ? " was" : "s were"} seen only as the origin of an inherited assignment and could not be read.`,
    );
  }
  if (map.counts.parentUnknown > 0) {
    lines.push(
      `${map.counts.parentUnknown} subscription${map.counts.parentUnknown === 1 ? "'s" : "s'"} parent management group was not read, so ${map.counts.parentUnknown === 1 ? "it hangs" : "they hang"} under "Parent not read".`,
    );
  }
  if (result.subscriptions.kind === "empty") {
    lines.push(
      "No subscription could be listed. That list is filtered by permission, so subscriptions may exist that this identity cannot see.",
    );
  }
  if (lines.length === 0) return null;
  return (
    <div className="lm-banner" role="status" data-lm-banner="">
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
    </div>
  );
}

export function AzureLoggingMapScreen() {
  const { ports, config } = usePorts();
  const tenantId = config.tenantId.trim();
  const [run, setRun] = useState<Run>({ kind: "idle" });
  const [ui, setUi] = useState<LoggingMapUiState | null>(null);
  const [view, setView] = useState<LoggingMapView>("diagram");
  const tokenRef = useRef(0);

  // Leaving the route retires the run in flight.
  useEffect(() => {
    return () => {
      tokenRef.current += 1;
    };
  }, []);

  // A connection change (another port or tenant) retires the run in flight
  // too, and drops a map read against the old connection: neither describes
  // the connection now in use. The first render is not a change.
  const connectionRef = useRef({ azure: ports.azure, tenantId });
  useEffect(() => {
    const prev = connectionRef.current;
    if (prev.azure === ports.azure && prev.tenantId === tenantId) return;
    connectionRef.current = { azure: ports.azure, tenantId };
    tokenRef.current += 1;
    setRun({ kind: "idle" });
    setUi(null);
  }, [ports.azure, tenantId]);

  const start = useCallback(async () => {
    tokenRef.current += 1;
    const token = tokenRef.current;
    const live = () => tokenRef.current === token;
    setRun({ kind: "reading", progress: null });
    setUi(null);
    try {
      const readAt = new Date().toISOString();
      const result = await readLoggingMap({
        azure: guardedPort(ports.azure, live),
        tenantId,
        now: readAt,
        pacing: {
          maxRequestsPerMinute: LOGGING_MAP_REQUESTS_PER_MINUTE,
          now: () => Date.now(),
          sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        },
        onProgress: (progress) => {
          if (live()) setRun({ kind: "reading", progress });
        },
      });
      if (!live()) return;
      setUi(initialState(result.map));
      setRun({ kind: "done", result, readAt });
    } catch (err) {
      if (!live()) return;
      setRun({ kind: "failed", message: err instanceof Error ? err.message : String(err) });
    }
  }, [ports.azure, tenantId]);

  const map: UiLoggingMap | null = run.kind === "done" ? run.result.map : null;
  const dispatch = useCallback(
    (action: LoggingMapAction) => setUi((prev) => (prev === null ? prev : loggingMapReducer(prev, action))),
    [],
  );

  const counts = useMemo(
    () => (map !== null && ui !== null && run.kind === "done" ? toolbarCounts(map, ui, run.result.refusals) : null),
    [map, ui, run],
  );
  const traceOptions = useMemo(
    () => (map !== null && ui !== null ? shownAssignments(map, ui) : []),
    [map, ui],
  );

  const reading = run.kind === "reading";

  return (
    <div className="lm-screen">
      <p className="lm-lead">{SCREEN_LEAD}</p>
      {tenantId === "" && (
        <p className="lm-note lm-note-unknown" data-lm-no-tenant="">
          No tenant id is set for this connection, so the Tenant Root Group cannot be read. The map will start from
          the management groups this identity can see.
        </p>
      )}
      <div className="lm-run">
        <button type="button" className="lm-btn lm-btn-primary" disabled={reading} onClick={() => void start()}>
          {run.kind === "done" || run.kind === "failed" ? "Read again" : "Read the logging map"}
        </button>
        {reading && (
          <span className="lm-progress" role="status">
            {run.progress === null
              ? "Starting the read..."
              : `Read ${run.progress.done} of ${run.progress.total}: ${PHASE_WORD[run.progress.phase]}`}
          </span>
        )}
        {run.kind === "idle" && (
          <span className="lm-note">
            Reads only; nothing in Azure is changed. Reads are paced at {LOGGING_MAP_REQUESTS_PER_MINUTE} a minute, so
            a large tenant takes a few minutes.
          </span>
        )}
        {run.kind === "failed" && (
          <span className="lm-note lm-note-unknown" role="alert">{`The map could not be read: ${run.message}`}</span>
        )}
      </div>

      {run.kind === "done" && map !== null && ui !== null && counts !== null && (
        <div className="lm-mock">
          <LoggingMapToolbar
            view={view}
            onView={setView}
            state={ui}
            counts={counts}
            traceOptions={traceOptions}
            onTrace={(key) => dispatch({ type: "trace", assignmentKey: key, map })}
            onShowInherited={(value) => dispatch({ type: "set-show-inherited", value })}
            onShowAll={(value) => dispatch({ type: "set-show-all", value })}
            onSearch={(query) => dispatch({ type: "search", query, map })}
          />
          <Banner result={run.result} />
          <div className="lm-body">
            <div className="lm-stage">
              {view === "diagram" ? (
                <LoggingMapCanvas
                  map={map}
                  state={ui}
                  onSelect={(scopeId) => dispatch({ type: "select", scopeId })}
                  onToggleCollapsed={(scopeId) => dispatch({ type: "toggle-collapsed", scopeId, map })}
                  onToggleFolded={(scopeId) => dispatch({ type: "toggle-folded", scopeId, map })}
                />
              ) : (
                <LoggingMapOutline
                  map={map}
                  state={ui}
                  onSelect={(scopeId) => dispatch({ type: "select", scopeId })}
                  onNavigate={(key) => dispatch({ type: "outline-key", key, map })}
                />
              )}
            </div>
            <LoggingMapPanel
              map={map}
              state={ui}
              now={run.readAt}
              onTrace={(key) => dispatch({ type: "trace", assignmentKey: key, map })}
              onSelect={(scopeId) => {
                dispatch({ type: "expand-path", scopeId: normaliseScopeId(scopeId), map });
                dispatch({ type: "select", scopeId });
              }}
            />
          </div>
          <LoggingMapLegend />
        </div>
      )}
    </div>
  );
}
