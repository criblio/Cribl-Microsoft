/**
 * AZR-62 (ADR 0009 decision 1): the Setup tenant list. An operator pastes
 * tenant ids; each valid one becomes a connection profile unless one already
 * carries it.
 *
 * What these pins protect, each one a way the list could quietly do harm:
 *   - an invalid entry is NAMED, never silently dropped (the operator would
 *     believe a tenant was added that was not);
 *   - two spellings of one tenant are one tenant (Entra ids are case-blind);
 *   - an existing profile - its config, its name, the active choice - is
 *     never changed, so a pasted list can never overwrite a connection or
 *     orphan the secret saved for it;
 *   - each ticket target carries the tenant id it was asked for, and the
 *     config of exactly ONE connection: the RBAC plan and its scopes are per
 *     connection, so a ticket built from one connection's config must never
 *     claim to cover another;
 *   - a connection whose tenant cannot be compared (a domain name) makes an
 *     unmatched tenant unknown, never new;
 *   - no two connections get the same name (the secret is entered by picking
 *     a connection by name).
 */
import { describe, expect, it } from "vitest";
import {
  addTenantProfiles,
  isTenantId,
  parseTenantIdList,
  planTenantProfiles,
  tenantTicketTargets,
} from "./index";
import { EMPTY_AZURE_CONFIG } from "../azure-config";
import type { ProfileStore } from "../azure-profiles";

const TA = "aaaaaaaa-1111-4111-8111-111111111111";
const TB = "bbbbbbbb-2222-4222-8222-222222222222";
const TC = "cccccccc-3333-4333-8333-333333333333";

describe("isTenantId", () => {
  it("accepts a GUID in either case, refuses everything else", () => {
    expect(isTenantId(TA)).toBe(true);
    expect(isTenantId(TA.toUpperCase())).toBe(true);
    expect(isTenantId("contoso.onmicrosoft.com")).toBe(false);
    expect(isTenantId(`{${TA}}`)).toBe(false);
    expect(isTenantId(TA.slice(0, 35))).toBe(false);
    expect(isTenantId(`${TA}0`)).toBe(false);
    expect(isTenantId("gggggggg-1111-4111-8111-111111111111")).toBe(false);
    // The nil GUID is well formed and names no tenant.
    expect(isTenantId("00000000-0000-0000-0000-000000000000")).toBe(false);
    expect(isTenantId("")).toBe(false);
  });
});

describe("parseTenantIdList", () => {
  it("splits on commas AND newlines, trims, lower-cases, keeps first-seen order", () => {
    const parsed = parseTenantIdList(`  ${TB} ,${TA.toUpperCase()}\r\n${TC}\n`);
    expect(parsed.tenants).toEqual([TB, TA, TC]);
    expect(parsed.invalid).toEqual([]);
    expect(parsed.duplicates).toEqual([]);
  });

  it("collapses duplicates across case and delimiters, and says which collapsed", () => {
    const parsed = parseTenantIdList(`${TA}\n${TB},${TA.toUpperCase()}, ${TA}`);
    expect(parsed.tenants).toEqual([TA, TB]);
    expect(parsed.duplicates).toEqual([TA]);
  });

  it("names every invalid entry exactly as typed (trimmed), once each, and keeps the valid ones", () => {
    const parsed = parseTenantIdList(`${TA}, contoso.onmicrosoft.com ,not-a-guid\nnot-a-guid,${TB}`);
    expect(parsed.tenants).toEqual([TA, TB]);
    expect(parsed.invalid).toEqual(["contoso.onmicrosoft.com", "not-a-guid"]);
  });

  it("ignores blank entries from stray or doubled delimiters", () => {
    expect(parseTenantIdList(`,,\n\n ${TA} ,,\n`)).toEqual({ tenants: [TA], invalid: [], duplicates: [] });
    expect(parseTenantIdList("")).toEqual({ tenants: [], invalid: [], duplicates: [] });
    expect(parseTenantIdList("   \n , ")).toEqual({ tenants: [], invalid: [], duplicates: [] });
  });

  it("does not split on spaces: two ids joined by a space are one invalid entry, named", () => {
    const parsed = parseTenantIdList(`${TA} ${TB}`);
    expect(parsed.tenants).toEqual([]);
    expect(parsed.invalid).toEqual([`${TA} ${TB}`]);
  });
});

