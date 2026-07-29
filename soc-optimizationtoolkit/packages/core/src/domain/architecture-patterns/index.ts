/**
 * architecture-patterns domain module barrel (roadmap Phase 4 QUEUED item).
 * The data-driven reference-architecture advisor: product/resource catalogs,
 * the pattern catalog with tiered diagram data, and the pure recommender.
 * All pure.
 */

export type {
  CriblProduct,
  AzureResource,
  LogSource,
  CatalogEntry,
  DiagramTier,
  DiagramNode,
  DiagramEdge,
  PatternDiagram,
  ArchitecturePattern,
  ArchitectureSelection,
  PatternRecommendation,
  DiagramDocLink,
  DiagramNodeInfo,
} from "./architecture-patterns";
export {
  CRIBL_PRODUCTS,
  AZURE_RESOURCES,
  LOG_SOURCES,
  ARCHITECTURE_PATTERNS,
  expandResources,
  recommendPatterns,
  catalogLabel,
  unifyPatternDiagrams,
  diagramNodeInfo,
} from "./architecture-patterns";
