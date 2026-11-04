/**
 * AZR-62 (ADR 0009 decision 1): one change request per tenant, plus one
 * combined file, downloaded as Markdown.
 *
 * What these pins protect:
 *   - the EXACT tickets for two tenants (fixtures/), so any change to what an
 *     approver reads is a reviewed diff, not a side effect;
 *   - each ticket names ITS tenant everywhere and never the other's - a
 *     ticket sent to the wrong tenant's admins asks them to create the wrong
 *     thing;
 *   - core and feature roles are separate sections, core first;
 *   - an unknown value stays VISIBLE once the Markdown is rendered (a bare
 *     `<client id>` is an HTML tag to a Markdown renderer, and vanishes);
 *   - the secret hand-back names the tenant the values belong to;
 *   - the combined file says, first, that it is the requester's copy and must
 *     not be sent to any one tenant (it carries every tenant's identifiers),
 *     and its index carries no customer-chosen connection names;
 *   - a tenant two connections carry gets one request PER CONNECTION, each
 *     with that connection's scopes, each saying which connection it covers.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tenantChangeRequests, ticketMarkdown } from "./index";
import { EMPTY_AZURE_CONFIG } from "../azure-config";
import type { TenantTicketTarget } from "../tenant-intake";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(HERE, "fixtures", name), "utf8").replace(/\r\n/g, "\n");

const TA = "aaaaaaaa-1111-4111-8111-111111111111";
const TB = "bbbbbbbb-2222-4222-8222-222222222222";

/** Tenant A has a connection with a client id and target; tenant B is new and blank. */
const TARGETS: TenantTicketTarget[] = [
  {
    tenantId: TA,
    connectionName: "Contoso prod",
    connectionsForTenant: 1,
    undeterminedConnections: [],
    config: {
      ...EMPTY_AZURE_CONFIG,
      tenantId: TA,
      clientId: "11111111-1111-4111-8111-111111111111",
      subscriptionId: "33333333-3333-4333-8333-333333333333",
      resourceGroup: "rg-sentinel",
      workspaceName: "law-sentinel",
    },
  },
  {
    tenantId: TB,
    connectionName: null,
    connectionsForTenant: 0,
    undeterminedConnections: [],
    config: { ...EMPTY_AZURE_CONFIG, tenantId: TB },
  },
];

const APP = "Cribl SOC Optimization Toolkit";

/** Lines outside ``` fences. */
function proseLines(markdown: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (line.trimEnd().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) out.push(line);
  }
  return out;
}

describe("tenantChangeRequests - the exact tickets for two tenants", () => {
  const set = tenantChangeRequests(APP, TARGETS);

  it("tenant A (a connection with a client id and a target) is exactly the fixture", () => {
    expect(set.perTenant[0]?.body).toBe(fixture("tenant-a.md"));
  });

  it("tenant B (new, nothing known but the tenant) is exactly the fixture", () => {
    expect(set.perTenant[1]?.body).toBe(fixture("tenant-b.md"));
  });

  it("the combined file is exactly the fixture", () => {
    expect(set.combined?.body).toBe(fixture("combined.md"));
  });
});

