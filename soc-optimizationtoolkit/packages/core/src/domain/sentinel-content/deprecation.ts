/**
 * Solution deprecation heuristics (porting-plan Unit 14; verbatim from
 * sentinel-repo.ts listSolutions 739-803).
 *
 * The legacy classified deprecation by reading files off the local mirror; here
 * the logic is a PURE CLASSIFIER over inputs the adapter gathers lazily (the
 * solution's directory name, the text of its Data/Solution_*.json files, and the
 * text of its Data Connectors/*.json files). Same three layers, same early-
 * return order, same reason strings - these are the characterization pin.
 *
 * The load-bearing rule is layer 3: a solution is flagged only when ALL of its
 * connectors carry the [Deprecated] tag ("some solutions have both old and new",
 * sentinel-repo.ts 791) - a single deprecated connector among live ones does NOT
 * deprecate the solution.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

/** Directory-name substrings (lowercased) that mark a solution legacy. */
export const DEPRECATION_NAME_MARKERS: readonly string[] = Object.freeze([
  "legacy",
  "deprecated",
]);

/**
 * Lowercased substrings in a Data/Solution_*.json that mark deprecation
 * (sentinel-repo.ts 766-767).
 */
export const SOLUTION_DATA_DEPRECATION_MARKERS: readonly string[] = Object.freeze([
  "[deprecated]",
  "about to be deprecated",
  "no longer recommended",
  "this is a legacy",
]);

/** The [Deprecated] tag counted per-connector in layer 3 (case-sensitive). */
export const CONNECTOR_DEPRECATED_TAG = "[Deprecated]";
/** A connector file is "counted" as a connector when it has a "title" key. */
export const CONNECTOR_TITLE_MARKER = '"title"';

/** The result of the deprecation classifier. */
export interface DeprecationResult {
  deprecated: boolean;
  /** Present only when deprecated; one of the three fixed reason strings. */
  reason?: string;
}

/** Inputs the adapter gathers for one solution (all optional/lazy). */
export interface DeprecationInput {
  /** The solution directory name, e.g. "Forescout (Legacy)". */
  name: string;
  /** Raw text of each Data/Solution_*.json file (order irrelevant). */
  solutionDataContents?: readonly string[];
  /** Raw text of each Data Connectors/*.json file. */
  connectorContents?: readonly string[];
}

/** Layer 1: the directory name marks the solution legacy/deprecated. */
export function isDeprecatedByName(name: string): boolean {
  const lower = name.toLowerCase();
  return DEPRECATION_NAME_MARKERS.some((m) => lower.includes(m));
}

/** Layer 2: a Solution_*.json body carries a deprecation marker. */
export function isDeprecatedBySolutionData(
  contents: readonly string[],
): boolean {
  return contents.some((content) => {
    const lower = content.toLowerCase();
    return SOLUTION_DATA_DEPRECATION_MARKERS.some((m) => lower.includes(m));
  });
}

/**
 * Layer 3: ALL connectors are [Deprecated]. Counts connectors by the presence
 * of a "title" key and deprecated ones by the [Deprecated] tag; flags only when
 * there is at least one connector and every one is deprecated.
 */
export function areAllConnectorsDeprecated(
  connectorContents: readonly string[],
): boolean {
  let total = 0;
  let deprecated = 0;
  for (const content of connectorContents) {
    if (content.includes(CONNECTOR_TITLE_MARKER)) total++;
    if (content.includes(CONNECTOR_DEPRECATED_TAG)) deprecated++;
  }
  return total > 0 && deprecated === total;
}

/**
 * Classify a solution's deprecation status, applying the three layers in the
 * legacy's early-return order with the legacy's exact reason strings.
 */
export function classifySolutionDeprecation(
  input: DeprecationInput,
): DeprecationResult {
  if (isDeprecatedByName(input.name)) {
    return { deprecated: true, reason: "Solution marked as legacy" };
  }
  if (isDeprecatedBySolutionData(input.solutionDataContents ?? [])) {
    return { deprecated: true, reason: "Connector deprecated by Microsoft" };
  }
  if (areAllConnectorsDeprecated(input.connectorContents ?? [])) {
    return { deprecated: true, reason: "All connectors deprecated" };
  }
  return { deprecated: false };
}
