/**
 * THE PIN THE LIVE-SCHEMA FEATURE SHIPPED WITHOUT (2026-08-18 audit).
 *
 * Three commits built "point a log type at a real table and analyse against its
 * live columns". The catalog tier got core pins; the picker got DOM pins. The
 * WIRE between them - the thing that actually fetches the columns - had none,
 * and that is where the defect was: it returned null unless the table appeared
 * in a listing that had not necessarily loaded (and never loads at all when the
 * listing 403s, since the auto-load does not retry). The analysis then ran on
 * the DERIVED schema while the UI promised live columns from Azure.
 *
 * So these assert the ATTEMPT, in the same spirit as the picker's rule 1: what
 * we believe about the workspace never pre-empts asking Azure.
 */

import { describe, expect, it, vi } from "vitest";
import { createTableSchemaResolver } from "./table-schema-resolver";
import type { AzureManagement } from "@soc/core";

const TARGET = {
  subscriptionId: "sub-1",
  resourceGroup: "rg-1",
  workspaceName: "ws-1",
};

/** An ARM stub returning one table's schema. */
function azureReturning(columns: Array<{ name: string; type: string }>) {
  const request = vi.fn().mockResolvedValue({
    status: 200,
    body: { properties: { schema: { standardColumns: columns } } },
  });
  return { azure: { request } as unknown as AzureManagement, request };
}

describe("createTableSchemaResolver - it asks Azure, it does not guess", () => {
  it("fetches a table that was NEVER in any listing", async () => {
    // THE REGRESSION. The resolver has no listing and no cache by construction;
    // if one is ever reintroduced, this is the pin that fails. SecurityEvent is
    // deliberate: it is one of the four natives the destination selector offers
    // from the first render, before the workspace listing can possibly have
    // resolved.
    const { azure, request } = azureReturning([
      { name: "TimeGenerated", type: "datetime" },
    ]);
    const resolve = createTableSchemaResolver(azure, TARGET);

    const fields = await resolve("SecurityEvent");

    expect(request).toHaveBeenCalledTimes(1);
    expect(fields).toEqual([{ name: "TimeGenerated", type: "datetime" }]);
  });

  it("addresses the table under the bound workspace", async () => {
    // Stronger than "it called something": proves the resolver carries its own
    // target rather than the caller having to restate it per fetch.
    const { azure, request } = azureReturning([{ name: "AlertId", type: "string" }]);
    const resolve = createTableSchemaResolver(azure, TARGET);

    await resolve("CrowdStrikeAlerts");

    const path = String(request.mock.calls[0]![0].path);
    expect(path).toContain("/subscriptions/sub-1/");
    expect(path).toContain("/workspaces/ws-1/tables/CrowdStrikeAlerts");
  });

  it("THROWS on a denied read rather than reporting an empty table", async () => {
    // The two facts must not collapse. A 403 that returned null would land in
    // changeTable's catch as "leave it derived" and look exactly like a table
    // with no columns - the analysis would quietly use the wrong schema, which
    // is the whole failure this resolver exists to stop.
    const request = vi.fn().mockResolvedValue({ status: 403, body: "Forbidden" });
    const resolve = createTableSchemaResolver(
      { request } as unknown as AzureManagement,
      TARGET,
    );

    await expect(resolve("SecurityEvent")).rejects.toThrow();
  });

  it("returns null for a table that exists with no usable columns", async () => {
    // Provisioned but never materialized - a real state, and the ONE case null
    // is allowed to mean. createLiveTableSchemaCatalog treats an empty override
    // as an override, so this has to stay distinguishable from a failed read.
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: { properties: { schema: {} } },
    });
    const resolve = createTableSchemaResolver(
      { request } as unknown as AzureManagement,
      TARGET,
    );

    await expect(resolve("Provisioned_CL")).resolves.toBeNull();
  });

  it("re-asks on every call - no memo of what it saw last time", async () => {
    // A table can materialize between two analyses. Caching here would pin the
    // operator to the schema that existed the first time they picked it.
    const { azure, request } = azureReturning([{ name: "AlertId", type: "string" }]);
    const resolve = createTableSchemaResolver(azure, TARGET);

    await resolve("App_CL");
    await resolve("App_CL");

    expect(request).toHaveBeenCalledTimes(2);
  });
});