describe("tenantChangeRequests - properties", () => {
  const set = tenantChangeRequests(APP, TARGETS);
  const [a, b] = set.perTenant;

  it("one Markdown file per tenant, named by tenant, plus one combined file", () => {
    expect(set.perTenant.map((f) => f.filename)).toEqual([
      `app-registration-request-${TA}.md`,
      `app-registration-request-${TB}.md`,
    ]);
    expect(set.combined?.filename).toBe("app-registration-requests-2-tenants.md");
    expect(set.perTenant.map((f) => f.tenantId)).toEqual([TA, TB]);
  });

  it("names its own tenant everywhere and never the other's", () => {
    for (const [file, own, other] of [
      [a, TA, TB],
      [b, TB, TA],
    ] as const) {
      const body = file?.body ?? "";
      expect(body).not.toContain("<tenant id>");
      expect(body).not.toContain(other);
      // Title, step 1, Graph consent, hand-back, specifics, header and the diagram.
      expect(body.split(own).length - 1).toBeGreaterThanOrEqual(7);
      expect(body).toContain(`create Entra app registration for ${APP} in tenant ${own}`);
      expect(body).toContain(`Hand back (tenant ${own})`);
    }
  });

  it("separates core roles from feature roles, core first, each in its own section", () => {
    const body = a?.body ?? "";
    const core = body.indexOf("Azure RBAC roles (setup path: existing) - core");
    const feature = body.indexOf("Azure RBAC roles (setup path: existing) - feature");
    expect(core).toBeGreaterThan(-1);
    expect(feature).toBeGreaterThan(core);
    const coreSection = body.slice(core, feature);
    const featureSection = body.slice(feature, body.indexOf("Specifics", feature));
    expect(coreSection).toContain("[core]");
    expect(coreSection).not.toContain("[feature]  ");
    expect(featureSection).toContain("[feature]");
    expect(featureSection).not.toContain("[core]  ");
    expect(coreSection).toContain("- Reader  [core]");
    expect(featureSection).toContain("- Azure Event Hubs Data Owner  [feature]");
  });

  it("every unknown value is a placeholder that survives Markdown rendering (wrapped in code)", () => {
    const body = b?.body ?? "";
    expect(body).toContain("`<client id>`");
    expect(body).toContain("`<subscription id>`");
    expect(body).toContain("`<resource group>`");
    // No bare <placeholder> outside code: a Markdown renderer reads it as an HTML tag.
    for (const line of proseLines(body)) {
      expect(line.replace(/`[^`]*`/g, ""), line).not.toMatch(/<[a-z][a-z ]*>/i);
    }
  });

  it("keeps each line a line when rendered (hard breaks), and leaves the diagram source alone", () => {
    const body = a?.body ?? "";
    expect(body).toContain("    Scope:          /subscriptions/33333333-3333-4333-8333-333333333333  \n");
    expect(body).toContain("```mermaid\nflowchart LR\n");
    const fence = body.slice(body.indexOf("```mermaid"));
    expect(fence.slice(0, fence.indexOf("\n```", 4))).not.toMatch(/ {2}\n/);
  });

  it("is 7-bit ASCII, deterministic, and empty for no tenants", () => {
    for (const f of set.perTenant) {
      for (const ch of f.body) expect(ch.charCodeAt(0)).toBeLessThan(0x80);
    }
    expect(tenantChangeRequests(APP, TARGETS)).toEqual(set);
    expect(tenantChangeRequests(APP, [])).toEqual({ perTenant: [], combined: null });
  });

  it("the combined file carries every tenant's ticket verbatim, after an index", () => {
    const combined = set.combined?.body ?? "";
    expect(combined.indexOf(a?.body ?? "!")).toBeGreaterThan(0);
    expect(combined.indexOf(b?.body ?? "!")).toBeGreaterThan(combined.indexOf(a?.body ?? "!"));
    expect(combined).toContain(`- ${TA}\n`);
    expect(combined).toContain(`- ${TB} (no connection yet)`);
  });

  it("opens with a warning that it is the requester's copy, never to be sent to a tenant", () => {
    const combined = set.combined?.body ?? "";
    expect(combined.split("\n")[0]).toBe(
      "REQUESTER'S COPY - DO NOT SEND THIS FILE. It holds the requests for 2 tenants, so it names every tenant's ids; send each tenant's administrators only that tenant's own file.",
    );
  });

  it("the index names no connection: those are customer-chosen labels another tenant must not read", () => {
    const combined = set.combined?.body ?? "";
    const index = combined.slice(0, combined.indexOf("\n---\n"));
    expect(index).not.toContain("Contoso prod");
  });
});

describe("tenantChangeRequests - a tenant two connections carry", () => {
  const base = { tenantId: TA, connectionsForTenant: 2, undeterminedConnections: [] };
  const targets: TenantTicketTarget[] = [
    {
      ...base,
      connectionName: "X lab",
      config: { ...EMPTY_AZURE_CONFIG, tenantId: TA, subscriptionId: "sub-one", setupPath: "lab-new-rg" },
    },
    {
      ...base,
      connectionName: "X prod",
      config: { ...EMPTY_AZURE_CONFIG, tenantId: TA, subscriptionId: "sub-two", resourceGroup: "rg-b" },
    },
  ];
  const set = tenantChangeRequests(APP, targets);
  const [lab, prod] = set.perTenant;

  it("one file per connection, with distinct names", () => {
    expect(set.perTenant.map((f) => f.filename)).toEqual([
      `app-registration-request-${TA}-1.md`,
      `app-registration-request-${TA}-2.md`,
    ]);
    expect(set.perTenant.map((f) => f.connectionName)).toEqual(["X lab", "X prod"]);
  });

  it("each asks for ITS connection's scopes and setup path, never the other's", () => {
    expect(lab?.body).toContain("/subscriptions/sub-one");
    expect(lab?.body).not.toContain("sub-two");
    expect(lab?.body).toContain("setup path: lab-new-rg");
    expect(prod?.body).toContain("/subscriptions/sub-two/resourceGroups/rg-b");
    expect(prod?.body).not.toContain("sub-one");
    expect(prod?.body).toContain("setup path: existing");
  });

  it("each opens by saying which connection it covers, and that the other has its own request", () => {
    expect(prod?.body.split("\n").slice(0, 4).join("\n")).toBe(
      [
        "This tenant has 2 connections in the requesting app, and each has its own  ",
        'request. This one covers connection "X prod" only: the roles and scopes  ',
        "below are for its subscription, resource group and setup path. If the  ",
        "connections share one app registration, create it once and grant it every request's roles.  ",
      ].join("\n"),
    );
  });

  it("the combined index says which request of the tenant's each one is", () => {
    const combined = set.combined?.body ?? "";
    expect(combined).toContain(`- ${TA} (request 1 of 2)\n- ${TA} (request 2 of 2)`);
  });
});

describe("ticketMarkdown", () => {
  it("wraps placeholders in code and hard-breaks prose lines, outside fences only", () => {
    expect(ticketMarkdown("Tenant id: <tenant id>\n\n```mermaid\nx[\"<a>\"]\n```\nend")).toBe(
      "Tenant id: `<tenant id>`  \n\n```mermaid\nx[\"<a>\"]\n```\nend  ",
    );
  });
});
