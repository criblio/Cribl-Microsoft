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
import { useStoreRefusal } from "../../components/use-store-refusal";

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
        "can be read, so none are overwritten. Until then, Clear learned " +
        "mappings clears only this session's edits and leaves the store " +
        "untouched."
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
 * AN UNREAD STORE IS NOT WRITTEN OVER. Until the load answers - and for good
 * after it is refused - `learned` holds only this session's edits while the
 * store may hold decisions, so writing it would replace them. So:
 *  - a learn waits for the load; after a refused load it re-reads first and
 *    writes stored + every local edit (earlier unsaved ones included); still
 *    refused, it writes nothing and says the edits were not saved;
 *  - a Clear while the store is unread clears only this session's edits and
 *    writes nothing (the read note says so).
 *
 * ONE STORE CALL AT A TIME. Every learn and clear runs on one promise chain
 * that starts with the load, so two Approves can never read the same old
 * value and race their writes. Which answer still counts, and when a note
 * goes away, is useStoreRefusal's "scope" rule: a write's success clears its
 * own kind of note (a learn also clears the read note it has now answered; a
 * clear also clears an unsaved-learn note, whose edits it discarded).
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
   * The last call the store REFUSED for this solution, or null while none
   * stands (DBT-181). Reset when the solution changes; a later success of the
   * same kind clears it. Describe it with {@link describeLearnedRefusal}.
   */
  storeRefused: LearnedRefusal | null;
} {
  const [learned, setLearned] = useState<LearnedMapping[]>([]);
  const {
    refusal: storeRefused,
    track,
    refuse,
    setRefusal,
    reset,
    pin,
  } = useStoreRefusal<LearnedRefusal["action"]>("scope");
  // The learned set as of now, for work queued on the chain (a closure would
  // see the render it was made in).
  const learnedRef = useRef<LearnedMapping[]>([]);
  const apply = useCallback((next: LearnedMapping[]) => {
    learnedRef.current = next;
    setLearned(next);
  }, []);
  // True until the load answers, and for good after it is refused: the
  // store's decisions are unknown, so nothing may be written over them.
  const unreadRef = useRef(true);
  // The load's refusal, so a local-only Clear can put the read note back.
  const readReasonRef = useRef("");
  // Every store call of this scope, in order, starting with the load.
  const chainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    reset();
    unreadRef.current = true;
    readReasonRef.current = "";
    apply([]);
    if (learnedCache === undefined || solutionName === "") {
      chainRef.current = Promise.resolve();
      return;
    }
    chainRef.current = (async () => {
      try {
        const raw = await learnedCache.get(learnedMappingsCacheKey(solutionName));
        if (cancelled) return;
        unreadRef.current = false;
        // Edits approved while the load was in flight win over what it read.
        apply(mergeLearnedMappings(parseLearnedMappings(raw), learnedRef.current));
      } catch (err) {
        // A failed load only disables replay for this session - and is SAID
        // (DBT-181): stored decisions may exist that are not replaying.
        if (cancelled) return;
        readReasonRef.current = String(err);
        refuse("read", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [learnedCache, solutionName, reset, refuse, apply]);

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
      // The edits apply now, whatever the store answers.
      apply(mergeLearnedMappings(learnedRef.current, fresh));
      const key = learnedMappingsCacheKey(solutionName);
      const isCurrent = pin();
      chainRef.current = chainRef.current.then(async () => {
        if (!isCurrent()) return;
        if (unreadRef.current) {
          // See AN UNREAD STORE above: read before writing over it.
          let stored: LearnedMapping[];
          try {
            stored = parseLearnedMappings(await learnedCache.get(key));
          } catch (err) {
            if (isCurrent()) refuse("learn", err);
            return;
          }
          if (!isCurrent()) return;
          unreadRef.current = false;
          // Stored, then every local edit - earlier unsaved ones included.
          apply(mergeLearnedMappings(stored, learnedRef.current));
        }
        await track(learnedCache.set(key, learnedRef.current), "learn", ["learn", "read"]);
      });
    },
    [learnedCache, solutionName, apply, pin, refuse, track],
  );

  const clearLearned = useCallback(() => {
    apply([]);
    if (learnedCache === undefined || solutionName === "") {
      return;
    }
    const key = learnedMappingsCacheKey(solutionName);
    const isCurrent = pin();
    chainRef.current = chainRef.current.then(async () => {
      if (!isCurrent()) return;
      if (unreadRef.current) {
        // Unread decisions are not erased: only this session's edits went,
        // and with them any unsaved-learn note. The read note stands.
        if (readReasonRef.current !== "") {
          setRefusal({ action: "read", reason: readReasonRef.current });
        }
        return;
      }
      await track(learnedCache.set(key, []), "forget", ["forget", "learn"]);
    });
  }, [learnedCache, solutionName, apply, pin, setRefusal, track]);

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
