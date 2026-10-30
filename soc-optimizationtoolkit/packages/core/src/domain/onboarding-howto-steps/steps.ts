/**
 * How-to steps - WHAT THE APP WOULD HAVE DONE IN AZURE, WRITTEN DOWN AS STEPS.
 *
 * AZR-31. An operator who will not let the app write Azure follows these
 * instead. Each step is DATA: a title, why it is needed, portal steps, a CLI
 * template, a computed values table, the rights it needs, how to confirm it,
 * which Validate checks look at it, and where its content came from (D6).
 *
 * TEMPLATES ARE WRITTEN AGAINST PLAN VALUES. A placeholder is `{{key}}` where
 * key is a {@link PlanValueKey}; {@link templatePlaceholders} lists them, and a
 * pin holds them EQUAL to the step's `dependsOnValues`, so a stale-tick
 * fingerprint (D5) covers exactly the values the instructions print. The
 * computed `values` table uses the same keys only - also pinned.
 *
 * NOTHING IS RETYPED THAT ALREADY EXISTS AS CODE. Names, api-versions,
 * categories, role lists and request paths come from the builders and
 * constants the automated path and the labs use (cited per step). Names that
 * exist only in the frozen legacy scripts are declared once, in
 * policy-steps.ts, and pinned against the logging-map LEGACY_WRITER patterns.
 *
 * PROVENANCE. `repo` means the content follows code or a frozen script in this
 * repository. `inferred` means it is Azure knowledge nobody has confirmed
 * against live Azure yet; the dialog shows a visible tag for those.
 *
 * NO CREDENTIAL EVER APPEARS. A step may say where a connection string comes
 * from; it never prints one, nor a key, nor a password.
 *
 * Visible copy carries no card ids and no dates. The CLI templates carry Azure
 * api-versions, which are date-shaped by Azure's design; they are not history.
 *
 * Pure: no IO, no fetch, no React, no clock, no randomness, no crypto
 */

import type { CheckKind } from "../onboarding-howto/check-kinds";
import type { PlanValueKey, PlanValues } from "../onboarding-howto/plan-values";
import type { OnboardingSourceId } from "../onboarding-howto/sources";
import { onboardingSource } from "../onboarding-howto/sources";
import { BLOB_STEPS } from "./blob-steps";
import { DEFENDER_STEPS } from "./defender-steps";
import { ACTIVITY_LOG_STEPS, ENTRA_STEPS } from "./entra-activity-steps";
import { EVENTHUB_STEPS } from "./eventhub-steps";
import { POLICY_STEPS } from "./policy-steps";
import { XDR_STEPS } from "./xdr-steps";

/** Where a step's content came from. `inferred` is tagged in the UI. */
export type StepProvenance = "repo" | "inferred";

/** One row of a step's computed values table. */
export interface StepValueRow {
  readonly label: string;
  readonly value: string;
}

/** One guided step. All text fields may carry `{{planValueKey}}` placeholders. */
export interface HowToStep {
  /** Stable: done ticks are keyed by it in the progress document. */
  readonly id: string;
  /** Every source that needs this step. A shared step is ticked once. */
  readonly sourceIds: readonly OnboardingSourceId[];
  readonly title: string;
  readonly why: string;
  /** Portal steps, in order. */
  readonly portal: readonly string[];
  /** A CLI template; `''` when there is no command (a confirm-only step). */
  readonly cli: string;
  /**
   * The exact names and bodies the app would have used, computed from the plan
   * values (already filled with placeholders for unset keys by the renderer)
   * and the source's sub-selection.
   */
  readonly values: (values: PlanValues, subSelection: readonly string[]) => readonly StepValueRow[];
  /** The rights needed, one line each. */
  readonly rbac: readonly string[];
  /** How the operator confirms it worked. */
  readonly confirmHow: string;
  /** The plan values this step's text depends on. Equal to its placeholders. */
  readonly dependsOnValues: readonly PlanValueKey[];
  /** The Validate checks that look at what this step creates. */
  readonly checkKinds: readonly CheckKind[];
  readonly provenance: StepProvenance;
  readonly warning?: string;
}

/** Matches one `{{key}}` placeholder. */
export const PLACEHOLDER = /\{\{([A-Za-z]+)\}\}/g;

/** The text fields that may carry placeholders. */
export function templateTexts(step: HowToStep): readonly string[] {
  return [
    step.title,
    step.why,
    ...step.portal,
    step.cli,
    ...step.rbac,
    step.confirmHow,
    step.warning ?? "",
  ];
}

/** Every placeholder key used in the step's templates, de-duplicated, sorted. */
export function templatePlaceholders(step: HowToStep): readonly string[] {
  const keys = new Set<string>();
  for (const text of templateTexts(step)) {
    for (const m of text.matchAll(PLACEHOLDER)) keys.add(m[1]);
  }
  return [...keys].sort();
}

/**
 * Every step, in the order a source lists them: the shared Event Hub steps
 * first, then the policy, Activity Log, Entra, Defender, XDR and blob steps.
 */
export const ALL_HOWTO_STEPS: readonly HowToStep[] = [
  ...EVENTHUB_STEPS,
  ...POLICY_STEPS,
  ...ACTIVITY_LOG_STEPS,
  ...ENTRA_STEPS,
  ...DEFENDER_STEPS,
  ...XDR_STEPS,
  ...BLOB_STEPS,
];

/** Step lookup by id. `undefined` for an unknown id; never throws. */
export function howToStep(id: string): HowToStep | undefined {
  return ALL_HOWTO_STEPS.find((s) => s.id === id);
}

/**
 * The steps one source needs, shared Event Hub steps first. The sub-selection
 * is accepted for symmetry with the values tables; no step is dropped by it
 * today, because every sub-selection still needs the same Azure objects.
 */
export function stepsFor(
  sourceId: OnboardingSourceId,
  _subSelection: readonly string[] = [],
): readonly HowToStep[] {
  if (onboardingSource(sourceId) === undefined) return [];
  return ALL_HOWTO_STEPS.filter((s) => s.sourceIds.includes(sourceId));
}

/**
 * Steps that another step REPLACES when both would be shown. Both create the
 * same plan value (`sendRule`) with different rights: the Defender export needs
 * Send, the sources whose hubs Azure creates need Manage (which includes Send).
 * Showing both makes the operator create a Send-only rule and then fail to
 * create it again with Manage, so the Manage step serves both.
 */
export const SUPERSEDED_STEPS: Readonly<Record<string, string>> = {
  "eh-rule-send": "eh-rule-diagnostic",
};

/**
 * The steps a whole selection needs: every chosen source's steps, each shared
 * step once, in catalog order (shared Event Hub steps first), with every
 * {@link SUPERSEDED_STEPS} entry dropped when its replacement is present.
 * This is the list a guide over several sources shows; {@link stepsFor} is
 * one source on its own.
 */
export function stepsForSelection(
  sourceIds: readonly OnboardingSourceId[],
): readonly HowToStep[] {
  const ids = new Set<string>();
  for (const id of sourceIds) for (const step of stepsFor(id)) ids.add(step.id);
  return ALL_HOWTO_STEPS.filter((s) => {
    if (!ids.has(s.id)) return false;
    const replacement = SUPERSEDED_STEPS[s.id];
    return replacement === undefined || !ids.has(replacement);
  });
}

