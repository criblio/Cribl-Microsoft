/**
 * DBT-152: ensure-secret overwrote an existing Cribl secret on a 409 (and on a
 * 400) without asking who owned it. These pins hold the one decision both
 * callers now share: PATCH only a secret whose description carries this app's
 * ownership stamp; refuse a foreign or unreadable one; a 400 is an error.
 */

import { describe, expect, it } from "vitest";
import { FakeCriblClient } from "../../testing/fake-cribl-client";
import { APP_ID } from "../../domain/cribl-secrets";
import { stampFor } from "../../kit/config-writes/ownership";
import { ensureTextSecret } from "./ensure-text-secret";

const ID = "some_secret";
const SPEC = { groupId: "wg-1", id: ID, value: "s3cr3t", description: "What it is for" };
const STAMPED = `What it is for ${stampFor(APP_ID)}`;
const BODY = { id: ID, secretType: "text", value: "s3cr3t", description: STAMPED };

const methods = (c: FakeCriblClient) => c.calls.map((r) => `${r.method} ${r.path} [${r.groupId}]`);

describe("ensureTextSecret (DBT-152)", () => {
  it("creates on a 2xx POST and sends nothing else", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith({ status: 200, body: {} });
    const outcome = await ensureTextSecret(cribl, SPEC);
    expect(outcome).toEqual({ kind: "created", secretId: ID });
    expect(methods(cribl)).toEqual(["POST /system/secrets [wg-1]"]);
    expect(cribl.calls[0]!.body).toEqual(BODY);
  });

  it("409 and the existing secret carries our stamp: GET, then PATCH with the stamped body", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith(
      { status: 409, body: {} },
      { status: 200, body: { count: 1, items: [{ id: ID, secretType: "text", description: `Older text ${stampFor(APP_ID)}` }] } },
      { status: 200, body: {} },
    );
    const outcome = await ensureTextSecret(cribl, SPEC);
    expect(outcome).toEqual({ kind: "updated", secretId: ID });
    expect(methods(cribl)).toEqual([
      "POST /system/secrets [wg-1]",
      `GET /system/secrets/${ID} [wg-1]`,
      `PATCH /system/secrets/${ID} [wg-1]`,
    ]);
    expect(cribl.calls[2]!.body).toEqual(BODY);
  });

  it("409 and the existing secret is someone else's: no PATCH, a refusal naming the id", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith(
      { status: 409, body: {} },
      { status: 200, body: { count: 1, items: [{ id: ID, secretType: "text", description: "Made by hand" }] } },
    );
    const outcome = await ensureTextSecret(cribl, SPEC);
    expect(outcome).toEqual({
      kind: "refused",
      reason: "foreign",
      secretId: ID,
      message:
        `Cribl secret '${ID}' already exists and this app cannot show it wrote it ` +
        `(its description carries no ${stampFor(APP_ID)} stamp); it was left unchanged. ` +
        `If it is yours to replace, delete it in Cribl or add ${stampFor(APP_ID)} to its description, then run this again.`,
    });
    expect(methods(cribl)).toEqual(["POST /system/secrets [wg-1]", `GET /system/secrets/${ID} [wg-1]`]);
  });

  it.each([
    ["another app's stamp", "[managed-by:other-app]"],
    ["a stamp whose app id only starts with ours", `[managed-by:${APP_ID}-fork]`],
    ["our app id without the stamp brackets", `managed-by:${APP_ID}`],
  ])("409 and the description carries %s: foreign, no PATCH (the stamp match is exact)", async (_label, description) => {
    const cribl = new FakeCriblClient();
    cribl.respondWith({ status: 409, body: {} }, { status: 200, body: { items: [{ id: ID, description }] } });
    const outcome = await ensureTextSecret(cribl, SPEC);
    expect(outcome.kind === "refused" && outcome.reason).toBe("foreign");
    expect(cribl.calls.map((r) => r.method)).toEqual(["POST", "GET"]);
  });

  it("409 and the existing secret has no description at all: foreign, no PATCH", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith({ status: 409, body: {} }, { status: 200, body: { items: [{ id: ID }] } });
    const outcome = await ensureTextSecret(cribl, SPEC);
    expect(outcome.kind).toBe("refused");
    expect(outcome.kind === "refused" && outcome.reason).toBe("foreign");
    expect(cribl.calls.filter((r) => r.method === "PATCH")).toHaveLength(0);
  });

  it.each([
    ["the read is refused (403)", { status: 403, body: { message: "Forbidden" } }, "HTTP 403"],
    ["the read finds nothing (404)", { status: 404, body: {} }, "HTTP 404"],
    ["the read has no items array", { status: 200, body: { id: ID } }, "the read answered without an items array"],
    ["the read lists a different id", { status: 200, body: { items: [{ id: "other", description: stampFor(APP_ID) }] } }, `the read named no secret '${ID}'`],
  ])("409 and %s: unknown owner is not ours, no PATCH", async (_label, read, detail) => {
    const cribl = new FakeCriblClient();
    cribl.respondWith({ status: 409, body: {} }, read);
    const outcome = await ensureTextSecret(cribl, SPEC);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.reason).toBe("unreadable");
    expect(outcome.message).toBe(
      `Cribl secret '${ID}' already exists and its owner could not be read (${detail}); it was left unchanged.`,
    );
    expect(methods(cribl)).toEqual(["POST /system/secrets [wg-1]", `GET /system/secrets/${ID} [wg-1]`]);
  });

  it("409 and the read throws (transport): unreadable, no PATCH", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith({ status: 409, body: {} }); // nothing scripted for the GET: the fake throws
    const outcome = await ensureTextSecret(cribl, SPEC);
    expect(outcome.kind === "refused" && outcome.reason).toBe("unreadable");
    expect(cribl.calls.map((r) => r.method)).toEqual(["POST", "GET"]);
  });

  it("400 is an error, never an overwrite: no GET, no PATCH", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith({ status: 400, body: { message: "bad body" } });
    const outcome = await ensureTextSecret(cribl, SPEC);
    expect(outcome).toEqual({
      kind: "failed",
      step: "create",
      status: 400,
      secretId: ID,
      message: `store Cribl secret '${ID}': HTTP 400 {"message":"bad body"}`,
    });
    expect(methods(cribl)).toEqual(["POST /system/secrets [wg-1]"]);
  });

  it("a failed PATCH on our own secret is a failure of the update step", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith(
      { status: 409, body: {} },
      { status: 200, body: { items: [{ id: ID, description: stampFor(APP_ID) }] } },
      { status: 500, body: "boom" },
    );
    const outcome = await ensureTextSecret(cribl, SPEC);
    expect(outcome).toEqual({
      kind: "failed",
      step: "update",
      status: 500,
      secretId: ID,
      message: `update Cribl secret '${ID}': HTTP 500 "boom"`,
    });
  });

  it("encodes the id in the GET and PATCH paths, and omits groupId when none is given", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith(
      { status: 409, body: {} },
      { status: 200, body: { items: [{ id: "a b", description: stampFor(APP_ID) }] } },
      { status: 200, body: {} },
    );
    const outcome = await ensureTextSecret(cribl, { id: "a b", value: "v", description: "d" });
    expect(outcome).toEqual({ kind: "updated", secretId: "a b" });
    expect(cribl.calls.map((r) => r.path)).toEqual(["/system/secrets", "/system/secrets/a%20b", "/system/secrets/a%20b"]);
    expect(cribl.calls.every((r) => !("groupId" in r))).toBe(true);
  });
});

