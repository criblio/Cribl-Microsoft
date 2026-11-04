/**
 * Pins for the tenant to Cribl mapping (ADR 0009 decision 5, AZR-64): which
 * worker group receives each Azure tenant's sources.
 *
 * The failure each rule guards is silent: a tenant's Cribl source created in,
 * or its live flow read from, a worker group the operator never chose for it.
 * So the default is UNSET (never a guess), an unreadable or foreign document is
 * UNKNOWN (never unset, which would let the screen fall back), and these pins
 * assert exact groups and reasons, not just "something resolved".
 */

import { describe, expect, it } from "vitest";
import { isKvDocumentKey } from "../../ports/kv-document-store";
import type { KvDocumentLoad } from "../../ports/kv-document-store";
import {
  TENANT_CRIBL_MAPPING_KEY,
  TENANT_CRIBL_MAPPING_KIND,
  TENANT_CRIBL_MAPPING_VERSION,
  UNSET_TENANT_CRIBL_MAPPING,
  encodeTenantCriblMapping,
  mappingTenants,
  readTenantCriblMapping,
  resolveTenantGroup,
  withMappingMode,
  withSharedGroup,
  withTenantGroup,
} from "./tenant-cribl-mapping";
import type { TenantCriblMapping, TenantCriblMappingRead } from "./tenant-cribl-mapping";

const T1 = "11111111-aaaa-bbbb-cccc-000000000001";
const T2 = "22222222-aaaa-bbbb-cccc-000000000002";

const value = (v: unknown): KvDocumentLoad => ({ kind: "value", value: v });
const read = (mapping: TenantCriblMapping): TenantCriblMappingRead => ({ kind: "read", mapping, stored: true });

function doc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: TENANT_CRIBL_MAPPING_KIND,
    version: TENANT_CRIBL_MAPPING_VERSION,
    mode: "per-tenant",
    sharedGroup: "shared-g",
    groups: { [T1]: "g-one", [T2]: "g-two" },
    ...over,
  };
}

describe("the mapping document key", () => {
  it("is one app-wide document, safe for the KV store, and not a tenant-scoped key", () => {
    expect(TENANT_CRIBL_MAPPING_KEY).toBe("tenant-cribl-mapping");
    expect(isKvDocumentKey(TENANT_CRIBL_MAPPING_KEY)).toBe(true);
  });
});

describe("readTenantCriblMapping", () => {
  it("an absent document is UNSET - never a guessed mode or group - and says it was never stored", () => {
    for (const why of ["not-found", "empty", "corrupt"] as const) {
      const r = readTenantCriblMapping({ kind: "absent", why });
      expect(r).toEqual({ kind: "read", mapping: UNSET_TENANT_CRIBL_MAPPING, stored: false });
    }
    expect(UNSET_TENANT_CRIBL_MAPPING).toEqual({ mode: null, sharedGroup: null, groups: {} });
  });

  it("a failed read is UNKNOWN with its reason, never unset", () => {
    const r = readTenantCriblMapping({ kind: "unknown", reason: "HTTP 403", status: 403 });
    expect(r).toEqual({ kind: "unknown", reason: "HTTP 403" });
  });

  it("decodes our document exactly, with tenant ids normalized", () => {
    const r = readTenantCriblMapping(value(doc({ groups: { [` ${T1.toUpperCase()} `]: "g-one" } })));
    expect(r).toEqual({
      kind: "read",
      stored: true,
      mapping: { mode: "per-tenant", sharedGroup: "shared-g", groups: { [T1]: "g-one" } },
    });
  });

  it("a foreign document is UNKNOWN, so nothing overwrites it", () => {
    const r = readTenantCriblMapping(value({ kind: "something-else", mode: "shared" }));
    expect(r.kind).toBe("unknown");
    expect(r.kind === "unknown" && r.reason).toMatch(/not a tenant to Cribl mapping/);
  });

  it("a document from a newer release is UNKNOWN, so this release never overwrites it", () => {
    const r = readTenantCriblMapping(value(doc({ version: 2 })));
    expect(r.kind).toBe("unknown");
    expect(r.kind === "unknown" && r.reason).toMatch(/version 2/);
  });

  // Content this release cannot read is UNKNOWN, never dropped: a dropped mode
  // or group resolves to unset, which lets the onboarding screen fall back to
  // its own picker, and a Save on Setup would then erase what was dropped.
  it.each([
    ["an unrecognised mode", { mode: "Shared" }, /mode/],
    ["a mode that is not a string", { mode: 1 }, /mode/],
    ["a shared group that is not a group id", { sharedGroup: "bad group/id" }, /shared group/],
    ["a blank shared group", { sharedGroup: "  " }, /shared group/],
    ["a shared group that is not a string", { sharedGroup: 7 }, /shared group/],
    ["groups that are not an object", { groups: "g-one" }, /groups/],
    ["groups that are an array", { groups: ["g-one"] }, /groups/],
    ["a tenant group that is blank", { groups: { [T1]: "" } }, /group for tenant/],
    ["a tenant group that is not a string", { groups: { [T1]: 7 } }, /group for tenant/],
    ["a tenant group that is not a group id", { groups: { [T1]: "bad group/id" } }, /group for tenant/],
    ["a blank tenant id", { groups: { " ": "g" } }, /tenant id/],
  ])("%s is UNKNOWN, never dropped into unset", (_what, over, reason) => {
    const r = readTenantCriblMapping(value(doc(over)));
    expect(r.kind).toBe("unknown");
    expect(r.kind === "unknown" && r.reason).toMatch(reason);
    expect(r.kind === "unknown" && r.reason).toMatch(/left as it is/);
  });

  it("absent and null fields are tolerated as nothing chosen", () => {
    const base = { kind: TENANT_CRIBL_MAPPING_KIND, version: TENANT_CRIBL_MAPPING_VERSION };
    const unset = { kind: "read", stored: true, mapping: UNSET_TENANT_CRIBL_MAPPING };
    expect(readTenantCriblMapping(value(base))).toEqual(unset);
    expect(readTenantCriblMapping(value({ ...base, mode: null, sharedGroup: null, groups: null }))).toEqual(unset);
  });
});

