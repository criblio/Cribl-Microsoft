/**
 * Sample-source discovery, in two lazy stages (plan Phase 3, ADR 0003).
 *
 * ON LOAD: the worker group listing, and nothing else. ONE request, so the
 * picker can render a group dropdown immediately.
 *
 * ON SELECTION: that one group's sources, plus the two workspace-wide dataset
 * listings (fetched once and kept - they do not depend on the group, so
 * switching groups costs one request, not three).
 *
 * WHY LAZY (user direction 2026-08-19): the first cut fanned out across every
 * Stream worker group on load. This workspace has 15+, so that was up to nine
 * requests before the operator had done anything, against a proxy budget shared
 * with the rest of the page. Asking which group they want is cheaper AND more
 * complete - the fan-out needed a cap, and the cap silently hid groups.
 *
 * NOT AUTO-RETRIED. A failure stays failed until the operator asks again; one
 * 403 must not become a request storm.
 *
 * DISCOVERY NEVER GATES ANYTHING - every failure still leaves manual upload
 * working, so this reports and never blocks.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { listSampleSourceGroups, loadSampleSources } from "@soc/core";
import type { SampleSourceGroups, SampleSourceInventory } from "@soc/core";
import { usePorts } from "../../ports-context";

export interface SampleSourcesState {
  /** Stage one. Null until the group listing completes. */
  groups: SampleSourceGroups | null;
  /** Stage two. Null until a group has been selected. */
  inventory: SampleSourceInventory | null;
  /** The group whose sources are loaded, or "". */
  selectedGroupId: string;
  /** Notes about discovery itself (an unreachable leader, no Stream groups). */
  notes: readonly string[];
  /** Stage one in flight. */
  loadingGroups: boolean;
  /** Stage two in flight. */
  loadingSources: boolean;
  /** Pick a worker group; triggers stage two. */
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
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [notes, setNotes] = useState<readonly string[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [loadingSources, setLoadingSources] = useState(false);
  // Whether the workspace-wide dataset listings have already been fetched, so a
  // second group selection costs one request rather than three.
  const datasetsLoaded = useRef(false);

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

  const loadSources = useCallback(
    async (groupId: string, current: SampleSourceGroups | null) => {
      setLoadingSources(true);
      try {
        const next = await loadSampleSources(
          ports.cribl,
          {
            groupId,
            ...(current?.searchGroupId !== undefined
              ? { searchGroupId: current.searchGroupId }
              : {}),
            includeDatasets: !datasetsLoaded.current,
          },
          ports.logger,
        );
        datasetsLoaded.current = true;
        setInventory(next);
      } catch (err) {
        setNotes([
          `Listing that worker group's sources failed: ${String(err)}. Uploading samples still works.`,
        ]);
      } finally {
        setLoadingSources(false);
      }
    },
    [ports.cribl, ports.logger],
  );

  // Stage one, once per enablement - never once per render.
  const started = useRef(false);
  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;
    void loadGroups();
  }, [enabled, loadGroups]);

  const selectGroup = useCallback(
    (groupId: string) => {
      setSelectedGroupId(groupId);
      if (groupId === "") {
        return;
      }
      void loadSources(groupId, groups);
    },
    [groups, loadSources],
  );

  const reload = useCallback(() => {
    started.current = true;
    datasetsLoaded.current = false;
    if (selectedGroupId === "") {
      void loadGroups();
      return;
    }
    void loadSources(selectedGroupId, groups);
  }, [groups, loadGroups, loadSources, selectedGroupId]);

  return {
    groups,
    inventory,
    selectedGroupId,
    notes,
    loadingGroups,
    loadingSources,
    selectGroup,
    reload,
  };
}