// ADR 0009; audit tenancy HIGH secret-provisioning.ts:36. The Sentinel client
// secret has ONE fixed name, so two tenants wiring into one worker group meet
// the same secret - and the stamped-ours PATCH replaced tenant A's value with
// tenant B's, silently breaking every A destination that references it.
describe("ensureTextSecret - one tenant never overwrites another's secret", () => {
  const A = "aaaaaaaa-0000-0000-0000-00000000000a";
  const B = "bbbbbbbb-0000-0000-0000-00000000000b";

  it("names the tenant in the description it writes", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith({ status: 200, body: {} });
    await ensureTextSecret(cribl, { ...SPEC, tenantId: A.toUpperCase() });
    expect((cribl.calls[0]!.body as { description: string }).description).toBe(
      `What it is for (tenant ${A}) ${stampFor(APP_ID)}`,
    );
  });

  it("409 on a secret ours but written for ANOTHER tenant: refused, no PATCH", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith(
      { status: 409, body: {} },
      { status: 200, body: { items: [{ id: ID, description: `What it is for (tenant ${A}) ${stampFor(APP_ID)}` }] } },
    );
    const outcome = await ensureTextSecret(cribl, { ...SPEC, tenantId: B });
    expect(outcome.kind === "refused" && outcome.reason).toBe("other-tenant");
    expect(outcome.kind === "refused" ? outcome.message : "").toContain(A);
    expect(cribl.calls.map((r) => r.method)).toEqual(["POST", "GET"]);
  });

  it("409 on a secret ours for the SAME tenant: updated", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith(
      { status: 409, body: {} },
      { status: 200, body: { items: [{ id: ID, description: `Old (tenant ${A}) ${stampFor(APP_ID)}` }] } },
      { status: 200, body: {} },
    );
    const outcome = await ensureTextSecret(cribl, { ...SPEC, tenantId: A });
    expect(outcome.kind).toBe("updated");
  });

  it("409 on a secret ours from before tenants were named: REFUSED as owner-unknown, no PATCH", async () => {
    // Review finding (HIGH): every Sentinel client secret written before
    // tenant naming is stamped but names no tenant. Updating it let the FIRST
    // other tenant to wire into the group take it over - the very audit HIGH
    // this change closes. Whose it is cannot be read, so it is not ours to
    // replace until the operator says so.
    const cribl = new FakeCriblClient();
    cribl.respondWith(
      { status: 409, body: {} },
      { status: 200, body: { items: [{ id: ID, description: `Old ${stampFor(APP_ID)}` }] } },
    );
    const outcome = await ensureTextSecret(cribl, { ...SPEC, tenantId: B });
    expect(outcome.kind === "refused" && outcome.reason).toBe("untagged-legacy");
    // The message tells the operator exactly how to claim it for this tenant.
    expect(outcome.kind === "refused" ? outcome.message : "").toContain(`(tenant ${B})`);
    expect(cribl.calls.map((r) => r.method)).toEqual(["POST", "GET"]);
  });

  it("409 on an untagged stamped secret with NO tenant given: still updated (single-tenant callers)", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith(
      { status: 409, body: {} },
      { status: 200, body: { items: [{ id: ID, description: `Old ${stampFor(APP_ID)}` }] } },
      { status: 200, body: {} },
    );
    const outcome = await ensureTextSecret(cribl, SPEC);
    expect(outcome.kind).toBe("updated");
  });
});
