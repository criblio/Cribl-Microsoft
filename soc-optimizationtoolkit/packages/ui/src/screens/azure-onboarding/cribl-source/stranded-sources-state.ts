/**
 * The decision behind StrandedSourcesNotice (AZR-96): what the read-only check
 * of the legacy progress key means against the tenant's current progress.
 * Pure; the component only renders it.
 */

import { strandedCriblSources } from "@soc/core";
import type { OnboardingProgress, StrandedCriblSource, StrandedLegacyRead } from "@soc/core";

export type StrandedNotice =
  | { readonly kind: "unknown"; readonly reason: string }
  | {
      readonly kind: "records";
      readonly attribution: "this-tenant" | "unattributed";
      readonly records: readonly StrandedCriblSource[];
    };

/** What to show for the legacy read against the tenant's current progress; null shows nothing. */
export function strandedNoticeOf(
  read: StrandedLegacyRead | null,
  progress: OnboardingProgress | null,
): StrandedNotice | null {
  if (read === null || read.kind === "none") return null;
  if (read.kind === "unknown") return { kind: "unknown", reason: read.reason };
  if (progress === null) return null;
  const records = strandedCriblSources(progress, read.value);
  if (records.length === 0) return null;
  return {
    kind: "records",
    attribution: read.kind === "stranded" ? "this-tenant" : "unattributed",
    records,
  };
}