function store(): ProfileStore {
  return {
    profiles: [
      {
        id: "p-a",
        name: "Contoso prod",
        config: { ...EMPTY_AZURE_CONFIG, tenantId: TA.toUpperCase(), clientId: "client-a", subscriptionId: "sub-a" },
      },
      { id: "p-blank", name: "Default", config: { ...EMPTY_AZURE_CONFIG } },
      { id: "p-a2", name: "Contoso lab", config: { ...EMPTY_AZURE_CONFIG, tenantId: TA } },
    ],
    activeProfileId: "p-blank",
  };
}

describe("planTenantProfiles", () => {
  it("splits the tenants into new ones and ones a profile already carries (any case)", () => {
    const plan = planTenantProfiles(store(), [TB, TA, TC]);
    expect(plan.create).toEqual([TB, TC]);
    expect(plan.existing).toEqual([{ tenantId: TA, profileIds: ["p-a", "p-a2"], names: ["Contoso prod", "Contoso lab"] }]);
    expect(plan.undetermined).toEqual([]);
  });

  it("matches a connection that holds its tenant braced (a pasted registry GUID) to the bare GUID", () => {
    const braced: ProfileStore = {
      profiles: [{ id: "p-x", name: "Braced", config: { ...EMPTY_AZURE_CONFIG, tenantId: ` {${TB.toUpperCase()}} ` } }],
      activeProfileId: null,
    };
    const plan = planTenantProfiles(braced, [TB]);
    expect(plan.create).toEqual([]);
    expect(plan.existing).toEqual([{ tenantId: TB, profileIds: ["p-x"], names: ["Braced"] }]);
    expect(addTenantProfiles(braced, [TB], () => "never")).toBe(braced);
  });

  it("a connection whose tenant is a domain name makes an unmatched tenant UNKNOWN, never new", () => {
    const withDomain: ProfileStore = {
      profiles: [
        ...store().profiles,
        { id: "p-d", name: "Fabrikam", config: { ...EMPTY_AZURE_CONFIG, tenantId: "fabrikam.onmicrosoft.com" } },
      ],
      activeProfileId: null,
    };
    const plan = planTenantProfiles(withDomain, [TA, TB]);
    // TA is matched by its GUID; TB might be Fabrikam's directory - nobody can tell from here.
    expect(plan.existing.map((e) => e.tenantId)).toEqual([TA]);
    expect(plan.create).toEqual([]);
    expect(plan.undetermined).toEqual([
      { tenantId: TB, connections: [{ name: "Fabrikam", tenant: "fabrikam.onmicrosoft.com" }] },
    ]);
    // ...so no connection is added for it: a duplicate would be presented as a new tenant.
    expect(addTenantProfiles(withDomain, [TB], () => "never")).toBe(withDomain);
  });
});

