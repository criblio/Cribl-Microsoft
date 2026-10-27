/**
 * DBT-160: what every caller of `listAllPages` does with a list it could not
 * finish.
 *
 * `listAllPages` used to return page one alone when that page carried a
 * nextLink and the adapter had no `requestUrl` to follow it. Every caller then
 * read an undercount as a whole inventory. It now THROWS, through the same
 * channel as a non-2xx page - so each caller below is driven with an adapter
 * that cannot paginate and a first page that says there is more, and the pin
 * is that the caller reports the failure rather than the first page's rows.
 *
 * The azure-discovery listers (subscriptions, workspaces, resource groups and
 * the resource-group choices) are pinned in azure-discovery.test.ts beside the
 * pager itself.
 */

import { describe, expect, it } from "vitest";

import { FakeAzureManagement } from "../../testing/fake-azure-management";
import type { AzureManagement } from "../../ports/azure-management";
import { listSubscriptions, listWorkspaces } from "./azure-discovery";
import { listWorkspaceTables } from "../workspace-tables/workspace-tables";
import { listLabs } from "../provision-lab/manage-labs";
import { checkExistingDcrs } from "../deployment-preview/deployment-preview";
import { matchDcrsToTables } from "../assign-dcr-role/assign-dcr-role";
import { installedContentState } from "../content-install/content-install";
import type { WorkspaceScope } from "../content-install/content-install";
import {
  findSolutionCatalogEntry,
  listDeprecatedContentHubSolutions,
} from "../content-install/available-content";

const SUB = "11111111-1111-1111-1111-111111111111";
const NEXT = "https://management.azure.com/next?%24skiptoken=abc";
const WS: WorkspaceScope = {
  subscriptionId: SUB,
  resourceGroup: "rg",
  workspaceName: "law",
  location: "eastus",
};

/** The tail every DBT-160 error ends with. */
const INCOMPLETE = /: list incomplete - HTTP 200 body from \S+ has a nextLink, but this adapter has no requestUrl to follow it$/;

/** A fake that cannot paginate, scripted with `pages` first pages that each carry a nextLink. */
function unpaginatable(pages: unknown[][]): { azure: AzureManagement; fake: FakeAzureManagement } {
  const fake = new FakeAzureManagement();
  fake.respondWith(...pages.map((value) => ({ status: 200, body: { value, nextLink: NEXT } })));
  return { azure: { request: (opts) => fake.request(opts) }, fake };
}

describe("listAllPages callers, given a nextLink they cannot follow (DBT-160)", () => {
  it("listSubscriptions rejects instead of listing page 1's subscriptions", async () => {
    const { azure } = unpaginatable([[{ subscriptionId: SUB, displayName: "Prod", state: "Enabled" }]]);
    await expect(listSubscriptions(azure)).rejects.toThrow(INCOMPLETE);
  });

  it("listWorkspaces rejects instead of listing page 1's workspaces", async () => {
    const { azure } = unpaginatable([[{ name: "law", id: `/subscriptions/${SUB}/resourceGroups/rg/x/law` }]]);
    await expect(listWorkspaces(azure, SUB)).rejects.toThrow(INCOMPLETE);
  });

  it("listWorkspaceTables rejects instead of returning a partial table listing", async () => {
    const { azure } = unpaginatable([[{ name: "Syslog", properties: {} }]]);
    await expect(
      listWorkspaceTables(azure, { subscriptionId: SUB, resourceGroup: "rg", workspaceName: "law" }),
    ).rejects.toThrow(/^list tables in workspace 'law': list incomplete - /);
  });

  it("listLabs rejects instead of filtering labs out of page 1 alone", async () => {
    const { azure } = unpaginatable([[{ name: "rg-not-a-lab", tags: {} }]]);
    await expect(
      listLabs(azure, { subscriptionId: SUB, nowIso: "2026-10-27T00:00:00.000Z" }),
    ).rejects.toThrow(/^list resource groups in subscription '[^']+': list incomplete - /);
  });

  it("checkExistingDcrs rejects instead of calling the tables on page 2 not deployed", async () => {
    const { azure, fake } = unpaginatable([[{ name: "dcr-unrelated", id: "/x/dcr-unrelated" }]]);
    await expect(
      checkExistingDcrs(azure, { subscriptionId: SUB, resourceGroup: "rg" }, ["Syslog"], {
        mode: "direct",
        location: "eastus",
      }),
    ).rejects.toThrow(/^list DCRs in resource group 'rg': list incomplete - /);
    // No per-table GET followed a list that did not finish.
    expect(fake.calls).toHaveLength(1);
  });

  it("matchDcrsToTables rejects instead of matching against page 1 alone", async () => {
    const { azure } = unpaginatable([[{ name: "dcr-unrelated", id: "/x/dcr-unrelated" }]]);
    await expect(
      matchDcrsToTables(azure, { subscriptionId: SUB, resourceGroup: "rg" }, ["Syslog"], {
        mode: "direct",
        location: "eastus",
      }),
    ).rejects.toThrow(/^list DCRs in resource group 'rg': list incomplete - /);
  });

  it("installedContentState notes all three probes as unread and observes nothing", async () => {
    // Each page holds an item that would have flipped `observed` to true and
    // made a miss read as a measured "not installed".
    const { azure } = unpaginatable([
      [{ properties: { contentId: "other" } }],
      [{ properties: { displayName: "Other rule" } }],
      [{ properties: { displayName: "Other workbook" } }],
    ]);

    const state = await installedContentState(azure, WS, "wanted");

    expect(state.observed).toEqual({ solutions: false, rules: false, workbooks: false });
    expect(state.solutionInstalled).toBe(false);
    expect(state.installedRuleNames.size).toBe(0);
    expect(state.installedWorkbookNames.size).toBe(0);
    expect(state.notOnboarded).toBe(false);
    expect(state.notes).toHaveLength(3);
    expect(state.notes[0]).toMatch(/^Could not read installed solutions: list installed content packages: list incomplete - /);
    expect(state.notes[1]).toMatch(/^Could not read installed analytics rules: list alert rules: list incomplete - /);
    expect(state.notes[2]).toMatch(/^Could not read installed workbooks: list workbooks: list incomplete - /);
  });

  it("findSolutionCatalogEntry treats the incomplete catalog as unreadable (null), not as page 1", async () => {
    // Page 1 HAS the match; returning it would mean trusting a list we know
    // is unfinished, so the catalog is reported unreadable like any failure.
    const { azure } = unpaginatable([
      [{ name: "pkg", properties: { displayName: "Cloudflare", contentId: "c", version: "1" } }],
    ]);
    expect(await findSolutionCatalogEntry(azure, WS, "Cloudflare")).toBeNull();
  });

  it("listDeprecatedContentHubSolutions returns no tags rather than page 1's tags", async () => {
    const { azure } = unpaginatable([[{ properties: { displayName: "Cloudflare (Deprecated)" } }]]);
    const keys = await listDeprecatedContentHubSolutions(azure, WS);
    expect(keys.size).toBe(0);
  });
});
