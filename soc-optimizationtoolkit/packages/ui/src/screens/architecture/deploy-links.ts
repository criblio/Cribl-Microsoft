/**
 * deploy-links - pattern id -> the in-app surface that deploys or explores
 * it. Route bindings are SHELL-FACING data and live in the ui layer (the
 * SHARED_JOURNEY_LINKS precedent) - the core pattern catalog stays
 * route-ignorant. Both shells' route tables carry these ids.
 */

/** One pattern's deploy binding. */
export interface PatternDeployLink {
  routeId: string;
  label: string;
}

/** Patterns this app can act on directly, and where. */
export const PATTERN_DEPLOY_LINKS: Readonly<Record<string, PatternDeployLink>> = {
  "direct-dcr": {
    routeId: "dcr-automation",
    label: "Deploy this: DCR Automation",
  },
  "private-ingestion": {
    routeId: "dcr-automation",
    label: "Deploy the DCRs: DCR Automation",
  },
  "sentinel-data-lake-tiering": {
    routeId: "dcr-automation",
    label: "Deploy the DCRs: DCR Automation",
  },
  "event-hub-fanin": {
    routeId: "eventhub-discovery",
    label: "Discover Event Hubs",
  },
  "entra-reroute": {
    routeId: "eventhub-discovery",
    label: "Discover Event Hubs",
  },
  "vnet-flow-collection": {
    routeId: "labs",
    label: "Open Labs: flow-log collection",
  },
};
