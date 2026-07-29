/**
 * Solution ingress - derives the correct Cribl integration point for a
 * Microsoft Sentinel SOLUTION from its shipped ingestion classification
 * (2026-07-29 user direction: "select the source based on the available
 * Sentinel Solutions in the Sentinel Repo").
 *
 * OFFLINE BY DESIGN: the shipped ~436-solution classification asset
 * (domain/sentinel-content/ingestion-classification) carries every solution
 * name plus the connector tier/kind, so the whole feature works with zero
 * ports, tokens, or network access. Live repo enumeration stays a possible
 * v2 enrichment.
 *
 * The mapping is TIER-FIRST because the shipped kind strings include
 * non-CCF junk ("", "Linux", "StorageV2", even raw ARM expressions): a
 * legacy tier always draws the agent archetype; a supported tier with a
 * REAL CCF pull kind draws the dual-path pull archetype; everything else -
 * Push and custom-table/DCR declarations alike - has the Logs Ingestion API
 * as its ingress, which is the plain Cribl push topology.
 *
 * Dynamic patterns REUSE the catalog's backbone labels verbatim ("Cribl
 * Stream", "Kind:Direct DCR", "Sentinel / LA", "Custom _CL + alias") so
 * unifyPatternDiagrams merges them onto the same nodes; the solution source
 * node label carries an " (solution)" suffix, which can never collide with
 * a catalog label under canonicalNodeKey and which diagramNodeInfo resolves
 * to the generic solution-source entry.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import {
  CCF_PULL_KINDS,
  ingestionTierReason,
  lookupSolutionIngestion,
  type IngestionTier,
  type SolutionIngestion,
} from "../sentinel-content";
import {
  recommendPatterns,
  type ArchitecturePattern,
  type ArchitectureSelection,
  type PatternRecommendation,
} from "./architecture-patterns";

/** The three drawable ingress shapes a solution's connector kind maps to. */
export type SolutionIngressArchetype =
  | "push-logs-ingestion"
  | "pull-native"
  | "agent-legacy";

/** Tier-first mapping; kind only disambiguates pull within "supported". */
export function solutionIngressArchetype(
  kind: string,
  tier: IngestionTier,
): SolutionIngressArchetype {
  if (tier === "legacy") {
    return "agent-legacy";
  }
  const isPullKind = CCF_PULL_KINDS.some(
    (pull) => pull.toLowerCase() === kind.toLowerCase() && kind !== "",
  );
  if (tier === "supported" && isPullKind) {
    return "pull-native";
  }
  return "push-logs-ingestion";
}

