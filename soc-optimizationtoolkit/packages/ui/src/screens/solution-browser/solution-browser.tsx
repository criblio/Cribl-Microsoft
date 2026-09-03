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
 *   - The `#/?solution=<name>` hash is an INTERNAL handoff, not a shareable
 *     link: written on select, read on this route's FIRST mount to preselect
 *     (keep-alive means there is no second one - DBT-28 defect (2)), and
 *     written by the SIEM-migration pivot (Unit 26). It is NOT advertised on
 *     screen - the DBT-75 note on the selected card records why there is no
 *     chip.
 *
 * All decision logic is the pure browser-state module; this component only
 * renders and drives IO through the content ports in PortsContext (ZERO direct
 * fetch here). When the content ports are unbound (a shell/mode without content)
 * it renders an always-visible unavailable state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DELIVERY_FIT_NOT_FETCHED,
  DELIVERY_FIT_UNMEASURED_LABEL,
  classifyConnectorIngestion,
  classifySolutionIngestion,
  connectorsCacheKey,
  decodeConnector,
  deliveryFitBadge,
  deprecatedSolutionKey,
  listDeprecatedContentHubSolutions,
  lookupSolutionIngestion,
  solutionIndexCacheKey,
  toVendorLogTypes,
} from "@soc/core";
import type {
  DeliveryFitEvidence,
  IngestionClass,
  SolutionRef,
  WorkspaceScope,
} from "@soc/core";
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
  /**
   * When true (an Azure target scope is committed), the browser cross-
   * references the Content Hub catalog for AUTHORITATIVE deprecation - the
   * repo folder heuristics miss solutions the Hub deprecated (e.g. Cloudflare,
   * current in the repo but deprecated as a Content Hub package).
   */
  scopeCommitted?: boolean;
  /**
   * A selection the HOST already restored from its own persistence, applied
   * once so the browser agrees with the rest of the page.
   *
   * The browser's own refresh-restore is the `#/?solution=` hash, which the
   * Cribl app iframe does not preserve: the host restores the solution from
   * the content cache, so every other section scoped itself to "this solution"
   * and the readiness pill went green while THIS section still showed the
   * browse list, as though nothing were selected (live review 2026-08-03).
   *
   * Arrives AFTER mount - the host reads it asynchronously - so it is applied
   * by an effect rather than a state initializer, under the same one-shot
   * discipline as the deep link: consumed once, so it can never re-fire and
   * silently undo Clear selection.
   */
  restoreName?: string | null;
}

// The cap on how many connector files a selected solution decodes for the
// log-type preview - keeps a solution with many connectors well under the
// 100 req/min budget (each connector is one raw fetch).
const CONNECTOR_DECODE_CAP = 5;

// The cached per-solution detail (parsed result cached by solution+commit).
interface SolutionDetail {
  connectorCount: number;
  logTypes: string[];
  /**
   * The tier computed LIVE from this solution's decoded connectors - the
   * fallback authority for a solution missing from the shipped map (a brand-
   * new one). null when no connector decoded. Optional so pre-existing cache
   * entries (without it) still load.
   */
  ingestion?: IngestionClass | null;
}

type DetailState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "loaded"; detail: SolutionDetail }
  | { phase: "error"; message: string };

/**
 * Translate the screen's fetch phase into the evidence the badge derivation
 * reasons over (DBT-15). Structural on purpose - every judgement about what the
 * evidence MEANS lives in deliveryFitBadge, where it is pinned without a DOM.
 * The one thing said here is that `loaded` carries a real connector count, so a
 * completed listing of zero reaches the derivation as a zero rather than as a
 * missing classification.
 */
/**
 * `selected` is passed because `idle` means two different things and only the
 * caller can tell them apart (review, DBT-15).
 *
 * With no solution selected, idle is honestly "nobody has looked". With one
 * SELECTED, idle lasts exactly one commit - React paints `selectedName` before
 * the detail effect sets `loading` - and in that frame the card would say "Not
 * measured ... classified live when the solution is selected" on a solution
 * that IS selected. Sub-perceptual and self-correcting, but it is the one place
 * the promised-as-future clause can still reach the card, and the card is where
 * the operator reads it. A selected idle is therefore reported as `fetching`:
 * a look IS about to happen, which is what "Measuring..." already says.
 */
