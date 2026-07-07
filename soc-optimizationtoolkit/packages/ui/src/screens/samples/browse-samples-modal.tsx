/**
 * BrowseSamplesModal - the Browse Samples affordance on the Integrate page's
 * Sample Data section (porting-plan Unit 16 UI, ENG-19/20/41/42; completes
 * GUI-06). Opened by the green "Browse Samples" button; lets the user pick
 * curated raw vendor samples for the active solution and LOAD them into the
 * tagged-sample store.
 *
 * LAZY acquisition (the ENG-20 redesign): nothing is fetched until the modal
 * opens for THE selected solution - no eager startup prefetch of every mapped
 * vendor. On open it runs one on-demand acquisition (browseSamplesDetailed) over
 * the injected ports; a single spinner covers the fetch, then the results render
 * grouped by tier.
 *
 * BROWSE NEVER COMMITS (keep-list): browsing only lists metadata + previews.
 * The store is untouched until the user clicks Load, which fetches the full
 * content for the selected STABLE ids (loadSamples) and hands the resolved
 * samples to the section to upsert (replace-by-logType). Selection is keyed by
 * the core `${source}:${logType}` id so it survives re-render.
 *
 * Per tier: a preview list, an INDETERMINATE select-all, and a live LOAD
 * SUMMARY. The sentinel-repo tier also surfaces the honest ENG-42 preIngested
 * message (e.g. "All N sample(s) are in Sentinel schema format...") when its
 * matches were already Sentinel-shaped.
 *
 * All decisions are the pure browse-samples-state helpers; the only IO is the
 * two usecase calls (browse on open, load on commit) through the ports.
 */

import { useCallback, useEffect, useState } from "react";
import {
  browseSamplesDetailed,
  loadSamples,
  type AcquireSamplesDeps,
  type AvailableSample,
  type Logger,
  type RemoteSampleSource,
  type RepoSampleResult,
  type ResolvedSample,
  type SentinelContent,
} from "@soc/core";
import {
  loadSummary,
  projectTiers,
  repoNotice,
  tierSelectionState,
  toggleOne,
  toggleTier,
  type BrowseTierGroup,
} from "./browse-samples-state";

/** A no-op remote source: elastic/cribl tiers degrade to empty when unbound. */
const NOOP_SOURCE: RemoteSampleSource = {
  async listElasticTestFiles() {
    return [];
  },
  async listCriblPackSamples() {
    return [];
  },
};

const PREVIEW_LINE_LIMIT = 3;

export interface BrowseSamplesModalProps {
  /** The active solution to browse samples for (never empty when opened). */
  solutionName: string;
  /** The Unit 14 Sentinel content port (sentinel-repo tier). */
  content: SentinelContent;
  /** OPTIONAL elastic/cribl fetch seam; absent = those tiers stay empty. */
  sampleSource?: RemoteSampleSource;
  /** OPTIONAL diagnostics sink. */
  logger?: Logger;
  /** Close the modal without loading. */
  onClose: () => void;
  /**
   * Commit the loaded samples: the section upserts them into the store
   * (replace-by-logType) and refreshes its chip list. Resolves when persisted.
   */
  onLoad: (resolved: ResolvedSample[]) => Promise<void>;
}

