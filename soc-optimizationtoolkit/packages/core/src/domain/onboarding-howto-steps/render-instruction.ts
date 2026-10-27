/**
 * Render a How-to step against the operator's plan values: every `{{key}}`
 * placeholder becomes the value, and an UNSET value becomes a visible
 * `<key>` stand-in (see {@link unsetPlaceholder}), never an empty string and
 * never `undefined` - an instruction with a silent gap in a resource id reads
 * as complete and is not.
 *
 * The computed values table is built from the same filled values, so a path
 * shows `<namespace>` exactly where the instructions do.
 *
 * Pure: no IO, no fetch, no React, no clock, no randomness, no crypto
 */

import type { CheckKind } from "../onboarding-howto/check-kinds";
import {
  PLAN_VALUE_KEYS,
  isPlanValueKey,
  missingValues,
  type PlanValueKey,
  type PlanValues,
} from "../onboarding-howto/plan-values";
import { PLACEHOLDER, type HowToStep, type StepProvenance, type StepValueRow } from "./steps";

/** What an unset plan value renders as. */
export function unsetPlaceholder(key: PlanValueKey): string {
  return `<${key}>`;
}

/** The plan values with every blank key replaced by its stand-in. Trims set values. */
export function filledPlanValues(values: PlanValues): PlanValues {
  const out = {} as Record<PlanValueKey, string>;
  for (const key of PLAN_VALUE_KEYS) {
    const value = (values[key] ?? "").trim();
    out[key] = value === "" ? unsetPlaceholder(key) : value;
  }
  return out;
}

/** Substitute every `{{key}}` in `template`. An unknown key is left as written. */
export function fillTemplate(template: string, filled: PlanValues): string {
  return template.replace(PLACEHOLDER, (whole, key: string) =>
    isPlanValueKey(key) ? filled[key] : whole,
  );
}

/** A step ready for the dialog. */
export interface RenderedStep {
  readonly id: string;
  readonly title: string;
  readonly why: string;
  readonly portal: readonly string[];
  readonly cli: string;
  readonly values: readonly StepValueRow[];
  readonly rbac: readonly string[];
  readonly confirmHow: string;
  readonly warning: string | null;
  readonly provenance: StepProvenance;
  /** Shown as a visible tag when the content is not confirmed against live Azure. */
  readonly unverified: boolean;
  /** The plan values this step needs that are unset, in dependsOnValues order. */
  readonly missing: readonly PlanValueKey[];
  readonly dependsOnValues: readonly PlanValueKey[];
  readonly checkKinds: readonly CheckKind[];
}

/** Render one step against the plan values and the source's sub-selection. */
export function renderStep(
  step: HowToStep,
  values: PlanValues,
  subSelection: readonly string[] = [],
): RenderedStep {
  const filled = filledPlanValues(values);
  const fill = (t: string) => fillTemplate(t, filled);
  return {
    id: step.id,
    title: fill(step.title),
    why: fill(step.why),
    portal: step.portal.map(fill),
    cli: fill(step.cli),
    values: step.values(filled, subSelection).map((r) => ({ label: r.label, value: r.value })),
    rbac: step.rbac.map(fill),
    confirmHow: fill(step.confirmHow),
    warning: step.warning === undefined ? null : fill(step.warning),
    provenance: step.provenance,
    unverified: step.provenance === "inferred",
    missing: missingValues(values, step.dependsOnValues),
    dependsOnValues: step.dependsOnValues,
    checkKinds: step.checkKinds,
  };
}

/** Every visible string of a rendered step, for copy checks and deep scans. */
export function renderedTexts(r: RenderedStep): readonly string[] {
  return [
    r.title,
    r.why,
    ...r.portal,
    r.cli,
    ...r.values.flatMap((v) => [v.label, v.value]),
    ...r.rbac,
    r.confirmHow,
    r.warning ?? "",
  ];
}

/**
 * THE ONE REVIEWED ALLOWANCE FOR DATES IN HOW-TO COPY. Azure api-versions are
 * date-shaped by Azure's design (`api-version=2019-01-01`); in a CLI they are
 * part of the command, not project history. Every copy-history check over
 * rendered steps (the ui package's findHistoryInCopy, run by the How-to state,
 * panel and screen tests) scans {@link copyCheckTexts}, which masks exactly
 * these values and nothing else. A date anywhere else still fails the check.
 */
export const API_VERSION_COPY_ALLOWANCE = /(api-version=)\d{4}-\d{2}-\d{2}(?:-preview)?/g;

/** What an allowed api-version reads as in {@link copyCheckTexts}. */
export const API_VERSION_MASK = "<api-version>";

/**
 * The rendered step's visible strings for a copy-history check: the same
 * strings as {@link renderedTexts}, with only the allowed api-version values
 * masked.
 */
export function copyCheckTexts(r: RenderedStep): readonly string[] {
  return renderedTexts(r).map((t) => t.replace(API_VERSION_COPY_ALLOWANCE, `$1${API_VERSION_MASK}`));
}
