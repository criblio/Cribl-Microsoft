/**
 * deploy-links pins: every binding targets a real pattern and a route id
 * present in BOTH shells' route tables (the shared 13-route list below is
 * the contract - a shell renaming a route must update it here).
 */

import { describe, expect, it } from "vitest";
import { ARCHITECTURE_PATTERNS } from "@soc/core";
import { PATTERN_DEPLOY_LINKS } from "./deploy-links";

const SHARED_ROUTE_IDS = new Set([
  "architecture",
  "home",
  "integrate",
  "dcr-automation",
  "packs",
  "repositories",
  "labs",
  "logs",
  "settings",
  "siem-migration",
  "preflight",
  "eventhub-discovery",
  "mapping-catalog",
]);

describe("PATTERN_DEPLOY_LINKS", () => {
  it("every key is a real catalog pattern id", () => {
    const patternIds = new Set(ARCHITECTURE_PATTERNS.map((p) => p.id));
    for (const key of Object.keys(PATTERN_DEPLOY_LINKS)) {
      expect(patternIds.has(key), key).toBe(true);
    }
  });

  it("every route id exists in both shells' route tables", () => {
    for (const [key, link] of Object.entries(PATTERN_DEPLOY_LINKS)) {
      expect(SHARED_ROUTE_IDS.has(link.routeId), `${key} -> ${link.routeId}`).toBe(
        true,
      );
      expect(link.label.length).toBeGreaterThan(5);
    }
  });

  it("headline bindings stay pinned", () => {
    expect(PATTERN_DEPLOY_LINKS["direct-dcr"]?.routeId).toBe("dcr-automation");
    expect(PATTERN_DEPLOY_LINKS["private-ingestion"]?.routeId).toBe("dcr-automation");
    expect(PATTERN_DEPLOY_LINKS["vnet-flow-collection"]?.routeId).toBe("labs");
  });
});
