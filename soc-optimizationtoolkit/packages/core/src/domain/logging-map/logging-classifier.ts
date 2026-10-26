/**
 * Is a policy assignment LOGGING-RELATED, and where does it send logs?
 * (Azure Logging Map, AZR-19.)
 *
 * Derived from the DEFINITION, never from an assignment's name: a definition
 * qualifies when its `then.effect` resolves to DeployIfNotExists AND its
 * `then.details.type` is `Microsoft.Insights/diagnosticSettings`, both compared
 * case-insensitively. The effect is resolved from a literal or a
 * `[parameters('x')]` reference: the assignment's value, else the definition's
 * `defaultValue`; through a set, the member's value may itself reference a set
 * parameter, resolved the same way one level up.
 *
 * The destination comes from the definition's PARAMETER NAMES - the names the
 * legacy writer filled (`eventHubAuthorizationRuleId`, `eventHubName`,
 * `dcrResourceId`; frozen BuiltIn:707-742) plus the Log Analytics and storage
 * equivalents.
 *
 * Unknown is a verdict of its own and never "no": a definition that was not
 * read, an effect that cannot be resolved, or a set with ANY member not read
 * is `unknown` (it is always shown, and counted).
 *
 * Pure: no IO, no Date, no randomness. Domain - imports no usecase.
 */

import type {
  DefinitionParameter,
  PolicyAssignment,
  PolicyDefinition,
  PolicySetDefinition,
} from "./logging-map-types";
import { normaliseScopeId } from "./scope-tree";

export type LoggingDestination = "event-hub" | "log-analytics" | "storage" | "dcr";

/** Canonical order, so destination arrays compare exactly. */
export const DESTINATION_ORDER: readonly LoggingDestination[] = [
  "event-hub",
  "log-analytics",
  "storage",
  "dcr",
];

export type LoggingClass =
  | {
      readonly verdict: "yes";
      readonly destinations: readonly LoggingDestination[];
      readonly basis: "known-built-in" | "definition" | "set-members";
    }
  | {
      readonly verdict: "no";
      readonly reason: "not-diagnostic-settings" | "effect-not-deploy";
      /** The resolved effect, when the reason is the effect. */
      readonly effect: string | null;
    }
  | {
      readonly verdict: "unknown";
      readonly reason: "definition-not-read" | "member-not-read" | "effect-unresolved";
      /** Normalised ids of the definitions that were not read. */
      readonly unread: readonly string[];
      /** Destinations of the members that WERE read and qualify. */
      readonly knownDestinations: readonly LoggingDestination[];
    };

/** A built-in initiative whose destination is known without reading it. */
export interface KnownBuiltIn {
  readonly destination: LoggingDestination;
  /**
   * true: short-circuit - classify as logging to `destination` without a read.
   * false: a SEED only - fetch and classify the definition anyway, until the
   * expected destination is confirmed live (AZR-19 live item 3e).
   */
  readonly confirmedLive: boolean;
  readonly source: string;
}

/** Keyed by normalised (lower-case) definition id. */
export const KNOWN_BUILT_IN_DESTINATIONS: ReadonlyMap<string, KnownBuiltIn> = new Map([
  [
    "/providers/microsoft.authorization/policysetdefinitions/85175a36-2f12-419a-96b4-18d5b0096531",
    { destination: "event-hub", confirmedLive: true, source: "BuiltIn:65-72 (AllLogs to Event Hub)" },
  ],
  [
    "/providers/microsoft.authorization/policysetdefinitions/1020d527-2764-4230-92cc-7035e4fcf8a7",
    { destination: "event-hub", confirmedLive: true, source: "BuiltIn:73-80 (Audit to Event Hub)" },
  ],
  [
    "/providers/microsoft.authorization/policysetdefinitions/0884adba-2312-4468-abeb-5422caed1038",
    {
      destination: "log-analytics",
      confirmedLive: false,
      source: "Analyze-ComplianceGaps.ps1:24 calls it the allLogs initiative; destination unconfirmed",
    },
  ],
  [
    "/providers/microsoft.authorization/policysetdefinitions/f5b29bc4-feca-4cc6-a58a-772dd5e290a5",
    {
      destination: "log-analytics",
      confirmedLive: false,
      source: "Analyze-ComplianceGaps.ps1:126 calls it the audit initiative; destination unconfirmed",
    },
  ],
]);

