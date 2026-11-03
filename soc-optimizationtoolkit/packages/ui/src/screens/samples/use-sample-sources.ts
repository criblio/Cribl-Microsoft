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
   *
   * A CRIBL FACT, and only that (DBT-53). Every request this hook makes is a
   * Cribl route, so anything else passed here closes the sample-acquisition
   * path for a reason that has nothing to do with it - the Integrate screen
   * passed its Azure scope-committed flag, and neither CapturePanel nor
   * LakePanel could mount until a subscription was chosen.
   */
  enabled: boolean;
}

export function useSampleSources({
  enabled,
}: UseSampleSourcesInput): SampleSourcesState {
  const { ports, config } = usePorts();
  const tenant = config.tenantId.trim().toLowerCase();
  const [groups, setGroups] = useState<SampleSourceGroups | null>(null);
  const [inventory, setInventory] = useState<SampleSourceInventory | null>(null);
  const [mode, setMode] = useState<AcquisitionMode | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [notes, setNotes] = useState<readonly string[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [loadingSources, setLoadingSources] = useState(false);

  // Which listing is current. A connection switch starts a new listing, and the
  // previous connection's answer, if it lands later, is dropped rather than
  // shown under the new tenant's name (AZR-65).
  const listingSeq = useRef(0);

  const loadGroups = useCallback(async () => {
    const seq = ++listingSeq.current;
    setLoadingGroups(true);
    try {
      const found = await listSampleSourceGroups(ports.cribl, ports.logger);
      if (seq !== listingSeq.current) return;
      setGroups(found);
      setNotes(found.notes);
    } catch (err) {
      if (seq !== listingSeq.current) return;
      // listSampleSourceGroups folds its own failure into `ok: false`; this is
      // the truly-unexpected path, surfaced rather than swallowed.
      setNotes([
        `Sample-source discovery failed unexpectedly: ${String(err)}. Uploading samples still works.`,
      ]);
      setGroups(null);
    } finally {
      if (seq === listingSeq.current) setLoadingGroups(false);
    }
  }, [ports.cribl, ports.logger]);

  // The same guard for stage two: a surface read still in flight when the
  // connection changes must not land as the new connection's inventory.
  const surfaceSeq = useRef(0);

  const loadSurface = useCallback(
    async (next: AcquisitionMode, groupId: string) => {
      const seq = ++surfaceSeq.current;
      setLoadingSources(true);
      try {
        const found = await loadSampleSources(
          ports.cribl,
          { mode: next, ...(groupId !== "" ? { groupId } : {}) },
          ports.logger,
        );
        if (seq !== surfaceSeq.current) return;
        setInventory(found);
      } catch (err) {
        if (seq !== surfaceSeq.current) return;
        setNotes([
          `Listing what is available failed: ${String(err)}. Uploading samples still works.`,
        ]);
      } finally {
        if (seq === surfaceSeq.current) setLoadingSources(false);
      }
    },
    [ports.cribl, ports.logger],
  );

  // Stage one, ONCE PER CONNECTION. The guard records WHICH connection it
  // listed for - the Azure tenant and the Cribl client - and never clears, so
  // re-renders, an enablement flicker and a ports object rebuilt around the
  // same client all leave it alone (the request-storm rule: one listing per
  // connection, and a failure stays failed until the operator asks again).
  //
  // A DIFFERENT connection lists again (AZR-65). The guard used to be a boolean
  // set once, so switching the active connection to another tenant rebuilt
  // ports, re-fired this effect, and the guard swallowed it: the screen kept
  // the previous tenant's worker groups under the new tenant's name. It is keyed
  // on the tenant as well as the client, because a shell that shares one Cribl
  // adapter across tenants would otherwise bring the defect straight back. The
  // switch also drops the previous connection's mode, group and inventory -
  // the same defect one stage down.
  const startedFor = useRef<{ cribl: unknown; tenant: string } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const prev = startedFor.current;
    if (prev !== null && prev.cribl === ports.cribl && prev.tenant === tenant) return;
    startedFor.current = { cribl: ports.cribl, tenant };
    if (prev !== null) {
      surfaceSeq.current += 1;
      setLoadingSources(false);
      setGroups(null);
      setInventory(null);
      setMode(null);
      setSelectedGroupId("");
      setNotes([]);
    }
    void loadGroups();
  }, [enabled, loadGroups, ports.cribl, tenant]);

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
    startedFor.current = { cribl: ports.cribl, tenant };
    if (mode === null) {
      void loadGroups();
      return;
    }
    if (mode === "live-capture" && selectedGroupId === "") {
      void loadGroups();
      return;
    }
    void loadSurface(mode, selectedGroupId);
  }, [mode, selectedGroupId, loadGroups, loadSurface, ports.cribl, tenant]);

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
