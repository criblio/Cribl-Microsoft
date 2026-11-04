/**
 * Pins for the one-time move of a legacy unscoped KV document under the active
 * tenant (ADR 0009 decision 3: "old documents are migrated once, never read in
 * two shapes").
 *
 * The two silent failures this guards: a second tenant adopting the first
 * tenant's legacy document (its How-to progress, its Cribl source records), and
 * a failed read turning into a first run whose next save destroys the real
 * document. So every path asserts exactly what was read, written and returned.
 */

import { describe, expect, it } from "vitest";
import { FakeKvDocumentStore } from "../../testing/fake-kv-document-store";
import { tenantDocumentKey, tenantMigrationClaimKey, tenantMigrationMarker } from "../../domain/tenancy";
import { loadTenantDocument } from "./tenant-documents";

const BASE = "azure-onboarding-progress";
const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";
const KEY_A = tenantDocumentKey(BASE, A) ?? "";
const KEY_B = tenantDocumentKey(BASE, B) ?? "";
const DOC = { kind: "azure-onboarding-progress", version: 1, ticks: ["x"] };
const CLAIM = tenantMigrationClaimKey(BASE);

describe("loadTenantDocument", () => {
  it("reads the tenant's own document and never touches the legacy key", async () => {
    const store = new FakeKvDocumentStore({ [KEY_A]: DOC, [BASE]: { other: true } });
    const out = await loadTenantDocument(store, BASE, A);
    expect(out).toEqual({ kind: "value", value: DOC });
    expect(store.loads).toEqual([KEY_A]);
    expect(store.saves).toEqual([]);
  });

  it("moves the legacy document under the ACTIVE tenant, once, and marks the legacy key", async () => {
    const store = new FakeKvDocumentStore({ [BASE]: DOC });
    const out = await loadTenantDocument(store, BASE, A);
    expect(out).toEqual({ kind: "value", value: DOC });
    expect(store.saves).toEqual([
      // The claim is written FIRST, under a key no pre-upgrade bundle writes.
      { key: CLAIM, value: tenantMigrationMarker(A) },
      { key: KEY_A, value: DOC },
      { key: BASE, value: tenantMigrationMarker(A) },
    ]);
  });

  it("does NOT hand a legacy document to a second tenant after the marker was overwritten", async () => {
    // Review finding: a tab still running the pre-upgrade bundle saves the
    // whole single-tenant progress to the unscoped key, over the marker. The
    // next tenant to open the screen then adopted tenant A's plan values and
    // Cribl source records as its own.
    const store = new FakeKvDocumentStore({ [BASE]: DOC });
    await loadTenantDocument(store, BASE, A);
    await store.save(BASE, { ...DOC, ticks: ["x", "y"] });
    const forB = await loadTenantDocument(store, BASE, B);
    expect(forB).toEqual({ kind: "absent", why: "not-found" });
    expect(store.peek(KEY_B)).toBeUndefined();
  });

  it("the claiming tenant itself resumes a migration whose copy never landed", async () => {
    const store = new FakeKvDocumentStore({ [BASE]: DOC, [CLAIM]: tenantMigrationMarker(A) });
    expect(await loadTenantDocument(store, BASE, A)).toEqual({ kind: "value", value: DOC });
    expect(store.peek(KEY_A)).toEqual(DOC);
  });

  it("is UNKNOWN when the claim cannot be read - it may name another tenant", async () => {
    const store = new FakeKvDocumentStore({ [BASE]: DOC }).scriptLoad(CLAIM, { kind: "unknown", reason: "HTTP 502" });
    const out = await loadTenantDocument(store, BASE, B);
    expect(out.kind).toBe("unknown");
    expect(store.saves).toEqual([]);
  });

  it("does NOT hand the same legacy document to a second tenant", async () => {
    const store = new FakeKvDocumentStore({ [BASE]: DOC });
    await loadTenantDocument(store, BASE, A);
    const forB = await loadTenantDocument(store, BASE, B);
    expect(forB).toEqual({ kind: "absent", why: "not-found" });
    expect(store.peek(KEY_B)).toBeUndefined();
    expect(store.peek(KEY_A)).toEqual(DOC);
  });

  it("is a first run when there is neither a scoped nor a legacy document", async () => {
    const store = new FakeKvDocumentStore();
    expect(await loadTenantDocument(store, BASE, A)).toEqual({ kind: "absent", why: "not-found" });
    expect(store.saves).toEqual([]);
  });

  it("is UNKNOWN when the tenant's document cannot be read - never a first run", async () => {
    const store = new FakeKvDocumentStore({ [BASE]: DOC }).scriptLoad(KEY_A, {
      kind: "unknown",
      reason: "HTTP 403",
      status: 403,
    });
    const out = await loadTenantDocument(store, BASE, A);
    expect(out.kind).toBe("unknown");
    // And it did not go and migrate the legacy document over a scoped one
    // that may well exist.
    expect(store.saves).toEqual([]);
  });

  it("is UNKNOWN when the legacy document cannot be read - it may be there to migrate", async () => {
    const store = new FakeKvDocumentStore().scriptLoad(BASE, { kind: "unknown", reason: "timeout" });
    const out = await loadTenantDocument(store, BASE, A);
    expect(out.kind).toBe("unknown");
    expect(out.kind === "unknown" ? out.reason : "").toContain("timeout");
    expect(store.saves).toEqual([]);
  });

  it("is UNKNOWN when the move cannot be written, and leaves the legacy document in place", async () => {
    const store = new FakeKvDocumentStore({ [BASE]: DOC }).failSaves();
    const out = await loadTenantDocument(store, BASE, A);
    expect(out.kind).toBe("unknown");
    expect(store.peek(BASE)).toEqual(DOC);
  });

  it("is UNKNOWN for a blank tenant, without reading anything", async () => {
    const store = new FakeKvDocumentStore({ [BASE]: DOC });
    const out = await loadTenantDocument(store, BASE, "  ");
    expect(out.kind).toBe("unknown");
    expect(store.loads).toEqual([]);
  });

  it("does not migrate a corrupt legacy body: the tenant's own copy is simply not there yet", async () => {
    // The corrupt legacy body is left where it is - saves now go to the scoped
    // key, so nothing overwrites it - and the tenant's honest answer is that
    // its own document was never written.
    const store = new FakeKvDocumentStore().scriptLoad(BASE, { kind: "absent", why: "corrupt" });
    expect(await loadTenantDocument(store, BASE, A)).toEqual({ kind: "absent", why: "not-found" });
    expect(store.saves).toEqual([]);
  });
});
