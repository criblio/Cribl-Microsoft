/**
 * MappingReviewSection's stateful hooks (extracted in the 2026-07-12
 * maintainability pass; behavior unchanged). Each hook owns ONE concern the
 * component previously interleaved:
 *
 *  - {@link useLearnedMappings}: the reviewer-feedback loop - load the
 *    solution's persisted decisions, expose them for Phase-0 replay, and
 *    persist freshly diffed hand edits on approval; a refused store call is
 *    kept and described for the section to say (DBT-181).
 *  - {@link useEnrichmentFields}: the global + per-table enrichment
 *    constants (fields the source never carries that the pipeline adds),
 *    merged per log type and reported upward.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  diffLearnedMappings,
  learnedMappingsCacheKey,
  mergeLearnedMappings,
  parseLearnedMappings,
} from "@soc/core";
import type { ContentCache, GapReport, LearnedMapping } from "@soc/core";
import { mergeEnrichments } from "../pipeline-preview/pipeline-preview-state";
import type { EnrichmentField } from "../pipeline-preview/pipeline-preview-state";

/** The subset of the review store the learned differ needs per report. */
export type EffectiveMappingsOf = (report: GapReport) => ReadonlyArray<{
  source: string;
  dest: string;
  action: string;
}>;

/** Which learned-mappings store call was refused, and why (DBT-181). */
export interface LearnedRefusal {
  /** The call the store refused: the load, an Approve's learn, or a Clear. */
  action: "read" | "learn" | "forget";
  /** The thrown error, stringified. */
  reason: string;
}

/**
 * The operator-facing sentence for a refusal. Each call has its own
 * consequence: a refused read means stored decisions may exist and are not
 * replaying (and an Approve will not write over them until they read); a
 * refused learn means the approved edits apply now and are gone next session;
 * a refused forget means the cleared decisions may come back.
 */
export function describeLearnedRefusal(refusal: LearnedRefusal): string {
  switch (refusal.action) {
    case "read":
      return (
        `Learned decisions for this solution could not be read ` +
        `(${refusal.reason}), so none are being replayed. Approving still ` +
        "applies your edits; they are saved only once the stored decisions " +
        "can be read, so none are overwritten."
      );
    case "learn":
      return (
        `The approved hand edits could not be saved as learned decisions ` +
        `(${refusal.reason}). They apply now but will not replay on the next ` +
        "analysis."
      );
    case "forget":
      return (
        `The learned decisions could not be cleared (${refusal.reason}). They ` +
        "are not applied now, but they may replay on the next analysis."
      );
  }
}

/**
 * The learned-mappings loop: loaded per solution, replayed into Phase 0
 * AHEAD of the vendor packs by the caller, extended with the diffed hand
 * edits on every APPROVE. A failed load only disables replay for the
 * session; a failed save never blocks the approval (fire-and-forget).
 *
 * A REFUSED STORE IS SAID, NOT SWALLOWED (DBT-181). Since DBT-145 the KV store
 * throws on a non-encrypted 403. All three calls survived that silently: a
 * refused read looked like nothing learned, a refused learn lost the approved
 * edits next session, and a refused Clear emptied the bar while the store kept
 * every decision. The hook keeps the LAST refusal - which call, and why - for
 * the section to say, and only while the solution it was asked under is still
 * the current one, so a late answer from the last solution claims nothing.
 *
 * AN UNREAD STORE IS NOT WRITTEN OVER. After a refused load `learned` is empty
 * while the store may hold decisions, so writing merge([], fresh) would
 * replace them with only this Approve's edits. A learn after a refused load
 * re-reads first and merges over what it finds; still refused, it writes
 * nothing and says the edits were not saved.
 */
