/**
 * SolutionBrowser - the lazy Microsoft Sentinel solution browser (porting-plan
 * Unit 14 UI; GUI-04 redesigned, GUI-05). The successor to the legacy flagship's
 * solution list, rebuilt for the LAZY-FETCH workflow (legacy-flow-analysis.md):
 *
 *   - The list is the lightweight index from the SentinelContent port (ONE
 *     contents call), cached by commit SHA - NOT a bulk mirror.
 *   - Search + a hide-deprecated toggle + honest counts (total / active /
 *     deprecated), with a DEPRECATED badge and its reason per flagged solution.
 *   - SELECTING a solution triggers an on-demand, per-solution fetch (a spinner
 *     on that row, never a bulk-mirror progress bar): its connector files are
 *     listed and decoded to the log types it carries, cached by solution+commit.
 *   - The deep-link contract `#/?solution=<name>` is READ on mount to preselect
 *     (Unit 26 relies on it) and shown as a shareable link for the selection.
 *
 * All decision logic is the pure browser-state module; this component only
 * renders and drives IO through the content ports in PortsContext (ZERO direct
 * fetch here). When the content ports are unbound (a shell/mode without content)
 * it renders an always-visible unavailable state.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  connectorsCacheKey,
  decodeConnector,
  solutionIndexCacheKey,
  toVendorLogTypes,
} from "@soc/core";
import type { SolutionRef } from "@soc/core";
import { usePorts } from "../../ports-context";
import {
  buildSolutionDeepLink,
  deprecationBadge,
  filterSolutions,
  parseSolutionDeepLink,
  resolveSelectedSolution,
  solutionCounts,
} from "./browser-state";

export interface SolutionBrowserProps {
  /**
   * Reports the current selection (or null when cleared) so a host - the
   * Integrate arc's Solution section - can complete the section and light its
   * readiness pill. Called on every selection change.
   */
  onSelect?: (solution: SolutionRef | null) => void;
}

// The cap on how many connector files a selected solution decodes for the
// log-type preview - keeps a solution with many connectors well under the
// 100 req/min budget (each connector is one raw fetch).
const CONNECTOR_DECODE_CAP = 5;

// The cached per-solution detail (parsed result cached by solution+commit).
interface SolutionDetail {
  connectorCount: number;
  logTypes: string[];
}

type DetailState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "loaded"; detail: SolutionDetail }
  | { phase: "error"; message: string };

