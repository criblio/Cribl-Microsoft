/**
 * MappingReviewSection's stateful hooks (extracted in the 2026-07-12
 * maintainability pass; behavior unchanged). Each hook owns ONE concern the
 * component previously interleaved:
 *
 *  - {@link useLearnedMappings}: the reviewer-feedback loop - load the
 *    solution's persisted decisions, expose them for Phase-0 replay, and
 *    persist freshly diffed hand edits on approval.
 *  - {@link useEnrichmentFields}: the global + per-table enrichment
 *    constants (fields the source never carries that the pipeline adds),
 *    merged per log type and reported upward.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
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

/**
 * The learned-mappings loop: loaded per solution, replayed into Phase 0
 * AHEAD of the vendor packs by the caller, extended with the diffed hand
 * edits on every APPROVE. A failed load only disables replay for the
 * session; a failed save never blocks the approval (fire-and-forget).
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
} {
  const [learned, setLearned] = useState<LearnedMapping[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLearned([]);
    if (learnedCache === undefined || solutionName === "") {
      return;
    }
    void (async () => {
      try {
        const raw = await learnedCache.get(learnedMappingsCacheKey(solutionName));
        if (!cancelled) {
          setLearned(parseLearnedMappings(raw));
        }
      } catch {
        // A failed load only disables replay for this session.
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
      const merged = mergeLearnedMappings(learned, fresh);
      setLearned(merged);
      void learnedCache
        .set(learnedMappingsCacheKey(solutionName), merged)
        .catch(() => undefined);
    },
    [learnedCache, solutionName, learned],
  );

  return { learned, persistLearned };
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

  return { globalEnrichments, tableEnrichments, addEnrichment, removeEnrichment };
}
