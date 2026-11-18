/**
 * The Entra ID tenant diagnostic setting as the onboarding screen DEPLOYS it
 * (AZR-99) - what a correct one looks like, and how to recognise one that
 * already exists.
 *
 * ONE MODULE PER JOB, NOT A THIRD COPY. The audit note on AZR-99 asked for the
 * Entra deploy to be built on the existing pieces rather than a third
 * diagnostic-setting module:
 *
 * - READING a setting is activity-log-export/diagnostic-setting's
 *   readDiagnosticSetting, the one reading Validate and the Activity Log
 *   deploy already share.
 * - The BODY and the request paths are entra-diagnostic-setting's
 *   entraDiagnosticBody / buildEntraSettingPutRequest, the same body the
 *   How-to step shows (so what the operator is told to PUT by hand is what
 *   Deploy writes).
 * - This file holds only what is Entra-specific about COMPARING: the chosen
 *   categories (a profile, not "every category"), the hub Azure creates per
 *   category, and which other settings would duplicate the stream.
 *
 * THE SETTING IS THE HOW-TO'S. Name {@link ENTRA_SETTING_NAME} (the legacy
 * script's CriblEntraIDLogs), eventHubName empty so Azure creates one hub per
 * category, the plan's Send rule, the chosen profile's categories enabled and
 * every other category written as disabled (see buildEntraDiagnosticRequest
 * for why a disabled category is sent rather than left out).
 *
 * NOTHING IS REPLACED. A PUT replaces the setting whole and the tenant has ONE
 * Entra diagnostic-settings list, shared by every team. So:
 * {@link classifyOursEntraSetting} finds a setting under our name (whoever made
 * it - a hand-made one following the How-to is matched, never overwritten),
 * and {@link findOverlappingEntraSettings} finds any OTHER setting already
 * sending one of the chosen categories to the same namespace.
 *
 * LICENCES ARE A NOTE, NOT A GATE. Some categories carry data only with a
 * licence (entra-categories `licence`). The app cannot read a tenant's
 * licences; Azure's answer at the PUT, and the read-back (which names every
 * chosen category that did not come back enabled), are what say so.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto.
 */

import type { NamespaceRef } from "../eventhub-arm/eventhub-arm";
import { eventHubNamespacePath, namespaceRuleResourceId } from "../eventhub-arm/eventhub-arm";
import type { Listing } from "../inventory-listing/inventory-listing";
import { listingRows, listingWasRead } from "../inventory-listing/inventory-listing";
import type { OnboardingSourceId } from "../onboarding-howto/sources";
import type { DiagnosticSettingRead } from "../activity-log-export/diagnostic-setting";
import { settingTargetsNamespace } from "../activity-log-export/diagnostic-setting";
import type { OursSettingState, SettingDiff } from "../activity-log-export/activity-log-setting";
import { ENTRA_CATEGORIES } from "./entra-categories";
import type { EntraDiagnosticInput } from "./entra-diagnostic-setting";
import { DEFAULT_SETTING_NAME, entraSettingPath } from "./entra-diagnostic-setting";

/** The coverage-catalog item (and How-to source) this setting deploys. */
export const ENTRA_ITEM_ID = "entraId" satisfies OnboardingSourceId;

/** The setting's name: the How-to step's and Validate's, spelled once (DEFAULT_SETTING_NAME). */
export const ENTRA_SETTING_NAME = DEFAULT_SETTING_NAME;

/** What the hub field reads when Azure picks the hubs, for the operator's copy. */
export const ENTRA_AUTO_HUB_TEXT = "one hub per category, created by Azure";

/** What the Deploy writes. No secret: a diagnostic setting takes the rule id. */
export interface EntraSettingInput {
  /** The namespace, located by the plan's Event Hub keys (planNamespace / eventHubLocation). */
  readonly namespace: NamespaceRef;
  /** The plan's Send rule on that namespace. */
  readonly ruleName: string;
  /** The chosen profile's categories (entraCategoriesFor). */
  readonly categories: readonly string[];
}

/** What a correctly-written setting must look like. */
export interface ExpectedEntraSetting {
  readonly ruleId: string;
  readonly categories: readonly string[];
}

