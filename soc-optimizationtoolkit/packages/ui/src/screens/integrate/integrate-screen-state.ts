/**
 * Integrate screen state - the PURE decisions behind the single-page
 * Integrate arc (legacy-flow-analysis.md, structural decision ADOPTED
 * 2026-07-04), kept out of the component so they are unit-testable without a
 * DOM.
 *
 * @soc/core's integrate-arc owns EVERY section/pill/deploy decision
 * (INTEGRATE_SECTIONS, deriveSectionStatuses, deriveReadinessPills,
 * canDeploy); this module only:
 *
 *   - {@link deriveSectionInputs}: map the screen's raw control values
 *     (committed-scope flag from the shell, the page-owned worker-group and
 *     pack-name fields, the deploy-completed flag) to the core's boolean-only
 *     {@link SectionInputs}. The read-ahead model needs completion signals,
 *     not the underlying values, so this trims and reduces to booleans in ONE
 *     place the component and the core share.
 *   - {@link defaultPackName}: the pack-name prefill. The legacy flagship
 *     derived the pack name from the chosen solution (noise words stripped);
 *     the solution section has not shipped (Unit 14), so until it does the
 *     prefill comes from the persisted Cribl destination prefix (Unit 4
 *     options) - a stable, editable default so the operable native-table
 *     deploy needs no manual pack-name entry to satisfy canDeploy.
 *   - {@link deployDisabledReason}: the single unlock condition the readiness
 *     footer's Deploy button shows when it is disabled - the deploy section's
 *     own blocked reason from the core, never per-screen prose.
 *
 * Pure: no IO, no fetch, no React, no Date, no crypto.
 */

import {
  canDeploy,
  deriveSectionStatus,
  integrateSection,
} from "@soc/core";
import type { CriblOptions, SectionInputs } from "@soc/core";

/**
 * The native table the deploy section seeds - the one the user validated
 * live end to end. It is editable on the page; this is only the default.
 */
export const INTEGRATE_DEFAULT_TABLE = "SecurityEvent";

/** Pack-name prefill when no destination prefix is configured. */
export const FALLBACK_PACK_NAME = "Sentinel-Integration";

/** The raw screen values the component holds before reducing to SectionInputs. */
export interface IntegrateRawInputs {
  /**
   * A Sentinel solution has been selected in the Solution browser (Unit 14).
   * Additive and NON-GATING (like {@link samplesProvided}): completes the
   * now-built Solution section and lights its pill, never gates the deploy.
   */
  solutionSelected: boolean;
  /** Committed-scope flag supplied by the shell (a full target is committed). */
  scopeCommitted: boolean;
  /** The page-owned worker-group selection (Cribl Config section). */
  workerGroup: string;
  /** The page-owned pack-name field (Cribl Config section). */
  packName: string;
  /** Set once a deploy run on this page has finished successfully. */
  deployCompleted: boolean;
  /**
   * How many samples the Sample Data section has tagged (Unit 11). Any positive
   * count satisfies samplesProvided; it completes the Sample Data section and
   * lights the Samples pill but never gates the native-table deploy.
   */
  sampleCount: number;
}

/**
 * Reduce the screen's raw control values to the core's boolean-only
 * completion signals. Whitespace-only worker-group / pack-name values do NOT
 * count as set (the same trim the deploy gate applies), so a stray space can
 * never falsely satisfy a prerequisite.
 */
export function deriveSectionInputs(raw: IntegrateRawInputs): SectionInputs {
  return {
    solutionSelected: raw.solutionSelected,
    scopeCommitted: raw.scopeCommitted,
    workerGroupSelected: raw.workerGroup.trim() !== "",
    packNameSet: raw.packName.trim() !== "",
    deployCompleted: raw.deployCompleted,
    samplesProvided: raw.sampleCount > 0,
  };
}

/** Strip leading/trailing separators (hyphen, underscore, space) from a token. */
function trimSeparators(value: string): string {
  return value.replace(/^[-_\s]+/, "").replace(/[-_\s]+$/, "");
}

/**
 * The pack-name prefill: the persisted Cribl destination prefix with its
 * trailing separator trimmed (e.g. the "MS-Sentinel-" default becomes
 * "MS-Sentinel"), or {@link FALLBACK_PACK_NAME} when no usable prefix is
 * configured. Always non-empty so the pack-name prerequisite is satisfied by
 * default and the operable native-table deploy stays one committed scope
 * away, while the field remains editable on the page.
 */
export function defaultPackName(criblDefaults?: CriblOptions): string {
  const fromPrefix = trimSeparators(criblDefaults?.destinationPrefix ?? "");
  return fromPrefix !== "" ? fromPrefix : FALLBACK_PACK_NAME;
}

/**
 * The readiness footer's Deploy-disabled hint: the deploy section's single
 * unlock condition from the core, or null when the operable deploy can run.
 * A finished deploy never disables re-running (deployCompleted is not a
 * factor in canDeploy), so this returns null once the three built
 * prerequisites are met, regardless of prior runs.
 */
export function deployDisabledReason(inputs: SectionInputs): string | null {
  if (canDeploy(inputs)) {
    return null;
  }
  return deriveSectionStatus(integrateSection("deploy"), inputs).reason ?? null;
}
