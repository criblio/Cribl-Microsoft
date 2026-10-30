/**
 * Pins for Content Hub deprecation lookup (2026-07-15): a solution's
 * authoritative deprecation comes from the Content Hub catalog
 * (properties.isDeprecated or a "(Deprecated)"/"(Legacy)" displayName), keyed
 * so a repo folder name ("Cloudflare") matches the Hub package name
 * ("Cloudflare (Deprecated)").
 *
 * DBT-176: both catalog reads answer in THREE states - found, not-found
 * (measured: the catalog was read and held packages) and unreadable (with the
 * reason). They used to answer null / an empty set for a failed read too, so
 * "could not read the catalog" rendered as "not in the catalog" and as "no
 * deprecated solutions". An EMPTY catalog is unreadable, not not-found: a
 * readable Content Hub always lists packages, so an empty page proves nothing.
 */

import { describe, expect, it } from "vitest";
import { FakeAzureManagement } from "../../testing/index";
import {
  deprecatedSolutionKey,
  findSolutionCatalogEntry,
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
    const lookup = await listDeprecatedContentHubSolutions(azure, WS);
    expect(lookup.kind).toBe("found");
    if (lookup.kind !== "found") return;
    expect([...lookup.keys].sort()).toEqual(["cloudflare", "forescout"]);
    expect(lookup.packagesSeen).toBe(3);
    expect(azure.calls[0].path).toContain("/contentProductPackages");
  });

  it("says not-found, with the count it read, when packages were seen and none is deprecated", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({
      status: 200,
      body: {
        value: [
          { properties: { displayName: "Zscaler Internet Access" } },
          { properties: { displayName: "Cloudflare", isDeprecated: false } },
        ],
      },
    });
    expect(await listDeprecatedContentHubSolutions(azure, WS)).toEqual({
      kind: "not-found",
      packagesSeen: 2,
    });
  });

  it("says unreadable, with the reason, when the listing fails (never throws, never an empty set)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 403, body: "denied" });
    expect(await listDeprecatedContentHubSolutions(azure, WS)).toEqual({
      kind: "unreadable",
      reason: 'list content product packages: HTTP 403 "denied"',
    });
  });

  it("says unreadable for an EMPTY catalog - an empty page is not 'none deprecated'", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 200, body: { value: [] } });
    const lookup = await listDeprecatedContentHubSolutions(azure, WS);
    expect(lookup.kind).toBe("unreadable");
    if (lookup.kind !== "unreadable") return;
    expect(lookup.reason).toMatch(/^the Content Hub catalog listed no packages/);
  });
});

describe("findSolutionCatalogEntry (DBT-176)", () => {
  const PKG = {
    name: "cloudflare.pkg",
    properties: { displayName: "Cloudflare", contentId: "cf-id", version: "3.0.1" },
  };

  it("says found, with the entry, when a package matches", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 200, body: { value: [PKG] } });
    expect(await findSolutionCatalogEntry(azure, WS, "Cloudflare")).toEqual({
      kind: "found",
      entry: {
        packageId: "cloudflare.pkg",
        contentId: "cf-id",
        displayName: "Cloudflare",
        version: "3.0.1",
        installedVersion: null,
      },
    });
  });

  it("says not-found, with the count it read, when the catalog has packages but none matches", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({
      status: 200,
      body: { value: [PKG, { name: "z", properties: { displayName: "Zscaler" } }] },
    });
    expect(await findSolutionCatalogEntry(azure, WS, "CrowdStrike Falcon")).toEqual({
      kind: "not-found",
      packagesSeen: 2,
    });
  });

  it("says unreadable, with the reason, when the listing fails", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 403, body: "denied" });
    expect(await findSolutionCatalogEntry(azure, WS, "Cloudflare")).toEqual({
      kind: "unreadable",
      reason: 'list content product packages: HTTP 403 "denied"',
    });
  });

  it("says unreadable for an EMPTY catalog - absence was not measured", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 200, body: { value: [] } });
    const lookup = await findSolutionCatalogEntry(azure, WS, "Cloudflare");
    expect(lookup.kind).toBe("unreadable");
    if (lookup.kind !== "unreadable") return;
    expect(lookup.reason).toMatch(/^the Content Hub catalog listed no packages/);
  });
});
