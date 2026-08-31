/**
 * Pins for auto-creating a rule's dependency table (2026-07-16): an existing
 * (native/standard) table short-circuits; a missing custom table is CREATED
 * from the CustomTables repo schema (PUT then readback poll); a data type the
 * repo does not define resolves a clear non-fatal outcome.
 */

import { describe, expect, it } from "vitest";
import { FakeAzureManagement, FakeSentinelContent } from "../../testing/index";
import { ensureRuleDataTable } from "./ensure-tables";
import type { WorkspaceScope } from "./content-install";

const WS: WorkspaceScope = {
  subscriptionId: "sub",
  resourceGroup: "rg",
  workspaceName: "law",
  location: "eastus",
};

const CF_SCHEMA = JSON.stringify({
  Name: "Cloudflare_CL",
  Properties: [
    { Name: "TimeGenerated", Type: "DateTime" },
    { Name: "ClientIP", Type: "String" },
    { Name: "EdgeStartTimestamp", Type: "DateTime" },
  ],
});

const CUSTOM_TABLES_PATH =
  ".script/tests/KqlvalidationsTests/CustomTables/Cloudflare_CL.json";

describe("ensureRuleDataTable", () => {
  it("short-circuits when the table already exists (native or standard)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 200, body: { properties: {} } }); // GET tables/SecurityEvent
    const content = new FakeSentinelContent({ files: {} });
    const out = await ensureRuleDataTable(azure, content, WS, "SecurityEvent");
    expect(out).toEqual({
      table: "SecurityEvent",
      ok: true,
      detail: "already exists",
      created: false,
    });
    expect(azure.calls).toHaveLength(1);
  });

  it("creates a missing custom table from the CustomTables repo schema", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 404, body: { error: "not found" } }, // GET tables/Cloudflare
      { status: 404, body: { error: "not found" } }, // GET tables/Cloudflare_CL
      // createCustomTable re-checks existence before it writes - one extra
      // GET on the create path, which closes the race where someone else
      // created the table between our check and our upsert.
      { status: 404, body: { error: "not found" } }, // GET tables/Cloudflare_CL
      { status: 200, body: {} }, // PUT tables/Cloudflare_CL
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } }, // poll
    );
    const content = new FakeSentinelContent({ files: { [CUSTOM_TABLES_PATH]: CF_SCHEMA } });
    const out = await ensureRuleDataTable(azure, content, WS, "Cloudflare");
    expect(out.ok).toBe(true);
    expect(out.created).toBe(true);
    expect(out.table).toBe("Cloudflare_CL");
    const put = azure.calls[3];
    expect(put.method).toBe("PUT");
    expect(put.path).toContain("/tables/Cloudflare_CL");
    // The PUT body carries the repo columns (system-safe; TimeGenerated kept).
    const body = put.body as { properties: { schema: { columns: { name: string }[] } } };
    const names = body.properties.schema.columns.map((c) => c.name);
    expect(names).toContain("ClientIP");
  });

  it("reports a clear non-fatal outcome when the repo has no schema", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 404, body: {} }, // GET tables/Weird
      { status: 404, body: {} }, // GET tables/Weird_CL
    );
    const content = new FakeSentinelContent({ files: {} }); // no schema file
    const out = await ensureRuleDataTable(azure, content, WS, "Weird");
    expect(out.ok).toBe(false);
    expect(out.created).toBe(false);
    expect(out.detail).toContain("CustomTables repo");
    // No PUT is attempted when there is no schema to create from.
    expect(azure.calls.every((c) => c.method === "GET")).toBe(true);
  });
});

/**
 * DBT-41 and DBT-40. The readback loop used to live here and `continue` on ANY
 * non-2xx, so a 403 was retried twelve times and then reported as "still
 * provisioning" - a provisioning state nobody had read.
 *
 * The loop now lives in `createCustomTable`, which this function CALLS; only a
 * 404 is retryable there. These pins stay because the interesting behaviour is
 * this caller's POLICY, not the poll: an unresolved readback is a SUCCESS here
 * (the rule install a moment later will find the table), where `onboardTable`
 * treats the identical result as fatal because it needs the schema next. Those
 * two opposite decisions on one result are why createCustomTable reports the
 * readback instead of deciding it - see onboard-table.custom.test.ts's
 * "bounds the created-table readback by attempt count" for the other half.
 */
describe("ensureRuleDataTable - the readback distinguishes slow from unreadable", () => {
  const created = (polls: { status: number; body?: unknown }[]) => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 404, body: {} }, // GET tables/Cloudflare
      { status: 404, body: {} }, // GET tables/Cloudflare_CL
      { status: 404, body: {} }, // createCustomTable's own existence check
      { status: 200, body: {} }, // PUT tables/Cloudflare_CL
      ...polls.map((p) => ({ status: p.status, body: p.body ?? {} })),
    );
    const content = new FakeSentinelContent({
      files: { [CUSTOM_TABLES_PATH]: CF_SCHEMA },
    });
    return { azure, run: () => ensureRuleDataTable(azure, content, WS, "Cloudflare") };
  };

  it("STOPS on a 403 instead of retrying it to the bound", async () => {
    const { azure, run } = created([{ status: 403, body: { error: "denied" } }]);
    const out = await run();
    // Three existence GETs + the PUT + exactly ONE poll. Twelve would be the bug.
    expect(azure.calls).toHaveLength(5);
    expect(out.detail).toContain("could not be read back");
    expect(out.detail).toContain("403");
  });

  it("does NOT claim a provisioning state it never read", async () => {
    // The heart of it. TWELVE 403s are queued deliberately: with only one, the
    // old swallow-everything loop exhausted the fake and died in the catch,
    // so this pin would have passed against the bug for the wrong reason.
    // With the full bound available, the old code reaches its fall-through
    // and really does report "still provisioning" off twelve denied reads.
    const { run } = created(
      Array.from({ length: 12 }, () => ({ status: 403, body: {} })),
    );
    const out = await run();
    expect(out.detail).not.toContain("still provisioning");
    expect(out.detail).toContain("could not be read back");
  });

  it("still reports created - the PUT was accepted, only the readback failed", async () => {
    // Not a regression to ok:false. The table exists; what is unknown is its
    // state, and content install's next step will find it.
    const { run } = created([{ status: 403, body: {} }]);
    const out = await run();
    expect(out.ok).toBe(true);
    expect(out.created).toBe(true);
  });

  it("KEEPS retrying a 404 - an accepted PUT that has not replicated yet", async () => {
    const { azure, run } = created([
      { status: 404 },
      { status: 404 },
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } },
    ]);
    const out = await run();
    expect(out.detail).toBe("created (3 columns)");
    expect(azure.calls).toHaveLength(7);
  });

  it("still says 'still provisioning' when every poll really was read", async () => {
    // The honest version of the old fall-through: all 12 polls answered 2xx
    // with a non-terminal state, so the wording is now true.
    const { run } = created(
      Array.from({ length: 12 }, () => ({
        status: 200,
        body: { properties: { provisioningState: "Creating" } },
      })),
    );
    const out = await run();
    expect(out.detail).toContain("still provisioning");
    expect(out.ok).toBe(true);
  });
});
