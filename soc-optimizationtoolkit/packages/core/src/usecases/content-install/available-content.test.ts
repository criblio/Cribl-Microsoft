/**
 * Pins for Content Hub deprecation lookup (2026-07-15): a solution's
 * authoritative deprecation comes from the Content Hub catalog
 * (properties.isDeprecated or a "(Deprecated)"/"(Legacy)" displayName), keyed
 * so a repo folder name ("Cloudflare") matches the Hub package name
 * ("Cloudflare (Deprecated)").
 */

import { describe, expect, it } from "vitest";
import { FakeAzureManagement } from "../../testing/index";
import {
  deprecatedSolutionKey,
  listDeprecatedContentHubSolutions,
} from "./available-content";
import type { WorkspaceScope } from "./content-install";

const WS: WorkspaceScope = {
  subscriptionId: "sub",
  resourceGroup: "rg",
  workspaceName: "law",
  location: "eastus",
};

describe("deprecatedSolutionKey", () => {
  it("reduces a Hub '(Deprecated)' name and the repo name to the same key", () => {
    expect(deprecatedSolutionKey("Cloudflare (Deprecated)")).toBe(
      deprecatedSolutionKey("Cloudflare"),
    );
    expect(deprecatedSolutionKey("Cloudflare (Deprecated)")).toBe("cloudflare");
  });

  it("strips a '(Legacy)' marker too", () => {
    expect(deprecatedSolutionKey("Forescout (Legacy)")).toBe("forescout");
  });
});

describe("listDeprecatedContentHubSolutions", () => {
  it("collects keys for isDeprecated and '(Deprecated)'-named packages only", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({
      status: 200,
      body: {
        value: [
          { properties: { displayName: "Cloudflare (Deprecated)", isDeprecated: "true" } },
          { properties: { displayName: "Zscaler Internet Access" } }, // active
          { properties: { displayName: "Forescout", isDeprecated: true } }, // flag only
        ],
      },
    });
    const keys = await listDeprecatedContentHubSolutions(azure, WS);
    expect(keys.has("cloudflare")).toBe(true);
    expect(keys.has("forescout")).toBe(true);
    expect(keys.has(deprecatedSolutionKey("Zscaler Internet Access"))).toBe(false);
    expect(azure.calls[0].path).toContain("/contentProductPackages");
  });

  it("degrades to an empty set when the listing fails (never throws)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 403, body: "denied" });
    const keys = await listDeprecatedContentHubSolutions(azure, WS);
    expect(keys.size).toBe(0);
  });
});