function fitEvidence(
  detail: DetailState,
  selected: boolean,
): DeliveryFitEvidence {
  switch (detail.phase) {
    case "loaded":
      return {
        phase: "fetched",
        connectorCount: detail.detail.connectorCount,
        ingestion: detail.detail.ingestion,
      };
    case "loading":
      return { phase: "fetching" };
    case "error":
      return { phase: "fetch-failed" };
    case "idle":
      return selected ? { phase: "fetching" } : DELIVERY_FIT_NOT_FETCHED;
  }
}

export function SolutionBrowser({
  onSelect,
  scopeCommitted,
  restoreName,
}: SolutionBrowserProps) {
  const { ports, config } = usePorts();
  const content = ports.content;
  const cache = ports.contentCache;

  const [solutions, setSolutions] = useState<SolutionRef[] | null>(null);
  // Authoritative Content Hub deprecation keys (populated when a scope is
  // committed); merged into the repo deprecation signal below.
  const [hubDeprecated, setHubDeprecated] = useState<Set<string>>(new Set());
  const [commitSha, setCommitSha] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [hideDeprecated, setHideDeprecated] = useState(false);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState>({ phase: "idle" });

  // The deep-link name to preselect once the index loads (read ONCE on mount -
  // the preserved Unit 26 `#/?solution=` contract). CONSUMED (set to null) the
  // first time the preselect effect honors it: left standing, it would re-fire
  // whenever selectedName returns to null and silently undo Clear selection.
  const [deepLinkName, setDeepLinkName] = useState<string | null>(() =>
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

  // Cross-reference the Content Hub catalog for authoritative deprecation once
  // a scope is committed (the repo folder heuristics miss Hub-deprecated
  // solutions like Cloudflare). Best-effort: a failure leaves the set empty.
  useEffect(() => {
    if (
      scopeCommitted !== true ||
      config.subscriptionId === "" ||
      config.resourceGroup === "" ||
      config.workspaceName === ""
    ) {
      setHubDeprecated(new Set());
      return;
    }
    let cancelled = false;
    const scope: WorkspaceScope = {
      subscriptionId: config.subscriptionId,
      resourceGroup: config.resourceGroup,
      workspaceName: config.workspaceName,
      location: "",
    };
    void listDeprecatedContentHubSolutions(ports.azure, scope, ports.logger).then(
      (set) => {
        if (!cancelled) setHubDeprecated(set);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [
    scopeCommitted,
    config.subscriptionId,
    config.resourceGroup,
    config.workspaceName,
    ports.azure,
    ports.logger,
  ]);

  // Repo index + the authoritative Content Hub deprecation, merged: a solution
  // the Hub flags is marked deprecated even when the repo folder is not.
  const mergedSolutions = useMemo<SolutionRef[] | null>(() => {
    if (solutions === null) return null;
    if (hubDeprecated.size === 0) return solutions;
    return solutions.map((s) =>
      s.deprecated !== true && hubDeprecated.has(deprecatedSolutionKey(s.name))
        ? { ...s, deprecated: true, deprecationReason: "Deprecated in the Microsoft Content Hub" }
        : s,
    );
  }, [solutions, hubDeprecated]);

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
        const classes: IngestionClass[] = [];
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
          classes.push(classifyConnectorIngestion(parsed));
        }
        const built: SolutionDetail = {
          connectorCount: files.length,
          logTypes: [...logTypes].sort((a, b) => a.localeCompare(b)),
          ingestion: classes.length > 0 ? classifySolutionIngestion(classes) : null,
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

  // Apply the HOST's restored selection once the index is loaded (see the
  // restoreName prop docs). Only the local name is set: the host is the SOURCE
  // of this value, so reporting it back through onSelect would be a redundant
  // round-trip, and the hash is left alone so the deep-link contract is
  // untouched. The name resolves against the real index, so the card shows the
  // true deprecation state rather than whatever stub the host restored. The
  // ref is consumed only when a restore is actually attempted, so an early
  // render (index still loading) does not burn it.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (
      restoredRef.current ||
      solutions === null ||
      restoreName === undefined ||
      restoreName === null ||
      restoreName === "" ||
      selectedName !== null
    ) {
      return;
    }
    restoredRef.current = true;
    const match = resolveSelectedSolution(mergedSolutions ?? solutions, restoreName);
    if (match !== null) {
      setSelectedName(match.name);
    }
  }, [solutions, mergedSolutions, restoreName, selectedName]);

  // Once the index is present, honor a deep-linked solution ONCE (the preserved
  // `#/?solution=` contract). Sets the selection like a click; the effect above
  // then fetches its detail. The deep link is consumed here - honored or not -
  // so Clear selection genuinely clears (user report 2026-07-08: with the
  // deep link left in state, this effect re-selected the cleared solution the
  // moment selectedName went back to null).
  useEffect(() => {
    if (solutions === null || deepLinkName === null || selectedName !== null) {
      return;
    }
    setDeepLinkName(null);
    const match = resolveSelectedSolution(solutions, deepLinkName);
    if (match !== null) {
      select(match);
    }
  }, [solutions, deepLinkName, selectedName, select]);

  const counts = useMemo(
    () => (mergedSolutions === null ? null : solutionCounts(mergedSolutions)),
    [mergedSolutions],
  );
  const visible = useMemo(
    () =>
      mergedSolutions === null
        ? []
        : filterSolutions(mergedSolutions, { query, hideDeprecated }),
    [mergedSolutions, query, hideDeprecated],
  );
  const selected = useMemo(
    () => resolveSelectedSolution(mergedSolutions ?? [], selectedName),
    [mergedSolutions, selectedName],
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
              // The SAME derivation the list rows use - the difference is only
              // what is known here (DBT-15). A row never fetches, so it passes
              // no evidence; this card passes the live fetch's real phase, and
              // deliveryFitBadge decides which source wins. Handing the card a
              // row's badge is what made it say "Not measured" about a fetch it
              // had already completed (review finding 2).
              const badge = deliveryFitBadge(
                lookupSolutionIngestion(selected.name),
                fitEvidence(detail, true),
              );
              return (
                <span
                  className={`ingestion-badge ingestion-badge-${badge.state}`}
                  title={badge.reason}
                >
                  {badge.label}
                </span>
              );
            })()}
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
          {/* DBT-75. THERE IS NO DEEP-LINK CHIP HERE, and the absence is the
              fix. Until 2026-09-02 this block also rendered
              `Deep link: #/?solution=<name>` as a copyable code chip beside
              the connector counts.
              WHY IT WAS ONCE TRUE. The chip landed 2026-07-05 with the
              browser itself (Unit 14), when ADR 0001 shipped a SECOND shell -
              apps/local-app, a Node host on localhost - whose page in the
              address bar WAS this app's own document, so appending the
              fragment to it really did preselect a solution. ADR 0002
              (2026-08-17) deleted that shell; its own note puts the removal
              at "31 files and four comments", and this chip was a fifth
              nobody found. The claim outlived the only shell it held on.
              WHY IT CANNOT BE CORRECTED RATHER THAN REMOVED. The advertised
              value is a bare FRAGMENT - no origin, no path - so it needs a
              base, and on the shell that remains there is none to give it:
              the app iframes on a SANDBOXED origin whose server answers EVERY
              path with the app (see criblUiBase in apps/cribl-app/src/App.tsx
              and the 2026-07-29 user report it cites), while the operator's
              address bar shows the EMBEDDER, so a fragment typed there lands
              on the leader's document. There is no string to substitute.
              THE DEFECT IS THE MISSING ADDRESS, NOT A BROKEN CONSUMER, and
              the first draft of this note got that backwards. It argued the
              fragment could not be read because "AppFrame mounts a route on
              FIRST VISIT only" - but first-visit mounting is exactly what
              MAKES the read fire. If the fragment does reach this document it
              is consumed normally: the operator navigates to Sentinel
              Integration, this component mounts for the first time, and the
              initializer above runs parseSolutionDeepLink on the hash, which
              is still there because nothing cleared it in between - the only
              writers in this package are select() and clearSelection() above
              and the SIEM pivot (siem-migration-screen.tsx:225), all
              user-driven and all in subtrees unmounted until visited. Pinned:
              "preselects the solution named in the hash present at first
              render" in solution-browser.dom.test.tsx. The app does open on
              Dataflow first - App.tsx hardcodes initialRouteId="architecture"
              and neither it nor AppFrame reads the hash for routing - so the
              preselect waits for that navigation, but that is a DETOUR and
              not a dead end. THE DETOUR IS WALKABLE ONCE, AND THE QUALIFIER
              IS THE WHOLE POINT: it is the FIRST entry into Sentinel
              Integration that mounts this component and runs the initializer.
              AppFrame keeps a route mounted after its first visit - visitedRef
              accumulates visited ids and `mounted` is filtered by it
              (app-frame.tsx:153-162) - so a hash written later reaches a
              component that never mounts again, and is never read. That is
              DBT-28 defect (2) exactly: "The hash is read on MOUNT only ...
              which breaks the app's own SIEM-migration pivot the second time
              it is used". So the SIEM-migration pivot rides this same read,
              and it arrives only while Sentinel Integration is still
              UNMOUNTED - usually the first pivot, because the pivot is itself
              what mounts the route. The condition is that first MOUNT and not
              the pivot's use count, so DBT-28's "the second time" names the
              common case rather than the mechanism: a pivot made after the
              operator has already opened Sentinel Integration misses on its
              FIRST use too. None of this says the pivot works in general. The
              unqualified version of this sentence - "the same path the
              SIEM-migration pivot already takes successfully" - stood here
              until 2026-09-03 and was false. What the detour argument needs is
              narrower and survives: a fragment that reaches this document
              before the route's first mount IS consumed. So what was false
              about the chip is entirely the paragraph above - there is no
              pasteable ADDRESS to put the fragment on, not an inability to
              consume one it is handed.
              WHETHER THE FRAGMENT SURVIVES THE IFRAME IS UNSETTLED, and the
              record points both ways. Do NOT cite the 2026-08-28 live attempt
              for non-arrival, which an earlier draft here did: DBT-28
              investigated non-arrival as its candidate (1) and records that it
              "found BOTH recorded candidates wrong", attributing the unchanged
              selection to a measured RESOLVER defect instead
              (resolveSelectedSolution matches exact and case-insensitive-exact
              only, so a punctuation variant resolves to nothing and is
              consumed silently). Pointing the other way, the restoreName note
              at the top of this file records live review 2026-08-03 finding
              that "the Cribl app iframe does not preserve" the hash - which is
              why the HOST restores the selection from the content cache at
              all. The two have not been reconciled and neither is settled.
              Removing the chip needs neither answer: with no address to paste,
              advertising one is a FALSE CLAIM rather than an unfinished
              feature.
              THE MECHANISM IS UNTOUCHED - AND WAS ALREADY HALF BROKEN.
              buildSolutionDeepLink still writes the hash in select() above,
              the mount read still preselects on the FIRST mount of this route,
              and the SIEM-migration pivot still hands off through it on the
              entry that first mounts this route. It did not hand off once the
              route was already mounted before this change either, for the
              keep-alive reason above (DBT-28 defect (2)); removing the chip
              neither caused that nor fixes it. Only the claim that an operator
              can copy it somewhere is gone. BOTH
              halves are pinned in solution-browser.dom.test.tsx now - the
              write and the read - because deleting the chip is exactly the
              kind of cleanup that would take the read with it, and until
              2026-09-02 the read could be disabled outright with the whole
              packages/ui suite green (80 files / 1343 tests). Re-measured
              2026-09-03: with the read pin present the same inversion fails
              exactly one test of 1344, and it is that pin.
              WHETHER A SHAREABLE DEEP LINK IS WANTED IS STILL OPEN. Answering
              it needs a base URL this app does not own, so it is a Cribl
              platform question and not a routing one. Do not re-add a chip to
              answer it - the pin in solution-browser.dom.test.tsx fails if
              this card starts printing an address again. */}
          {detail.phase === "loaded" && (
            <span className="field-hint">
              {detail.detail.connectorCount} connector file
              {detail.detail.connectorCount === 1 ? "" : "s"};{" "}
              {detail.detail.logTypes.length} log type
              {detail.detail.logTypes.length === 1 ? "" : "s"} detected
              {detail.detail.logTypes.length > 0
                ? `: ${detail.detail.logTypes.join(", ")}`
                : "."}
            </span>
          )}
          <div className="panel-controls">
            <button className="run-button" onClick={clearSelection}>
              Clear selection
            </button>
          </div>
          {/* DBT-9. TWO THINGS HERE ARE EASY TO GET WRONG, and the first
              draft of this fix got both.
              1. THE DELETION HAPPENS ON *CLEAR*, not on picking the next
                 solution. handleSolutionChange guards on
                 `prevName === null || prevName === nextName`
                 (integrate-screen.tsx:658), so Clear (X -> null) falls
                 through and removes every tagged sample, while the following
                 pick (null -> Y) returns early and removes nothing. The
                 browse list is hidden while a solution is selected, so Clear
                 is the ONLY route to another one - which means every deletion
                 in the product happens at the button this sentence sits under.
                 Saying "changing the solution deletes" points the warning at
                 the one step that is harmless.
              2. DO NOT PROMISE THE MAPPINGS COME BACK. Approving the
                 auto-generated mapping unchanged persists nothing, so a
                 reassurance here would be false on the default path - and the
                 save is fire-and-forget with a swallowed error besides. The
                 copy stays silent about it rather than guessing.
              The three sections still do not share a verb: samples are
              DELETED and unrecoverable, mapping and coverage only empty. */}
          <span className="field-hint">
            Every section below is scoped to this solution. Clearing it deletes
            the samples you acquired for it and empties the mapping and coverage
            sections - it is how you pick another solution, so do that only when
            you are done with this one.
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
          <p className="solution-browser-legend">
            Cribl delivery fit (Azure Logs Ingestion API):{" "}
            <span className="ingestion-badge ingestion-badge-recommended">
              Recommended
            </span>{" "}
            CCF Push{" "}
            <span className="ingestion-badge ingestion-badge-supported">
              Supported
            </span>{" "}
            CCF pull / custom-table DCR{" "}
            <span className="ingestion-badge ingestion-badge-legacy">Legacy</span>{" "}
            agent / Functions{" "}
            {/* This state is about the EVIDENCE, not the solution, so the
                legend says what is missing rather than implying a worse fit.
                The legend stops here on purpose: "Measuring..." and "No
                connector" need a live fetch, which only a SELECTED solution
                has, so listing them as browse-list vocabulary would advertise
                two badges no row here can ever show. */}
            <span className="ingestion-badge ingestion-badge-unmeasured">
              {DELIVERY_FIT_UNMEASURED_LABEL}
            </span>{" "}
            no connector JSON was read for it
          </p>
          <ul className="solution-browser-list">
            {visible.map((solution) => {
              // The list only renders while NOTHING is selected (selecting
              // switches to the selected-solution card), so rows carry no
              // selected state of their own.
              const badge = deprecationBadge(solution);
              // Logs-Ingestion fit from the shipped map (instant, no fetch).
              // The map does not cover every solution in the index, so this is
              // routed through deliveryFitBadge: a miss becomes "Not measured"
              // rather than the blank cell DBT-15 reported. The evidence is
              // passed EXPLICITLY rather than defaulted - a browse row really
              // has not looked at this solution's connectors, and that is what
              // earns it the tooltip promising the look happens on selection.
              const fit = deliveryFitBadge(
                lookupSolutionIngestion(solution.name),
                DELIVERY_FIT_NOT_FETCHED,
              );
              const recommended = fit.state === "recommended";
              return (
                <li
                  key={solution.path}
                  className={
                    "solution-browser-item" +
                    (recommended ? " solution-browser-item-recommended" : "")
                  }
                >
                  <button
                    className="solution-browser-item-button"
                    onClick={() => select(solution)}
                  >
                    <span className="solution-browser-item-name">
                      {solution.name}
                    </span>
                    <span
                      className={`ingestion-badge ingestion-badge-${fit.state}`}
                      title={fit.reason}
                    >
                      {fit.label}
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