/** Stable slug for a dynamic pattern id (prefix prevents catalog collisions). */
function solutionSlug(solutionName: string): string {
  return solutionName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Build the ingress pattern for one selected solution. Requires NOTHING -
 * a dynamic pattern exists only because the user selected its solution, so
 * it always surfaces as a full match; specificity 0 ranks it after the
 * static catalog's matches.
 */
export function solutionIngressPattern(
  solutionName: string,
  ingestion: SolutionIngestion,
): ArchitecturePattern {
  const archetype = solutionIngressArchetype(ingestion.kind, ingestion.tier);
  const sourceLabel = `${solutionName} (solution)`;
  const why = ingestionTierReason(ingestion.tier, ingestion.kind);
  const base = {
    id: `solution:${solutionSlug(solutionName)}`,
    title: `${solutionName} - Sentinel solution ingress`,
    requiresProducts: [],
    requiresResources: [],
  } as const;

  if (archetype === "pull-native") {
    return {
      ...base,
      summary:
        `${solutionName} ships a CCF pull connector (${ingestion.kind}): Sentinel collects natively on a schedule, and Cribl can deliver into the same table as the alternative path.`,
      why,
      considerations: [
        "Run ONE path: leave the native poller disconnected when Cribl delivers the feed, or the same events land twice.",
        "The Cribl path posts into the connector's table through the Logs Ingestion API (Kind:Direct DCR) - shape to the declared schema.",
        "The native pull needs no Cribl infrastructure; choose it when reduction and routing add no value for this feed.",
      ],
      diagram: {
        nodes: [
          { id: "src", label: sourceLabel, tier: "source" },
          { id: "pull", label: "Sentinel connector (pull)", tier: "azure" },
          { id: "stream", label: "Cribl Stream", tier: "cribl" },
          { id: "dcr", label: "Kind:Direct DCR", tier: "azure" },
          { id: "law", label: "Sentinel / LA", tier: "destination" },
        ],
        edges: [
          { from: "src", to: "pull", label: `native pull (${ingestion.kind})` },
          { from: "pull", to: "law", cost: "premium" },
          { from: "src", to: "stream", label: "Cribl alternative" },
          { from: "stream", to: "dcr", label: "logs ingestion API" },
          { from: "dcr", to: "law", cost: "premium" },
        ],
      },
    };
  }

  if (archetype === "agent-legacy") {
    return {
      ...base,
      summary:
        `${solutionName} ships a legacy-class connector (agent or Azure Functions): no native Logs Ingestion target exists, so the Cribl path lands in a custom table fronted by a function alias.`,
      why,
      considerations: [
        "The Cribl alternative lands in a _CL custom table - create a KQL function alias named like the table the solution's content queries, or its rules and workbooks will not resolve.",
        "The native path keeps the vendor's agent/Functions collector; weigh its operational cost against the alias work.",
        "Transport into Cribl varies by vendor (syslog, API, files) - check the solution's connector page for the feed details.",
      ],
      diagram: {
        nodes: [
          { id: "src", label: sourceLabel, tier: "source" },
          { id: "agent", label: "Agent / Functions connector", tier: "azure" },
          { id: "stream", label: "Cribl Stream", tier: "cribl" },
          { id: "dcr", label: "Kind:Direct DCR", tier: "azure" },
          { id: "cl", label: "Custom _CL + alias", tier: "azure" },
          { id: "law", label: "Sentinel / LA", tier: "destination" },
        ],
        edges: [
          { from: "src", to: "agent", label: "native (agent/function)" },
          { from: "agent", to: "law", cost: "premium" },
          { from: "src", to: "stream", label: "Cribl alternative" },
          { from: "stream", to: "dcr", label: "logs ingestion API" },
          { from: "dcr", to: "cl", cost: "premium" },
          { from: "cl", to: "law", label: "function alias" },
        ],
      },
    };
  }

  return {
    ...base,
    summary:
      `${solutionName} ingests through the Azure Logs Ingestion API (Push or custom-table connector): Cribl Stream delivers shaped events straight into its table.`,
    why,
    considerations: [
      "Shape to the connector's declared table schema in Stream before the DCR - content expects those columns.",
      "Reduce before ingestion: the target table bills at analytics-tier rates.",
    ],
    diagram: {
      nodes: [
        { id: "src", label: sourceLabel, tier: "source" },
        { id: "stream", label: "Cribl Stream", tier: "cribl" },
        { id: "dcr", label: "Kind:Direct DCR", tier: "azure" },
        { id: "law", label: "Sentinel / LA", tier: "destination" },
      ],
      edges: [
        { from: "src", to: "stream", label: "vendor events" },
        { from: "stream", to: "dcr", label: "logs ingestion API" },
        { from: "dcr", to: "law", cost: "premium" },
      ],
    },
  };
}

/**
 * The recommender the screen calls: expands selection.solutionSources into
 * dynamic ingress patterns (shipped-classification lookup; unknown names
 * fall back to the conservative agent-legacy drawing) and delegates to
 * recommendPatterns. With no solution sources it is recommendPatterns.
 */
export function recommendWithSolutions(
  selection: ArchitectureSelection,
): PatternRecommendation[] {
  const extra = (selection.solutionSources ?? []).map((name) =>
    solutionIngressPattern(
      name,
      lookupSolutionIngestion(name) ?? { tier: "legacy", kind: "" },
    ),
  );
  return recommendPatterns(selection, extra);
}