describe("addTenantProfiles", () => {
  it("adds one blank profile per NEW tenant, with a shell-minted id and the tenant filled in", () => {
    const minted: string[] = [];
    const next = addTenantProfiles(store(), [TB, TA, TC], (tenantId) => {
      minted.push(tenantId);
      return `id-${tenantId.slice(0, 8)}`;
    });
    // The id minter is asked only for tenants that get a profile.
    expect(minted).toEqual([TB, TC]);
    expect(next.profiles.map((p) => p.id)).toEqual(["p-a", "p-blank", "p-a2", "id-bbbbbbbb", "id-cccccccc"]);
    expect(next.profiles[3]).toEqual({
      id: "id-bbbbbbbb",
      name: "Tenant bbbbbbbb",
      config: { ...EMPTY_AZURE_CONFIG, tenantId: TB },
    });
  });

  it("never changes an existing profile, its name, or which profile is active", () => {
    const before = store();
    const snapshot = JSON.stringify(before);
    const next = addTenantProfiles(before, [TA.toUpperCase(), TB], (t) => `id-${t}`);
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(next.profiles.slice(0, 3)).toEqual(before.profiles);
    expect(next.activeProfileId).toBe("p-blank");
  });

  it("is idempotent: pasting the same list twice adds nothing the second time", () => {
    const once = addTenantProfiles(store(), [TB], (t) => `id-${t}`);
    const twice = addTenantProfiles(once, [TB], () => {
      throw new Error("no id should be minted for a tenant that already has a profile");
    });
    expect(twice).toEqual(once);
  });

  it("never gives two connections the same name: a taken 8-digit name falls back to the full tenant id", () => {
    const TA2 = "aaaaaaaa-9999-4999-8999-999999999999";
    const taken: ProfileStore = {
      profiles: [{ id: "p-m", name: "tenant BBBBBBBB", config: { ...EMPTY_AZURE_CONFIG, tenantId: TC } }],
      activeProfileId: null,
    };
    const next = addTenantProfiles(taken, [TA, TA2, TB], (t) => `id-${t}`);
    expect(next.profiles.map((p) => p.name)).toEqual([
      "tenant BBBBBBBB",
      "Tenant aaaaaaaa",
      `Tenant ${TA2}`,
      `Tenant ${TB}`,
    ]);
  });

  it("numbers the name when even the full tenant id name is taken", () => {
    const taken: ProfileStore = {
      profiles: [
        { id: "p-1", name: "Tenant bbbbbbbb", config: { ...EMPTY_AZURE_CONFIG, tenantId: TA } },
        { id: "p-2", name: `Tenant ${TB}`, config: { ...EMPTY_AZURE_CONFIG, tenantId: TC } },
      ],
      activeProfileId: null,
    };
    const next = addTenantProfiles(taken, [TB], (t) => `id-${t}`);
    expect(next.profiles[2]?.name).toBe(`Tenant ${TB} (2)`);
  });

  it("refuses a value that is not a tenant id rather than filing a profile under it", () => {
    expect(() => addTenantProfiles(store(), ["not-a-guid"], (t) => t)).toThrow(/not a tenant id/);
  });
});

describe("tenantTicketTargets", () => {
  it("one target per CONNECTION for a known tenant, each with its own config; a blank one for a new tenant", () => {
    const targets = tenantTicketTargets(store(), [TA, TB]);
    expect(targets).toEqual([
      {
        tenantId: TA,
        connectionName: "Contoso prod",
        connectionsForTenant: 2,
        undeterminedConnections: [],
        config: { ...EMPTY_AZURE_CONFIG, tenantId: TA, clientId: "client-a", subscriptionId: "sub-a" },
      },
      {
        tenantId: TA,
        connectionName: "Contoso lab",
        connectionsForTenant: 2,
        undeterminedConnections: [],
        config: { ...EMPTY_AZURE_CONFIG, tenantId: TA },
      },
      {
        tenantId: TB,
        connectionName: null,
        connectionsForTenant: 0,
        undeterminedConnections: [],
        config: { ...EMPTY_AZURE_CONFIG, tenantId: TB },
      },
    ]);
  });

  it("never takes one connection's subscription or setup path for another on the same tenant", () => {
    const two: ProfileStore = {
      profiles: [
        {
          id: "p-lab",
          name: "X lab",
          config: { ...EMPTY_AZURE_CONFIG, tenantId: TA, subscriptionId: "sub-1", setupPath: "lab-new-rg" },
        },
        {
          id: "p-prod",
          name: "X prod",
          config: { ...EMPTY_AZURE_CONFIG, tenantId: TA, subscriptionId: "sub-2", resourceGroup: "rg-b", setupPath: "existing" },
        },
      ],
      activeProfileId: null,
    };
    const targets = tenantTicketTargets(two, [TA]);
    expect(targets.map((t) => [t.connectionName, t.config.subscriptionId, t.config.resourceGroup, t.config.setupPath])).toEqual([
      ["X lab", "sub-1", "", "lab-new-rg"],
      ["X prod", "sub-2", "rg-b", "existing"],
    ]);
  });

  it("names the connections that could not be compared on a tenant no connection is known to carry", () => {
    const withDomain: ProfileStore = {
      profiles: [{ id: "p-d", name: "Fabrikam", config: { ...EMPTY_AZURE_CONFIG, tenantId: "fabrikam.onmicrosoft.com" } }],
      activeProfileId: null,
    };
    expect(tenantTicketTargets(withDomain, [TB])).toEqual([
      {
        tenantId: TB,
        connectionName: null,
        connectionsForTenant: 0,
        undeterminedConnections: ["Fabrikam"],
        config: { ...EMPTY_AZURE_CONFIG, tenantId: TB },
      },
    ]);
  });
});