export function BrowseSamplesModal({
  solutionName,
  content,
  sampleSource,
  logger,
  onClose,
  onLoad,
}: BrowseSamplesModalProps) {
  const [available, setAvailable] = useState<AvailableSample[] | null>(null);
  const [repo, setRepo] = useState<RepoSampleResult | null>(null);
  const [browseError, setBrowseError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  // Build the acquisition deps once per input change (pure object; the ports are
  // stable). The no-op source keeps elastic/cribl empty when no seam is bound.
  const deps: AcquireSamplesDeps = {
    content,
    source: sampleSource ?? NOOP_SOURCE,
    ...(logger !== undefined ? { logger } : {}),
  };

  // Lazy per-solution acquisition on open.
  const browse = useCallback(async () => {
    setAvailable(null);
    setBrowseError("");
    setRepo(null);
    try {
      const result = await browseSamplesDetailed(deps, { solutionName });
      setAvailable(result.available);
      setRepo(result.repo);
    } catch (err) {
      setBrowseError(String(err));
    }
    // deps is rebuilt each render from stable ports; depend on the identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, sampleSource, logger, solutionName]);

  useEffect(() => {
    void browse();
  }, [browse]);

  const groups = available === null ? [] : projectTiers(available);
  const summary = loadSummary(groups, selected);
  const notice = repoNotice(repo);

  const setTier = useCallback(
    (entries: readonly AvailableSample[], select: boolean) => {
      setSelected((current) => toggleTier(entries, current, select));
    },
    [],
  );

  const toggleEntry = useCallback((id: string) => {
    setSelected((current) => toggleOne(current, id));
  }, []);

  const commitLoad = useCallback(async () => {
    if (selected.size === 0) {
      return;
    }
    setLoading(true);
    setLoadError("");
    try {
      const resolved = await loadSamples(deps, {
        solutionName,
        selectedIds: [...selected],
      });
      await onLoad(resolved);
      onClose();
    } catch (err) {
      setLoadError(String(err));
      setLoading(false);
    }
    // deps rebuilt from stable ports each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, solutionName, onLoad, onClose]);

  return (
    <div
      className="csv-dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Browse curated samples"
    >
      <div className="csv-dialog browse-dialog">
        <div className="csv-dialog-title">
          Browse samples for {solutionName}
        </div>
        <p className="field-hint">
          Curated raw vendor samples for this solution, grouped by source. Select
          the log types you want and Load them - browsing never changes your
          tagged samples until you load. Loaded samples replace any existing
          sample with the same log type.
        </p>

        {browseError !== "" && (
          <div className="browse-dialog-status browse-dialog-status-warn">
            <span>Could not browse samples: {browseError}</span>
            <button
              type="button"
              className="run-button"
              onClick={() => void browse()}
            >
              Retry
            </button>
          </div>
        )}

        {available === null && browseError === "" && (
          <p className="field-hint">Fetching samples for {solutionName}...</p>
        )}

        {/* The honest ENG-42 sentinel-repo notice (found / all pre-ingested /
            none parsed / no match). */}
        {notice !== null && (
          <div
            className={
              notice.tone === "warn"
                ? "browse-dialog-status browse-dialog-status-warn"
                : notice.tone === "ok"
                  ? "browse-dialog-status browse-dialog-status-ok"
                  : "browse-dialog-status"
            }
          >
            <span>{notice.message}</span>
          </div>
        )}

        {available !== null && groups.length === 0 && browseError === "" && (
          <p className="field-hint">
            No curated samples were found for this solution. Upload or paste raw
            vendor events instead.
          </p>
        )}

        {groups.map((group) => (
          <BrowseTierBlock
            key={group.tier}
            group={group}
            selected={selected}
            onToggleTier={setTier}
            onToggleEntry={toggleEntry}
          />
        ))}

        {/* Load summary + actions */}
        <div className="csv-dialog-actions">
          <span className="field-hint">
            {summary.totalSelected === 0
              ? "Select one or more samples to load."
              : `${summary.totalSelected} sample${
                  summary.totalSelected === 1 ? "" : "s"
                } selected, ${summary.totalEvents} event${
                  summary.totalEvents === 1 ? "" : "s"
                } across ${summary.tiers.filter((t) => t.selectedCount > 0).length} tier(s).`}
            {loadError !== "" ? ` Load failed: ${loadError}` : ""}
          </span>
          <div className="panel-controls">
            <button
              type="button"
              className="run-button"
              onClick={onClose}
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="button"
              className="next-action-button next-action-button-positive"
              onClick={() => void commitLoad()}
              disabled={loading || summary.totalSelected === 0}
            >
              {loading
                ? "Loading..."
                : `Load ${summary.totalSelected} sample${
                    summary.totalSelected === 1 ? "" : "s"
                  }`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface BrowseTierBlockProps {
  group: BrowseTierGroup;
  selected: ReadonlySet<string>;
  onToggleTier: (entries: readonly AvailableSample[], select: boolean) => void;
  onToggleEntry: (id: string) => void;
}

/**
 * One tier group: its heading with an INDETERMINATE select-all, a per-tier load
 * summary line, and one selectable row (with preview) per available sample. The
 * select-all input's `indeterminate` DOM property is set through a ref callback
 * (React has no indeterminate prop).
 */
function BrowseTierBlock({
  group,
  selected,
  onToggleTier,
  onToggleEntry,
}: BrowseTierBlockProps) {
  const state = tierSelectionState(group.entries, selected);
  const selectedCount = group.entries.reduce(
    (n, e) => (selected.has(e.id) ? n + 1 : n),
    0,
  );

  return (
    <div className="browse-tier">
      <div className="browse-tier-head">
        <label className="browse-tier-select">
          <input
            type="checkbox"
            checked={state.checked}
            ref={(el) => {
              if (el !== null) {
                el.indeterminate = state.indeterminate;
              }
            }}
            onChange={(e) => onToggleTier(group.entries, e.target.checked)}
            aria-label={`Select all ${group.label} samples`}
          />
          <span className="browse-tier-name">{group.label}</span>
        </label>
        <span className="browse-tier-counts">
          {selectedCount} / {group.entries.length} selected,{" "}
          {group.eventTotal} event{group.eventTotal === 1 ? "" : "s"}
        </span>
      </div>
      <p className="field-hint">{group.description}</p>
      <div className="browse-entry-list">
        {group.entries.map((entry) => (
          <label className="browse-entry" key={entry.id}>
            <input
              type="checkbox"
              checked={selected.has(entry.id)}
              onChange={() => onToggleEntry(entry.id)}
              aria-label={`Select ${entry.source} ${entry.logType}`}
            />
            <div className="browse-entry-body">
              <div className="browse-entry-head">
                <span className="sample-chip-format">
                  {entry.format.toUpperCase()}
                </span>
                <span className="browse-entry-name">{entry.logType}</span>
                <span className="browse-entry-source">{entry.source}</span>
                <span className="sample-chip-counts">
                  {entry.eventCount} event{entry.eventCount === 1 ? "" : "s"}
                </span>
              </div>
              {entry.preview !== undefined && entry.preview.length > 0 && (
                <pre className="result browse-entry-preview">
                  {entry.preview.slice(0, PREVIEW_LINE_LIMIT).join("\n")}
                </pre>
              )}
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}