/**
 * The legacy gap analysis's categories, in its order
 * (Analyze-ComplianceGaps.ps1:314-373). Documentation data: phase 1 does not
 * consume it; the compliance overlay (phase 2) will.
 */
export const LEGACY_GAP_CATEGORIES = Object.freeze([
  "infrastructure",
  "covered-all-logs",
  "covered-audit-only",
  "known-gap",
  "potential-gap",
] as const);

export const DIAGNOSTIC_SETTINGS_TYPE = "Microsoft.Insights/diagnosticSettings";
const DINE = "deployifnotexists";
const PARAM_REF = /^\[\s*parameters\(\s*'([^']+)'\s*\)\s*\]$/i;

/** Normalised definition id for lookups. */
export function definitionKey(id: string): string {
  return normaliseScopeId(id);
}

/** True when `policyDefinitionId` is classified without a definition read. */
export function isShortCircuited(policyDefinitionId: string): boolean {
  return KNOWN_BUILT_IN_DESTINATIONS.get(definitionKey(policyDefinitionId))?.confirmedLive === true;
}

/** The definitions available to the classifier, keyed by {@link definitionKey}. */
export interface DefinitionLookup {
  readonly definitions: ReadonlyMap<string, PolicyDefinition>;
  readonly sets: ReadonlyMap<string, PolicySetDefinition>;
}

function getCI<T>(rec: Readonly<Record<string, T>>, name: string): { found: boolean; value: T | undefined } {
  if (Object.prototype.hasOwnProperty.call(rec, name)) return { found: true, value: rec[name] };
  const lower = name.toLowerCase();
  for (const k of Object.keys(rec)) {
    if (k.toLowerCase() === lower) return { found: true, value: rec[k] };
  }
  return { found: false, value: undefined };
}

/** One level of parameter resolution: values set at this level, defaults declared at it. */
interface ParamLevel {
  readonly values: Readonly<Record<string, unknown>>;
  readonly declared: Readonly<Record<string, DefinitionParameter>>;
}

const UNRESOLVED = Symbol("unresolved");

/**
 * Resolve an expression against a chain of levels, innermost first. A
 * `[parameters('x')]` at level i reads level i's value for x, else level i's
 * default; a value that is itself a reference resolves against level i+1.
 */
function resolve(expr: unknown, levels: readonly ParamLevel[], depth = 0): unknown {
  if (typeof expr !== "string") return expr;
  const m = PARAM_REF.exec(expr.trim());
  if (m === null) return expr;
  const level = levels[depth];
  const name = m[1] ?? "";
  if (level === undefined) return UNRESOLVED;
  const set = getCI(level.values, name);
  if (set.found) return resolve(set.value, levels, depth + 1);
  const decl = getCI(level.declared, name);
  if (decl.found && decl.value !== undefined && decl.value.hasDefault) {
    // A default may reference nothing further we can see.
    const d = decl.value.defaultValue;
    return typeof d === "string" && PARAM_REF.test(d.trim()) ? UNRESOLVED : d;
  }
  return UNRESOLVED;
}

/** Destinations named by a definition's declared parameter names. */
export function destinationsFromParameterNames(names: readonly string[]): readonly LoggingDestination[] {
  const found = new Set<LoggingDestination>();
  for (const raw of names) {
    const n = raw.toLowerCase();
    if (n.startsWith("eventhub")) found.add("event-hub");
    if (n === "workspaceid" || n.includes("loganalytics")) found.add("log-analytics");
    if (n.startsWith("storageaccount")) found.add("storage");
    if (n === "dcrresourceid") found.add("dcr");
  }
  return DESTINATION_ORDER.filter((d) => found.has(d));
}

/**
 * Classify one definition, given the parameter levels its effect resolves
 * against (innermost first).
 */
function classifyWithLevels(def: PolicyDefinition, levels: readonly ParamLevel[]): LoggingClass {
  if (def.thenDetailsType.toLowerCase() !== DIAGNOSTIC_SETTINGS_TYPE.toLowerCase()) {
    return { verdict: "no", reason: "not-diagnostic-settings", effect: null };
  }
  const effect = resolve(def.thenEffect, levels);
  if (effect === UNRESOLVED || typeof effect !== "string") {
    return { verdict: "unknown", reason: "effect-unresolved", unread: [], knownDestinations: [] };
  }
  if (effect.toLowerCase() !== DINE) {
    return { verdict: "no", reason: "effect-not-deploy", effect };
  }
  return {
    verdict: "yes",
    destinations: destinationsFromParameterNames(Object.keys(def.parameters)),
    basis: "definition",
  };
}