describe("encodeTenantCriblMapping", () => {
  it("round-trips through the reader", () => {
    const m: TenantCriblMapping = { mode: "shared", sharedGroup: "default", groups: { [T1]: "g-one" } };
    const encoded = encodeTenantCriblMapping(m);
    expect(encoded).toEqual({
      kind: TENANT_CRIBL_MAPPING_KIND,
      version: TENANT_CRIBL_MAPPING_VERSION,
      mode: "shared",
      sharedGroup: "default",
      groups: { [T1]: "g-one" },
    });
    expect(readTenantCriblMapping(value(JSON.parse(JSON.stringify(encoded))))).toEqual(read(m));
  });
});

describe("the edits", () => {
  it("switching mode keeps the other mode's choices, so switching back loses nothing", () => {
    let m = withTenantGroup(UNSET_TENANT_CRIBL_MAPPING, T1, "g-one");
    m = withSharedGroup(m, "shared-g");
    m = withMappingMode(m, "shared");
    m = withMappingMode(m, "per-tenant");
    expect(m).toEqual({ mode: "per-tenant", sharedGroup: "shared-g", groups: { [T1]: "g-one" } });
  });

  it("clearing a group removes it; a blank tenant id changes nothing", () => {
    const m = withTenantGroup(withTenantGroup(UNSET_TENANT_CRIBL_MAPPING, T1, "g-one"), T2, "g-two");
    expect(withTenantGroup(m, T1, null).groups).toEqual({ [T2]: "g-two" });
    expect(withTenantGroup(m, T1, "  ").groups).toEqual({ [T2]: "g-two" });
    expect(withTenantGroup(m, "  ", "g")).toBe(m);
    expect(withSharedGroup(withSharedGroup(m, "s"), "").sharedGroup).toBeNull();
  });

  it("never mutates its input", () => {
    const m: TenantCriblMapping = { mode: null, sharedGroup: null, groups: {} };
    withTenantGroup(m, T1, "g");
    withSharedGroup(m, "g");
    withMappingMode(m, "shared");
    expect(m).toEqual({ mode: null, sharedGroup: null, groups: {} });
  });
});

describe("resolveTenantGroup", () => {
  const perTenant: TenantCriblMapping = { mode: "per-tenant", sharedGroup: "shared-g", groups: { [T1]: "g-one" } };
  const shared: TenantCriblMapping = { mode: "shared", sharedGroup: "shared-g", groups: { [T1]: "g-one" } };

  it("per tenant: each tenant gets ITS group, matched case-blind", () => {
    expect(resolveTenantGroup(read(perTenant), T1.toUpperCase())).toEqual({
      kind: "mapped",
      groupId: "g-one",
      mode: "per-tenant",
    });
  });

  it("per tenant: a tenant with no group is UNSET, never the shared group or another tenant's", () => {
    expect(resolveTenantGroup(read(perTenant), T2)).toEqual({ kind: "unset", why: "no-tenant-group" });
  });

  it("one group for every tenant: every tenant gets the shared group, whatever the per-tenant map says", () => {
    expect(resolveTenantGroup(read(shared), T1)).toEqual({ kind: "mapped", groupId: "shared-g", mode: "shared" });
    expect(resolveTenantGroup(read(shared), T2)).toEqual({ kind: "mapped", groupId: "shared-g", mode: "shared" });
  });

  it("one group for every tenant with no group chosen is UNSET", () => {
    expect(resolveTenantGroup(read({ ...shared, sharedGroup: null }), T1)).toEqual({
      kind: "unset",
      why: "no-shared-group",
    });
  });

  it("no mode chosen is UNSET even when groups were entered", () => {
    expect(resolveTenantGroup(read({ ...perTenant, mode: null }), T1)).toEqual({ kind: "unset", why: "no-mode" });
  });

  it("an unreadable mapping is UNKNOWN, never unset", () => {
    expect(resolveTenantGroup({ kind: "unknown", reason: "HTTP 500" }, T1)).toEqual({
      kind: "unknown",
      reason: "HTTP 500",
    });
  });

  it("a connection with no tenant id is UNKNOWN: there is no tenant to look up", () => {
    const r = resolveTenantGroup(read(shared), "  ");
    expect(r.kind).toBe("unknown");
    expect(r.kind === "unknown" && r.reason).toMatch(/no tenant id/);
  });
});

describe("mappingTenants", () => {
  it("lists each distinct tenant once, with the names of every connection for it, in first-seen order", () => {
    const out = mappingTenants([
      { name: "Prod", config: { tenantId: T2 } },
      { name: "Lab", config: { tenantId: T1 } },
      { name: "Prod again", config: { tenantId: ` ${T2.toUpperCase()}` } },
      { name: "Blank", config: { tenantId: "" } },
    ]);
    expect(out).toEqual({
      tenants: [
        { tenantId: T2, names: ["Prod", "Prod again"] },
        { tenantId: T1, names: ["Lab"] },
      ],
      withoutTenant: ["Blank"],
    });
  });
});
