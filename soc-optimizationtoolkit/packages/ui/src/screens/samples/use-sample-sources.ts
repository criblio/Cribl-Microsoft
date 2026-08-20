/**
 * Sample-source discovery, lazy and mode-driven (plan Phase 3, ADR 0003).
 *
 * ON LOAD: the worker group listing, and nothing else. ONE request.
 *
 * ON MODE CHOICE: only the surface that mode needs.
 *   lake-query    one leader request; NO worker group involved.
 *   live-capture  one request, once a worker group is picked.
 *
 * WHY LAZY (user direction 2026-08-19): the first cut fanned out across every
 * Stream worker group on load. This workspace has 15+, so that was up to nine
 * requests before the operator had done anything, against a proxy budget shared
 * with the rest of the page.
 *
 * NOT AUTO-RETRIED. A failure stays failed until the operator asks again; one
 * 403 must not become a request storm.
 *
 * DISCOVERY NEVER GATES ANYTHING - every failure still leaves manual upload
 * working, so this reports and never blocks.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { listSampleSourceGroups, loadSampleSources } from "@soc/core";
import type {
  AcquisitionMode,
  SampleSourceGroups,
  SampleSourceInventory,
} from "@soc/core";
import { usePorts } from "../../ports-context";

export interface SampleSourcesState {
  /** Stage one. Null until the group listing completes. */
  groups: SampleSourceGroups | null;
  /** Stage two. Null until a mode has been chosen and its surface read. */
  inventory: SampleSourceInventory | null;
  /** The chosen mode, or null before the operator picks one. */
  mode: AcquisitionMode | null;
  /** The worker group whose sources are loaded (capture mode only), or "". */
  selectedGroupId: string;
  /** Notes about discovery itself. */
  notes: readonly string[];
  loadingGroups: boolean;
  loadingSources: boolean;
  /** Choose a mode. Lake mode loads immediately; capture waits for a group. */
  selectMode: (mode: AcquisitionMode) => void;
  /** Pick a worker group (capture mode); triggers its source listing. */
  selectGroup: (groupId: string) => void;
  /** Re-run whichever stage is relevant. */
  reload: () => void;
}

export interface UseSampleSourcesInput {
  /**
   * Whether a Cribl connection exists to discover against. False keeps the hook
   * idle - no address is different from a call that failed, and must not be
   * reported as one.
   */
  enabled: boolean;
}

export function useSampleSources({
  enabled,
}: UseSampleSourcesInput): SampleSourcesState {
  const { ports } = usePorts();
  const [groups, setGroups] = useState<SampleSourceGroups | null>(null);
  const [inventory, setInventory] = useState<SampleSourceInventory | null>(null);
  const [mode, setMode] = useState<AcquisitionMode | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [notes, setNotes] = useState<readonly string[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [loadingSources, setLoadingSources] = useState(false);

  const loadGroups = useCallback(async () => {
    setLoadingGroups(true);
    try {
      const found = await listSampleSourceGroups(ports.cribl, ports.logger);
      setGroups(found);
      setNotes(found.notes);
    } catch (err) {
      // listSampleSourceGroups folds its own failure into `ok: false`; this is
      // the truly-unexpected path, surfaced rather than swallowed.
      setNotes([
        `Sample-source discovery failed unexpectedly: ${String(err)}. Uploading samples still works.`,
      ]);
      setGroups(null);
    } finally {
      setLoadingGroups(false);
    }
  }, [ports.cribl, ports.logger]);

  const loadSurface = useCallback(
    async (next: AcquisitionMode, groupId: string) => {
      setLoadingSources(true);
      try {
        const found = await loadSampleSources(
          ports.cribl,
          { mode: next, ...(groupId !== "" ? { groupId } : {}) },
          ports.logger,
        );
        setInventory(found);
      } catch (err) {
        setNotes([
          `Listing what is available failed: ${String(err)}. Uploading samples still works.`,
        ]);
      } finally {
        setLoadingSources(false);
      }
    },
    [ports.cribl, ports.logger],
  );

  // Stage one, ONCE EVER - not once per enablement, whatever this comment used
  // to say (2026-08-20 audit). `started` is set below and at reload, and is
  // never cleared, so the guard outlives any change to `enabled` or to the
  // ports bundle.
  //
  // That is load-bearing for the request-storm rule, and it has ONE consequence
  // worth naming: `cloudPorts` is memoized on `activeConfig.tenantId`, so
  // changing AZURE tenant rebuilds ports, changes `loadGroups`, re-fires this
  // effect - and the guard swallows it. The operator would keep seeing the
  // previous tenant's worker groups until they press Retry.
  //
  // Left as is deliberately: this deployment stays in a single Azure tenant, so
  // the path is unreachable. If multi-tenant switching is ever added, THIS is
  // the line that has to change - key the guard on the ports identity rather
  // than a boolean - because the failure is one tenant's infrastructure shown
  // under another tenant's name, which no operator would spot.
  const started = useRef(false);
  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;
    void loadGroups();
  }, [enabled, loadGroups]);

  const selectMode = useCallback(
    (next: AcquisitionMode) => {
      setMode(next);
      // Switching mode invalidates the other surface's listing, so drop it
      // rather than showing a stale one under a new heading.
      setInventory(null);
      setSelectedGroupId("");
      // Lake datasets are a leader route, so they load the moment the mode is
      // chosen. Capture has nothing to read until a worker group is picked.
      if (next === "lake-query") {
        void loadSurface(next, "");
      }
    },
    [loadSurface],
  );

  const selectGroup = useCallback(
    (groupId: string) => {
      setSelectedGroupId(groupId);
      if (groupId === "" || mode !== "live-capture") {
        return;
      }
      void loadSurface("live-capture", groupId);
    },
    [mode, loadSurface],
  );

  const reload = useCallback(() => {
    started.current = true;
    if (mode === null) {
      void loadGroups();
      return;
    }
    if (mode === "live-capture" && selectedGroupId === "") {
      void loadGroups();
      return;
    }
    void loadSurface(mode, selectedGroupId);
  }, [mode, selectedGroupId, loadGroups, loadSurface]);

  return {
    groups,
    inventory,
    mode,
    selectedGroupId,
    notes,
    loadingGroups,
    loadingSources,
    selectMode,
    selectGroup,
    reload,
  };
}