/** Classify a single definition assigned directly, with the assignment's parameter values. */
export function classifyDefinition(
  def: PolicyDefinition,
  assignmentParameters: Readonly<Record<string, unknown>>,
): LoggingClass {
  return classifyWithLevels(def, [{ values: assignmentParameters, declared: def.parameters }]);
}

/**
 * Classify a set from its members. Any member not in `definitions` makes the
 * set `unknown` - never `no` - carrying the destinations of the members that
 * were read and qualify.
 */
export function classifySet(
  set: PolicySetDefinition,
  assignmentParameters: Readonly<Record<string, unknown>>,
  definitions: ReadonlyMap<string, PolicyDefinition>,
): LoggingClass {
  const setLevel: ParamLevel = { values: assignmentParameters, declared: set.parameters };
  const unread: string[] = [];
  const destinations = new Set<LoggingDestination>();
  let anyYes = false;
  let anyUnresolved = false;
  // Members that ARE diagnostic-settings policies but whose effect resolves to
  // something other than DeployIfNotExists: the set is switched off, not
  // unrelated, so its reason must say so.
  const notDeployEffects = new Map<string, string>(); // lower-case -> first spelling seen
  let anyNotDeploy = false;
  for (const member of set.members) {
    const key = definitionKey(member.policyDefinitionId);
    const def = definitions.get(key);
    if (def === undefined) {
      unread.push(key);
      continue;
    }
    const c = classifyWithLevels(def, [{ values: member.parameters, declared: def.parameters }, setLevel]);
    if (c.verdict === "yes") {
      anyYes = true;
      for (const d of c.destinations) destinations.add(d);
    } else if (c.verdict === "unknown") {
      anyUnresolved = true;
    } else if (c.reason === "effect-not-deploy") {
      anyNotDeploy = true;
      if (c.effect !== null && !notDeployEffects.has(c.effect.toLowerCase())) {
        notDeployEffects.set(c.effect.toLowerCase(), c.effect);
      }
    }
  }
  const known = DESTINATION_ORDER.filter((d) => destinations.has(d));
  if (unread.length > 0) {
    return { verdict: "unknown", reason: "member-not-read", unread, knownDestinations: known };
  }
  if (anyYes) return { verdict: "yes", destinations: known, basis: "set-members" };
  if (anyUnresolved) {
    return { verdict: "unknown", reason: "effect-unresolved", unread: [], knownDestinations: [] };
  }
  if (anyNotDeploy) {
    // One resolved effect is reported; members that disagree report null.
    const only = notDeployEffects.size === 1 ? [...notDeployEffects.values()][0]! : null;
    return { verdict: "no", reason: "effect-not-deploy", effect: only };
  }
  return { verdict: "no", reason: "not-diagnostic-settings", effect: null };
}

/**
 * Classify an assignment: the short-circuit for confirmed built-ins, then its
 * definition or set from `lookup`. A definition not in `lookup` is `unknown`.
 */
export function classifyAssignment(assignment: PolicyAssignment, lookup: DefinitionLookup): LoggingClass {
  const key = definitionKey(assignment.policyDefinitionId);
  const known = KNOWN_BUILT_IN_DESTINATIONS.get(key);
  if (known !== undefined && known.confirmedLive) {
    // The built-in sets take an `effect` parameter; an assignment that set it
    // to anything but DeployIfNotExists deploys nothing.
    const eff = getCI(assignment.parameters, "effect");
    if (eff.found && typeof eff.value === "string" && eff.value.toLowerCase() !== DINE) {
      return { verdict: "no", reason: "effect-not-deploy", effect: eff.value };
    }
    return { verdict: "yes", destinations: [known.destination], basis: "known-built-in" };
  }
  const isSet = assignment.definitionKind === "set" || key.includes("/policysetdefinitions/");
  if (isSet) {
    const set = lookup.sets.get(key);
    if (set === undefined) {
      return { verdict: "unknown", reason: "definition-not-read", unread: [key], knownDestinations: [] };
    }
    return classifySet(set, assignment.parameters, lookup.definitions);
  }
  const def = lookup.definitions.get(key);
  if (def === undefined) {
    return { verdict: "unknown", reason: "definition-not-read", unread: [key], knownDestinations: [] };
  }
  return classifyDefinition(def, assignment.parameters);
}
