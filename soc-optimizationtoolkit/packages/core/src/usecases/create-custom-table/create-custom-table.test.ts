/**
 * Pins for the extracted table-creation contract (TBL-3).
 *
 * `onboardTable`'s own 27 characterization pins already cover this logic
 * through the job pipeline and still pass unchanged - that is what made the
 * extraction safe. What these add is the contract AS A UNIT, including the
 * cases the job could not easily reach: the zero-write guarantee on an
 * existing table, and every branch of the readback poll.
 */

import { describe, expect, it } from "vitest";
import type { AzureManagement } from "../../ports/azure-management";
import { createCustomTable } from "./create-custom-table";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** Azure stub driven by a queue of responses, recording every call. */
function fakeAzure(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Call[] = [];
  let i = 0;
  const azure = {
    async request(opts: { method: string; path: string; body?: unknown }) {
      calls.push({ method: opts.method, path: opts.path, body: opts.body });
      const next = responses[i++] ?? { status: 500, body: {} };
      return { ok: next.status < 300, status: next.status, body: next.body ?? {} };
    },
  } as unknown as AzureManagement;
  return { azure, calls };
}

const INPUT = {
  subscriptionId: "sub-1",
  resourceGroup: "rg-1",
  workspaceName: "law-1",
  table: "App_CL",
};

const COLUMNS = [
  { name: "TimeGenerated", type: "datetime" },
  { name: "Message", type: "string" },
];

describe("an existing table wins", () => {
  it("skips creation and returns the live body", async () => {
    const { azure } = fakeAzure([
      { status: 200, body: { properties: { schema: { columns: [] } } } },
    ]);
    const result = await createCustomTable(azure, { ...INPUT, columns: COLUMNS });
    expect(result.created).toBe(false);
    expect(result.body).toEqual({ properties: { schema: { columns: [] } } });
    // Nothing was decided about an existing table, so nothing is reported.
    expect(result.columnCount).toBeNull();
  });

  it("WRITES NOTHING - the guarantee, asserted by call count and method", async () => {
    // A supplied schema must not overwrite a live table's schema. The tables
    // PUT is an upsert, so a stray write here would silently redefine it.
    const { azure, calls } = fakeAzure([{ status: 200, body: {} }]);
    await createCustomTable(azure, { ...INPUT, columns: COLUMNS });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });
});

describe("creating a missing table", () => {
  it("PUTs then polls, and reports what it created", async () => {
    const { azure, calls } = fakeAzure([
      { status: 404 },
      { status: 200 },
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } },
    ]);
    const result = await createCustomTable(azure, { ...INPUT, columns: COLUMNS });
    expect(result.created).toBe(true);
    expect(result.tableName).toBe("App_CL");
    expect(result.columnCount).toBe(COLUMNS.length);
    expect(result.retentionInDays).toBeTypeOf("number");
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT", "GET"]);
  });

  it("refuses without a schema, and says how to get one", async () => {
    const { azure, calls } = fakeAzure([{ status: 404 }]);
    await expect(createCustomTable(azure, INPUT)).rejects.toThrow(
      /does not exist and no customSchema was provided/,
    );
    // And it did NOT attempt the write.
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("rejects a schema validateCustomTableSchema refuses", async () => {
    const { azure } = fakeAzure([{ status: 404 }]);
    await expect(
      // Not _CL: the creation rule this shares with the rest of the app.
      createCustomTable(azure, { ...INPUT, table: "NotCustom", columns: COLUMNS }),
    ).rejects.toThrow(/is invalid/);
  });
});

describe("the readback poll", () => {
  it("treats a 404 as not-replicated-yet and keeps polling", async () => {
    const { azure, calls } = fakeAzure([
      { status: 404 },
      { status: 200 },
      { status: 404 },
      { status: 404 },
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } },
    ]);
    const result = await createCustomTable(azure, { ...INPUT, columns: COLUMNS });
    expect(result.created).toBe(true);
    expect(calls).toHaveLength(5);
  });

  it("accepts a body with NO provisioningState as done", async () => {
    // A table that GETs back without a state is not pending; treating it as
    // pending would poll until the attempt bound and then fail a table that
    // exists.
    const { azure } = fakeAzure([
      { status: 404 },
      { status: 200 },
      { status: 200, body: { properties: {} } },
    ]);
    await expect(
      createCustomTable(azure, { ...INPUT, columns: COLUMNS }),
    ).resolves.toMatchObject({ created: true });
  });

  it("STOPS on a failed provisioning state instead of polling it out", async () => {
    const { azure, calls } = fakeAzure([
      { status: 404 },
      { status: 200 },
      { status: 200, body: { properties: { provisioningState: "Failed" } } },
    ]);
    await expect(
      createCustomTable(azure, { ...INPUT, columns: COLUMNS }),
    ).rejects.toThrow(/provisioning ended in state 'Failed'/);
    expect(calls).toHaveLength(3);
  });

  it("gives up after the attempt bound, naming it", async () => {
    const { azure, calls } = fakeAzure([
      { status: 404 },
      { status: 200 },
      ...Array.from({ length: 5 }, () => ({ status: 404 })),
    ]);
    await expect(
      createCustomTable(azure, { ...INPUT, columns: COLUMNS, maxPollAttempts: 3 }),
    ).rejects.toThrow(/within 3 poll attempts/);
    // GET + PUT + exactly 3 polls, not a poll forever.
    expect(calls).toHaveLength(5);
  });

  it("surfaces a non-404 poll failure rather than retrying it", async () => {
    const { azure } = fakeAzure([
      { status: 404 },
      { status: 200 },
      { status: 500, body: { error: { message: "boom" } } },
    ]);
    await expect(
      createCustomTable(azure, { ...INPUT, columns: COLUMNS }),
    ).rejects.toThrow(/poll custom table/);
  });
});

describe("the existence check itself failing", () => {
  it("reports a non-404 GET rather than trying to create", async () => {
    // A 403 must not be read as "missing" - creating on top of a table we
    // simply cannot see is how an upsert overwrites someone else's schema.
    const { azure, calls } = fakeAzure([
      { status: 403, body: { error: { message: "denied" } } },
    ]);
    await expect(
      createCustomTable(azure, { ...INPUT, columns: COLUMNS }),
    ).rejects.toThrow(/check custom table/);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });
});