export function useLearnedMappings(
  learnedCache: ContentCache | undefined,
  solutionName: string,
): {
  learned: LearnedMapping[];
  persistLearned: (
    toLearn: readonly GapReport[],
    effectiveOf: EffectiveMappingsOf,
  ) => void;
  /** Forget every learned decision for this solution (store + state). */
  clearLearned: () => void;
  /**
   * The last call the store REFUSED for this solution, or null while none has
   * (DBT-181). Reset when the solution changes. Describe it with
   * {@link describeLearnedRefusal}.
   */
  storeRefused: LearnedRefusal | null;
} {
  const [learned, setLearned] = useState<LearnedMapping[]>([]);
  const [storeRefused, setStoreRefused] = useState<LearnedRefusal | null>(null);
  // The scope a write's late answer must still belong to: replaced whenever
  // the solution (or store) changes, so a refusal from the last one is dropped.
  const scopeRef = useRef<object>({});
  // True while this scope's stored decisions are unknown (the load was
  // refused): a learn must then read before it writes.
  const unreadRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    scopeRef.current = {};
    unreadRef.current = false;
    setLearned([]);
    setStoreRefused(null);
    if (learnedCache === undefined || solutionName === "") {
      return;
    }
    void (async () => {
      try {
        const raw = await learnedCache.get(learnedMappingsCacheKey(solutionName));
        if (!cancelled) {
          setLearned(parseLearnedMappings(raw));
        }
      } catch (err) {
        // A failed load only disables replay for this session - and is SAID
        // (DBT-181): stored decisions may exist that are not replaying.
        if (!cancelled) {
          unreadRef.current = true;
          setStoreRefused({ action: "read", reason: String(err) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [learnedCache, solutionName]);

  const persistLearned = useCallback(
    (toLearn: readonly GapReport[], effectiveOf: EffectiveMappingsOf) => {
      if (learnedCache === undefined || solutionName === "") {
        return;
      }
      const fresh = toLearn.flatMap((report) =>
        diffLearnedMappings(
          report.fieldMappings.map((m) => ({
            source: m.source,
            dest: m.dest,
            action: m.action,
          })),
          effectiveOf(report),
        ),
      );
      if (fresh.length === 0) {
        return;
      }
      const key = learnedMappingsCacheKey(solutionName);
      const scope = scopeRef.current;
      const refuseLearn = (err: unknown) => {
        if (scopeRef.current !== scope) return;
        setStoreRefused({ action: "learn", reason: String(err) });
      };
      if (!unreadRef.current) {
        const merged = mergeLearnedMappings(learned, fresh);
        setLearned(merged);
        void learnedCache.set(key, merged).catch(refuseLearn);
        return;
      }
      // The load was refused: the edits apply now either way, but the store
      // is written only over what it holds (see AN UNREAD STORE above).
      setLearned((current) => mergeLearnedMappings(current, fresh));
      void (async () => {
        let stored: LearnedMapping[];
        try {
          stored = parseLearnedMappings(await learnedCache.get(key));
        } catch (err) {
          refuseLearn(err);
          return;
        }
        if (scopeRef.current !== scope) return;
        unreadRef.current = false;
        const merged = mergeLearnedMappings(stored, fresh);
        setLearned(merged);
        setStoreRefused(null);
        try {
          await learnedCache.set(key, merged);
        } catch (err) {
          refuseLearn(err);
        }
      })();
    },
    [learnedCache, solutionName, learned],
  );

  const clearLearned = useCallback(() => {
    setLearned([]);
    if (learnedCache === undefined || solutionName === "") {
      return;
    }
    const scope = scopeRef.current;
    void learnedCache.set(learnedMappingsCacheKey(solutionName), []).then(
      () => {
        // Cleared: whatever was stored is now known to be nothing.
        if (scopeRef.current === scope) unreadRef.current = false;
      },
      (err: unknown) => {
        if (scopeRef.current !== scope) return;
        setStoreRefused({ action: "forget", reason: String(err) });
      },
    );
  }, [learnedCache, solutionName]);

  return { learned, persistLearned, clearLearned, storeRefused };
}

/**
 * The enrichment constants (user-added fields the pipeline adds): a GLOBAL
 * list applied to every table plus per-table additions (per-table wins on a
 * field-name collision), merged per log type and reported upward via
 * onEnrichmentsChange. Values are quote-stripped so a paste cannot break the
 * generated Eval YAML.
 */
export function useEnrichmentFields(
  reports: readonly GapReport[],
  isValidFieldName: (name: string) => boolean,
  onEnrichmentsChange?: (
    byLogType: Readonly<Record<string, EnrichmentField[]>>,
  ) => void,
): {
  globalEnrichments: EnrichmentField[];
  tableEnrichments: Record<string, EnrichmentField[]>;
  addEnrichment: (logType: string | null, field: string, value: string) => boolean;
  removeEnrichment: (logType: string | null, field: string) => void;
  /** Forget every per-table enrichment of one log type (its sample was removed). */
  forgetLogType: (logType: string) => void;
} {
  const [globalEnrichments, setGlobalEnrichments] = useState<EnrichmentField[]>(
    [],
  );
  const [tableEnrichments, setTableEnrichments] = useState<
    Record<string, EnrichmentField[]>
  >({});

  const mergedEnrichments = useMemo(() => {
    const byLogType: Record<string, EnrichmentField[]> = {};
    for (const report of reports) {
      const merged = mergeEnrichments(
        globalEnrichments,
        tableEnrichments[report.logType] ?? [],
      );
      if (merged.length > 0) {
        byLogType[report.logType] = merged;
      }
    }
    return byLogType;
  }, [reports, globalEnrichments, tableEnrichments]);

  useEffect(() => {
    onEnrichmentsChange?.(mergedEnrichments);
  }, [mergedEnrichments, onEnrichmentsChange]);

  const addEnrichment = useCallback(
    (logType: string | null, field: string, value: string) => {
      const name = field.trim();
      // Values are emitted inside a single-quoted Eval expression - strip
      // quotes so a paste cannot break the generated YAML.
      const safeValue = value.trim().replace(/['"]/g, "");
      if (!isValidFieldName(name) || safeValue === "") {
        return false;
      }
      const entry: EnrichmentField = { field: name, value: safeValue };
      if (logType === null) {
        setGlobalEnrichments((prev) => [
          ...prev.filter((e) => e.field !== name),
          entry,
        ]);
      } else {
        setTableEnrichments((prev) => ({
          ...prev,
          [logType]: [
            ...(prev[logType] ?? []).filter((e) => e.field !== name),
            entry,
          ],
        }));
      }
      return true;
    },
    [isValidFieldName],
  );

  const removeEnrichment = useCallback(
    (logType: string | null, field: string) => {
      if (logType === null) {
        setGlobalEnrichments((prev) => prev.filter((e) => e.field !== field));
      } else {
        setTableEnrichments((prev) => ({
          ...prev,
          [logType]: (prev[logType] ?? []).filter((e) => e.field !== field),
        }));
      }
    },
    [],
  );

  // Without this a removed log type's constants sat in state, invisible, and
  // came back if a sample with the same name was added later.
  const forgetLogType = useCallback((logType: string) => {
    setTableEnrichments((prev) => {
      if (!Object.prototype.hasOwnProperty.call(prev, logType)) return prev;
      const next = { ...prev };
      delete next[logType];
      return next;
    });
  }, []);

  return {
    globalEnrichments,
    tableEnrichments,
    addEnrichment,
    removeEnrichment,
    forgetLogType,
  };
}