function same(a: string, b: string): boolean {
  // ARM ids, names and category names compare case-insensitively.
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Our setting's ARM path, which is also its id. */
export function entraOurSettingPath(): string {
  return entraSettingPath(ENTRA_SETTING_NAME);
}

/** The setting the Deploy writes, as the body builder takes it. */
export function entraDiagnosticInputFor(input: EntraSettingInput): EntraDiagnosticInput {
  return {
    eventHubAuthorizationRuleId: namespaceRuleResourceId(input.namespace, input.ruleName),
    eventHubName: "",
    categories: input.categories,
    settingName: ENTRA_SETTING_NAME,
  };
}

/** The shape the Deploy's PUT writes, for comparing a read-back. */
export function expectedEntraSetting(input: EntraSettingInput): ExpectedEntraSetting {
  return { ruleId: namespaceRuleResourceId(input.namespace, input.ruleName), categories: input.categories };
}

/**
 * Chosen names this app cannot express to Azure, sorted. The deploy refuses
 * BY NAME rather than dropping them (the body builder would drop them
 * silently, so the check has to come first).
 */
export function unknownEntraCategories(categories: readonly string[]): string[] {
  return categories.filter((c) => !ENTRA_CATEGORIES.some((k) => same(k.name, c))).sort();
}

function isNamespaceRuleId(ruleId: string): boolean {
  return /\/providers\/microsoft\.eventhub\/namespaces\/[^/]+\/authorizationrules\/[^/]+$/i.test(ruleId);
}

/**
 * Every field where `observed` falls short of the setting the Deploy writes,
 * named as the ARM body names it. Empty means it matches.
 *
 * With `expected`, the rule must be the expected one and the enabled
 * categories must be EXACTLY the chosen ones: a chosen category missing is
 * named (an unlicensed category the tenant would not take shows up here), and
 * an extra one enabled is named too (more data than was chosen). Without it -
 * classifying before a target is chosen - any namespace rule and any non-empty
 * set of named categories is enough.
 */
export function entraSettingDiffs(
  expected: ExpectedEntraSetting | undefined,
  observed: DiagnosticSettingRead,
): SettingDiff[] {
  const diffs: SettingDiff[] = [];
  if (expected !== undefined) {
    if (!same(observed.ruleId, expected.ruleId)) {
      diffs.push({ field: "eventHubAuthorizationRuleId", expected: expected.ruleId, actual: observed.ruleId || "(none)" });
    }
  } else if (!isNamespaceRuleId(observed.ruleId)) {
    diffs.push({
      field: "eventHubAuthorizationRuleId",
      expected: "an Event Hub namespace authorization rule",
      actual: observed.ruleId || "(none)",
    });
  }
  if (observed.hub !== "") {
    diffs.push({ field: "eventHubName", expected: `(none: ${ENTRA_AUTO_HUB_TEXT})`, actual: observed.hub });
  }
  const problems: string[] = [];
  if (observed.enabledGroups.length > 0) problems.push(`category groups enabled: ${observed.enabledGroups.join(", ")}`);
  if (expected !== undefined) {
    const off = expected.categories.filter((c) => !observed.enabled.some((e) => same(e, c)));
    const extra = observed.enabled.filter((e) => !expected.categories.some((c) => same(c, e)));
    if (off.length > 0) problems.push(`not enabled: ${off.join(", ")}`);
    if (extra.length > 0) problems.push(`enabled but not chosen: ${extra.join(", ")}`);
  } else if (observed.enabled.length === 0 && observed.enabledGroups.length === 0) {
    problems.push("none enabled");
  }
  if (problems.length > 0) {
    diffs.push({
      field: "logs",
      expected: expected === undefined ? "named categories enabled" : `exactly ${expected.categories.join(", ")}`,
      actual: problems.join("; "),
    });
  }
  return diffs;
}

/**
 * Find {@link ENTRA_SETTING_NAME} in the tenant's listing, by name
 * (case-insensitively). Only `present-matching` means deployed - "already
 * applied", whoever made it.
 */
export function classifyOursEntraSetting(
  listing: Listing<DiagnosticSettingRead>,
  expected?: ExpectedEntraSetting,
): OursSettingState {
  const ours = listingRows(listing).find((s) => same(s.name, ENTRA_SETTING_NAME));
  if (ours === undefined) return { kind: "absent", measured: listingWasRead(listing) };
  const diffs = entraSettingDiffs(expected, ours);
  return diffs.length === 0
    ? { kind: "present-matching", setting: ours }
    : { kind: "present-differs", setting: ours, diffs };
}

/**
 * Every OTHER setting (any name but ours) that sends to the chosen namespace
 * AND enables one of the chosen categories, or a category group (which may
 * include them). Deploying beside one would put a second copy of those events
 * into the hubs Cribl reads. A setting on the same namespace with no chosen
 * category in common duplicates nothing and is not returned.
 */
export function findOverlappingEntraSettings(
  listing: Listing<DiagnosticSettingRead>,
  namespace: NamespaceRef,
  categories: readonly string[],
): DiagnosticSettingRead[] {
  const nsPath = eventHubNamespacePath(namespace);
  return listingRows(listing).filter(
    (s) =>
      !same(s.name, ENTRA_SETTING_NAME) &&
      settingTargetsNamespace(s, nsPath) &&
      (s.enabledGroups.length > 0 || s.enabled.some((e) => categories.some((c) => same(c, e)))),
  );
}