export function SolutionBrowser({ onSelect }: SolutionBrowserProps) {
  const { ports } = usePorts();
  const content = ports.content;
  const cache = ports.contentCache;

  const [solutions, setSolutions] = useState<SolutionRef[] | null>(null);
  const [commitSha, setCommitSha] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [hideDeprecated, setHideDeprecated] = useState(false);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState>({ phase: "idle" });

  // The deep-link name to preselect once the index loads (read ONCE on mount -
  // the preserved Unit 26 `#/?solution=` contract).
  const [deepLinkName] = useState<string | null>(() =>
    typeof window !== "undefined"
      ? parseSolutionDeepLink(window.location.hash)
      : null,
  );

  // Load the solution index lazily: resolve the HEAD commit (the cache stamp),
  // then read the cached index for that commit or fetch it once and cache it.
  const loadIndex = useCallback(async () => {
    if (content === undefined) {
      return;
    }
    setSolutions(null);
    setLoadError("");
    try {
      const sha = (await content.getCommitSha()) ?? "";
      setCommitSha(sha);
      const indexKey = solutionIndexCacheKey(sha);
      let list: SolutionRef[] | null = null;
      if (cache !== undefined) {
        const cached = await cache.get(indexKey);
        if (Array.isArray(cached)) {
          list = cached as SolutionRef[];
        }
      }
      if (list === null) {
        list = await content.listSolutions();
        if (cache !== undefined) {
          await cache.set(indexKey, list);
        }
      }
      setSolutions(list);
    } catch (err) {
      setLoadError(String(err));
    }
  }, [content, cache]);

  useEffect(() => {
    void loadIndex();
  }, [loadIndex]);

  // Fetch (and cache) one solution's connector detail on demand.
  const loadDetail = useCallback(
    async (name: string) => {
      if (content === undefined) {
        return;
      }
      setDetail({ phase: "loading" });
      try {
        const cacheKey = connectorsCacheKey(name, commitSha ?? "");
        if (cache !== undefined) {
          const cached = await cache.get(cacheKey);
          if (
            cached !== null &&
            typeof cached === "object" &&
            Array.isArray((cached as SolutionDetail).logTypes)
          ) {
            setDetail({ phase: "loaded", detail: cached as SolutionDetail });
            return;
          }
        }
        const files = await content.listConnectorFiles(name);
        const logTypes = new Set<string>();
        for (const file of files.slice(0, CONNECTOR_DECODE_CAP)) {
          const text = await content.readFile(file.path);
          if (text === null) {
            continue;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            continue;
          }
          const decoded = decodeConnector(parsed, file.path);
          for (const vlt of toVendorLogTypes(decoded)) {
            logTypes.add(vlt.name);
          }
        }
        const built: SolutionDetail = {
          connectorCount: files.length,
          logTypes: [...logTypes].sort((a, b) => a.localeCompare(b)),
        };
        if (cache !== undefined) {
          await cache.set(cacheKey, built);
        }
        setDetail({ phase: "loaded", detail: built });
      } catch (err) {
        setDetail({ phase: "error", message: String(err) });
      }
    },
    [content, cache, commitSha],
  );

  // Select a solution: record the name and report up. The detail fetch is
  // driven by the selectedName effect below, so selection and its lazy fetch
  // stay decoupled (and a deep-linked preselect fetches the same way).
  const select = useCallback(
    (solution: SolutionRef) => {
      setSelectedName(solution.name);
      onSelect?.(solution);
      // Persist the selection in the URL hash so a full page refresh restores
      // it (the on-mount deep-link read re-selects it), keeping the solution in
      // sync with the samples that already persist in the store.
      if (typeof window !== "undefined") {
        window.location.hash = buildSolutionDeepLink(solution.name);
      }
    },
    [onSelect],
  );

  const clearSelection = useCallback(() => {
    setSelectedName(null);
    setDetail({ phase: "idle" });
    onSelect?.(null);
    if (typeof window !== "undefined") {
      window.location.hash = "#/";
    }
  }, [onSelect]);

  // Lazily fetch the selected solution's detail whenever the selection changes.
  useEffect(() => {
    if (selectedName !== null) {
      void loadDetail(selectedName);
    }
  }, [selectedName, loadDetail]);

  // Once the index is present, honor a deep-linked solution ONCE (the preserved
  // `#/?solution=` contract). Sets the selection like a click; the effect above
  // then fetches its detail.
  useEffect(() => {
    if (solutions === null || deepLinkName === null || selectedName !== null) {
      return;
    }
    const match = resolveSelectedSolution(solutions, deepLinkName);
    if (match !== null) {
      select(match);
    }
  }, [solutions, deepLinkName, selectedName, select]);

  const counts = useMemo(
    () => (solutions === null ? null : solutionCounts(solutions)),
    [solutions],
  );
  const visible = useMemo(
    () =>
      solutions === null
        ? []
        : filterSolutions(solutions, { query, hideDeprecated }),
    [solutions, query, hideDeprecated],
  );
  const selected = useMemo(
    () => resolveSelectedSolution(solutions ?? [], selectedName),
    [solutions, selectedName],
  );

  if (content === undefined) {
    return (
      <div className="discovery-result">
        <span className="field-label">Sentinel solution</span>
        <p className="panel-desc">
          Content browsing is not available in this mode - it needs a live
          GitHub connection. Add a GitHub token in Repositories settings to
          browse solutions.
        </p>
      </div>
    );
  }

  return (
    <div className="solution-browser">
      {loadError !== "" ? (
        <div className="discovery-result">
          <p className="field-hint">
            Could not load the solution index: {loadError}
          </p>
          <p className="panel-desc">
            This usually means no GitHub token is set (or it was rejected). Add
            or replace your token in Repositories settings, then retry.
          </p>
          <div className="panel-controls">
            <button className="run-button" onClick={() => void loadIndex()}>
              Retry
            </button>
          </div>
        </div>
      ) : solutions === null ? (
        <p className="field-hint">
          Loading the solution index...
          {deepLinkName !== null ? ` (restoring ${deepLinkName})` : ""}
        </p>
      ) : selected !== null ? (
        // SELECTED VIEW: a selection switches the section to this card and
        // hides the browse list - clear it before choosing another solution.
        <div className="discovery-result solution-browser-selected">
          <span className="field-label">Selected solution</span>
          <div className="solution-browser-selected-head">
            <span className="solution-browser-selected-name">
              {selected.name}
            </span>
            {(() => {
              const badge = deprecationBadge(selected);
              return badge !== null ? (
                <span className="solution-browser-badge" title={badge.reason}>
                  {badge.label}
                </span>
              ) : null;
            })()}
          </div>
          {(() => {
            const badge = deprecationBadge(selected);
            return badge !== null ? (
              <p className="solution-browser-deprecation">{badge.reason}</p>
            ) : null;
          })()}
          {detail.phase === "loading" && (
            <div className="status-bar status-bar-checking">
              <span className="status-bar-dot" />
              <span className="status-bar-text">
                Fetching {selected.name} content...
              </span>
            </div>
          )}
          {detail.phase === "error" && (
            <div className="status-bar status-bar-error">
              <span className="status-bar-dot" />
              <span className="status-bar-text">
                Could not fetch this solution: {detail.message}
              </span>
            </div>
          )}
          {detail.phase === "loaded" && (
            <>
              <span className="field-hint">
                {detail.detail.connectorCount} connector file
                {detail.detail.connectorCount === 1 ? "" : "s"};{" "}
                {detail.detail.logTypes.length} log type
                {detail.detail.logTypes.length === 1 ? "" : "s"} detected
                {detail.detail.logTypes.length > 0
                  ? `: ${detail.detail.logTypes.join(", ")}`
                  : "."}
              </span>
              <span className="field-hint solution-browser-deeplink">
                Deep link:{" "}
                <code className="code-chip">
                  {buildSolutionDeepLink(selected.name)}
                </code>
              </span>
            </>
          )}
          <div className="panel-controls">
            <button className="run-button" onClick={clearSelection}>
              Clear selection
            </button>
          </div>
          <span className="field-hint">
            Every section below is scoped to this solution. Clear it to browse
            and pick another - the sample, mapping, and coverage sections reset
            when the solution changes.
          </span>
        </div>
      ) : (
        <>
          <div className="solution-browser-controls">
            <label className="field solution-browser-search">
              <span className="field-label">Search solutions</span>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. CrowdStrike, Cloudflare, Zscaler"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="solution-browser-toggle">
              <input
                type="checkbox"
                checked={hideDeprecated}
                onChange={(e) => setHideDeprecated(e.target.checked)}
              />
              <span>Hide deprecated</span>
            </label>
          </div>
          {counts !== null && (
            <p className="solution-browser-counts">
              {counts.total} solutions - {counts.active} active,{" "}
              {counts.deprecated} deprecated. Showing {visible.length}.
            </p>
          )}
          <ul className="solution-browser-list">
            {visible.map((solution) => {
              // The list only renders while NOTHING is selected (selecting
              // switches to the selected-solution card), so rows carry no
              // selected state of their own.
              const badge = deprecationBadge(solution);
              return (
                <li key={solution.path} className="solution-browser-item">
                  <button
                    className="solution-browser-item-button"
                    onClick={() => select(solution)}
                  >
                    <span className="solution-browser-item-name">
                      {solution.name}
                    </span>
                    {badge !== null && (
                      <span
                        className="solution-browser-badge"
                        title={badge.reason}
                      >
                        {badge.label}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
            {visible.length === 0 && (
              <li className="field-hint">
                No solutions match - adjust the search or the deprecated filter.
              </li>
            )}
          </ul>
        </>
      )}
    </div>
  );
}
