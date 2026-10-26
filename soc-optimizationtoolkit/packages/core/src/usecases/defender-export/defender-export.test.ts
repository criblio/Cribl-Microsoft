import { describe, expect, it } from "vitest";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { FakeLogger } from "../../testing/fake-logger";
import type { AzureManagement } from "../../ports/azure-management";
import {
  DEFENDER_AUTOMATIONS_MAX_PAGES,
  deployDefenderExport,
  readDefenderState,
} from "./defender-export";
import type { DefenderDeployInput } from "./defender-export";

const SUB = "00000000-0000-0000-0000-000000000001";
const NS = { subscriptionId: SUB, resourceGroup: "eh-rg", name: "cribl-ns" };
const HUB_ID = `/subscriptions/${SUB}/resourceGroups/eh-rg/providers/Microsoft.EventHub/namespaces/cribl-ns/eventhubs/defender`;
const SENTINEL_KEY = "SENTINELKEYdoNotLeak0123456789abcdef=";
const SENTINEL_CS = `Endpoint=sb://cribl-ns.servicebus.windows.net/;SharedAccessKeyName=SendOnly;SharedAccessKey=${SENTINEL_KEY}`;

const INPUT: DefenderDeployInput = {
  subscriptionId: SUB,
  resourceGroup: "other-rg",
  location: "westus2",
  namespace: NS,
  hubName: "defender",
  ruleName: "SendOnly",
};
const OUR_ID = `/subscriptions/${SUB}/resourceGroups/other-rg/providers/Microsoft.Security/automations/CriblDefenderExport`;

function automation(opts: {
  name: string;
  rg: string;
  isEnabled?: boolean;
  target?: string;
  sources?: string[];
}): unknown {
  return {
    id: `/subscriptions/${SUB}/resourceGroups/${opts.rg}/providers/Microsoft.Security/automations/${opts.name}`,
    name: opts.name,
    properties: {
      isEnabled: opts.isEnabled ?? true,
      scopes: [{ description: "s", scopePath: `/subscriptions/${SUB}` }],
      sources: (opts.sources ?? ["Alerts"]).map((eventSource) => ({ eventSource })),
      actions: [{ actionType: "EventHub", eventHubResourceId: opts.target ?? HUB_ID }],
    },
  };
}

const list = (...items: unknown[]) => ({ status: 200, body: { value: items } });
const keys = { status: 200, body: { primaryConnectionString: SENTINEL_CS, primaryKey: SENTINEL_KEY } };
const pricings = {
  status: 200,
  body: {
    value: [
      { name: "VirtualMachines", properties: { pricingTier: "Standard" } },
      { name: "KeyVaults", properties: { pricingTier: "Free" } },
    ],
  },
};
const forbidden = { status: 403, body: { error: { code: "AuthorizationFailed", message: "no" } } };
const unregistered = {
  status: 409,
  body: { error: { code: "MissingSubscriptionRegistration", message: "register Microsoft.Security" } },
};

function methods(azure: FakeAzureManagement): string[] {
  return azure.calls.map((c) => c.method);
}

const NEXT = "https://management.azure.com/next";
/** A list page that is empty and points at one more page. */
const emptyPageWithNext = { status: 200, body: { value: [], nextLink: NEXT } };
/**
 * The first list page plus enough nextLink pages to cross the cap: every page
 * points at another, so a capped reader stops after MAX nextLink pages.
 */
function overlongChain(): { status: number; body: unknown }[] {
  return Array.from({ length: DEFENDER_AUTOMATIONS_MAX_PAGES + 2 }, () => emptyPageWithNext);
}
/**
 * 2xx list answers that are not a listing: an empty object, no body, a
 * proxy's HTML page, and a `value` that is not an array. Each must be unread,
 * never an empty list.
 */
const NOT_A_LISTING: [string, unknown][] = [
  ["{}", {}],
  ["null", null],
  ["an HTML string", "<html>Sign in</html>"],
  ["value not an array", { value: "x" }],
];
/** The fake WITHOUT the optional requestUrl, as an adapter that cannot paginate. */
function withoutRequestUrl(fake: FakeAzureManagement): AzureManagement {
  return { request: (o) => fake.request(o) };
}

describe("readDefenderState", () => {
  it("an isEnabled:false CriblDefenderExport is present-differs, not deployed", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(pricings, list(automation({ name: "CriblDefenderExport", rg: "CriblSecurityExport", isEnabled: false })));
    const state = await readDefenderState(azure, SUB);
    expect(state.ours.kind).toBe("present-differs");
    if (state.ours.kind === "present-differs") {
      expect(state.ours.diffs).toEqual(["The export is not enabled."]);
    }
    expect(state.deployed).toEqual([]);
    expect(state.unknownReason).toBeUndefined();
  });

  it("a matching CriblDefenderExport in a legacy resource group is deployed", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(pricings, list(automation({ name: "CriblDefenderExport", rg: "CriblSecurityExport" })));
    const state = await readDefenderState(azure, SUB);
    expect(state.ours.kind).toBe("present-matching");
    expect(state.deployed).toEqual(["defenderExport"]);
    expect(state.plans.kind).toBe("read");
    if (state.plans.kind === "read") {
      expect(state.plans.pricings.enabled.map((p) => p.name)).toEqual(["VirtualMachines"]);
    }
  });

  it("a pricings 403 is denied and carries no enabled array; the automations read still happens", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(forbidden, list());
    const state = await readDefenderState(azure, SUB);
    expect(state.plans.kind).toBe("denied");
    expect(state.plans).not.toHaveProperty("enabled");
    expect(state.plans).not.toHaveProperty("pricings");
    expect(state.ours).toEqual({ kind: "absent", measured: false });
    expect(azure.calls).toHaveLength(2);
  });

  it("MissingSubscriptionRegistration is unregistered, for plans and automations alike", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(unregistered, unregistered);
    const state = await readDefenderState(azure, SUB);
    expect(state.plans.kind).toBe("unregistered");
    expect(state.automations.kind).toBe("unread");
    if (state.automations.kind === "unread") {
      expect(state.automations.failure.kind).toBe("unregistered");
    }
  });

  it("an automations-list 500 gives ours unknown with a reason and nothing deployed", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(pricings, { status: 500, body: { error: { code: "InternalError", message: "boom" } } });
    const state = await readDefenderState(azure, SUB);
    expect(state.ours.kind).toBe("unknown");
    expect(state.deployed).toEqual([]);
    expect(state.unknownReason).toContain("HTTP 500");
    expect(state.unknownReason).toContain("boom");
  });

  for (const [label, body] of NOT_A_LISTING) {
    it(`a 2xx automations list whose body is ${label} gives ours unknown, not absent`, async () => {
      const azure = new FakeAzureManagement();
      azure.respondWith(pricings, { status: 200, body });
      const state = await readDefenderState(azure, SUB);
      expect(state.automations.kind).toBe("unread");
      expect(state.ours.kind).toBe("unknown");
      expect(state.deployed).toEqual([]);
      expect(state.unknownReason).toContain("no value array");
    });
  }

  it("a 2xx nextLink page with no value array makes the whole list unread", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(pricings, emptyPageWithNext, { status: 200, body: {} });
    const state = await readDefenderState(azure, SUB);
    expect(state.ours.kind).toBe("unknown");
    expect(state.unknownReason).toContain("(page 2)");
    expect(state.unknownReason).toContain("no value array");
  });

  it("a later nextLink page failing makes the whole list unread, not a partial absent", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      pricings,
      { status: 200, body: { value: [automation({ name: "Other", rg: "x", target: "/elsewhere" })], nextLink: "https://management.azure.com/next" } },
      { status: 500, body: {} },
    );
    const state = await readDefenderState(azure, SUB);
    expect(state.ours.kind).toBe("unknown");
    expect(azure.urlCalls).toHaveLength(1);
  });

  it("finds ours on a nextLink page", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      pricings,
      { status: 200, body: { value: [], nextLink: "https://management.azure.com/next" } },
      list(automation({ name: "CriblDefenderExport", rg: "CriblSecurityExport" })),
    );
    const state = await readDefenderState(azure, SUB);
    expect(state.deployed).toEqual(["defenderExport"]);
  });

  it("a nextLink the adapter cannot follow is unread, not a one-page absent", async () => {
    const fake = new FakeAzureManagement();
    fake.respondWith(pricings, emptyPageWithNext);
    const state = await readDefenderState(withoutRequestUrl(fake), SUB);
    expect(state.ours.kind).toBe("unknown");
    expect(state.deployed).toEqual([]);
    expect(state.unknownReason).toContain("cannot follow nextLink");
    expect(fake.urlCalls).toHaveLength(0);
  });

  it("a nextLink chain past the page cap is unread, not the pages read so far", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(pricings, ...overlongChain());
    const state = await readDefenderState(azure, SUB);
    expect(state.ours.kind).toBe("unknown");
    expect(state.deployed).toEqual([]);
    expect(state.unknownReason).toContain(`more than ${DEFENDER_AUTOMATIONS_MAX_PAGES} pages`);
    expect(azure.urlCalls).toHaveLength(DEFENDER_AUTOMATIONS_MAX_PAGES);
  });

  it("a transport rejection never throws", async () => {
    const azure: AzureManagement = {
      request: () => Promise.reject(new Error("socket hang up")),
    };
    const state = await readDefenderState(azure, SUB);
    expect(state.plans.kind).toBe("failed");
    expect(state.ours.kind).toBe("unknown");
  });

  it("issues only GETs, and none at a pricing outside the list path", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(pricings, list());
    await readDefenderState(azure, SUB);
    expect(methods(azure)).toEqual(["GET", "GET"]);
    expect(azure.calls[0].path).toBe(`/subscriptions/${SUB}/providers/Microsoft.Security/pricings`);
    expect(azure.calls[1].path).toBe(`/subscriptions/${SUB}/providers/Microsoft.Security/automations`);
  });
});

describe("deployDefenderExport", () => {
  function happy(readBack: unknown): FakeAzureManagement {
    const azure = new FakeAzureManagement();
    azure.respondWith(list(), keys, { status: 201, body: {} }, { status: 200, body: readBack });
    return azure;
  }

  it("happy path runs exactly [GET list, POST listKeys, PUT, GET by id]", async () => {
    const azure = happy(automation({ name: "CriblDefenderExport", rg: "other-rg" }));
    const outcome = await deployDefenderExport(azure, INPUT);
    expect(outcome).toEqual({ kind: "written-and-read-back", automationId: OUR_ID });
    expect(azure.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /subscriptions/${SUB}/providers/Microsoft.Security/automations`,
      `POST /subscriptions/${SUB}/resourceGroups/eh-rg/providers/Microsoft.EventHub/namespaces/cribl-ns/authorizationRules/SendOnly/listKeys`,
      `PUT ${OUR_ID}`,
      `GET ${OUR_ID}`,
    ]);
    // The secret goes into the PUT body and nowhere else.
    expect(JSON.stringify(azure.calls[2].body)).toContain(SENTINEL_CS);
    expect((azure.calls[2].body as { location: string }).location).toBe("westus2");
  });

  it("an existing CriblDefenderExport in CriblSecurityExport refuses with already-exists when other-rg is picked", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list(automation({ name: "CriblDefenderExport", rg: "CriblSecurityExport" })));
    const outcome = await deployDefenderExport(azure, INPUT);
    expect(outcome.kind).toBe("already-exists");
    if (outcome.kind === "already-exists") expect(outcome.resourceGroup).toBe("CriblSecurityExport");
    expect(methods(azure)).toEqual(["GET"]);
  });

  it("another automation targeting the chosen hub refuses with possible-duplicate", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list(automation({ name: "PortalExport", rg: "x" })));
    const outcome = await deployDefenderExport(azure, INPUT);
    expect(outcome).toEqual({ kind: "possible-duplicate", names: ["PortalExport"] });
    expect(methods(azure)).toEqual(["GET"]);
  });

  it("a disabled CriblDefenderExport refuses with present-differs and writes nothing", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list(automation({ name: "CriblDefenderExport", rg: "CriblSecurityExport", isEnabled: false })));
    const outcome = await deployDefenderExport(azure, INPUT);
    expect(outcome.kind).toBe("present-differs");
    if (outcome.kind === "present-differs") expect(outcome.diffs).toEqual(["The export is not enabled."]);
    expect(methods(azure)).toEqual(["GET"]);
  });

  it("an automations-list 500 refuses with failed at step automation-list", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 500, body: {} });
    const outcome = await deployDefenderExport(azure, INPUT);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.step).toBe("automation-list");
    expect(methods(azure)).toEqual(["GET"]);
  });

  for (const [label, body] of NOT_A_LISTING) {
    it(`a 2xx automations list whose body is ${label} refuses at automation-list, with no listKeys or PUT`, async () => {
      const azure = new FakeAzureManagement();
      azure.respondWith({ status: 200, body }, keys, { status: 201, body: {} });
      const outcome = await deployDefenderExport(azure, INPUT);
      expect(outcome.kind).toBe("failed");
      if (outcome.kind === "failed") {
        expect(outcome.step).toBe("automation-list");
        expect(outcome.status).toBe(200);
        expect(outcome.message).toContain("no value array");
      }
      expect(methods(azure)).toEqual(["GET"]);
    });
  }

  it("a 2xx nextLink page with no value array refuses at automation-list, with no listKeys or PUT", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(emptyPageWithNext, { status: 200, body: {} }, keys, { status: 201, body: {} });
    const outcome = await deployDefenderExport(azure, INPUT);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.step).toBe("automation-list");
    expect(methods(azure)).toEqual(["GET"]);
    expect(azure.urlCalls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("a nextLink the adapter cannot follow refuses at automation-list, with no listKeys or PUT", async () => {
    const fake = new FakeAzureManagement();
    fake.respondWith(emptyPageWithNext);
    const outcome = await deployDefenderExport(withoutRequestUrl(fake), INPUT);
    expect(outcome).toMatchObject({ kind: "failed", step: "automation-list", status: null });
    expect(methods(fake)).toEqual(["GET"]);
  });

  it("a nextLink chain past the page cap refuses at automation-list, with no listKeys or PUT", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(...overlongChain());
    const outcome = await deployDefenderExport(azure, INPUT);
    expect(outcome).toMatchObject({ kind: "failed", step: "automation-list", status: null });
    expect(methods(azure)).toEqual(["GET"]);
  });

  it("a 403 carrying MissingSubscriptionRegistration is unregistered, not denied", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 403, body: unregistered.body });
    const outcome = await deployDefenderExport(azure, INPUT);
    expect(outcome).toMatchObject({ kind: "unregistered", step: "automation-list", status: 403 });
  });

  it("a 2xx listKeys with no connection string fails at list-keys, sends no PUT, never throws", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list(), { status: 200, body: {} });
    const outcome = await deployDefenderExport(azure, INPUT);
    expect(outcome).toMatchObject({ kind: "failed", step: "list-keys", status: 200 });
    expect(methods(azure)).toEqual(["GET", "POST"]);
  });

  it("a 2xx read-back with no automation in it is accepted-not-verified, not verified", async () => {
    const azure = happy({});
    const outcome = await deployDefenderExport(azure, INPUT);
    expect(outcome).toEqual({
      kind: "accepted-not-verified",
      automationId: OUR_ID,
      reasons: ["The read-back did not contain an automation."],
    });
  });

  it("an automations-list 403 is denied at automation-list", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(forbidden);
    const outcome = await deployDefenderExport(azure, INPUT);
    expect(outcome).toMatchObject({ kind: "denied", step: "automation-list", status: 403 });
  });

  it("a listKeys 403 is denied at list-keys, with no PUT", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list(), forbidden);
    const outcome = await deployDefenderExport(azure, INPUT);
    expect(outcome).toMatchObject({ kind: "denied", step: "list-keys" });
    expect(methods(azure)).toEqual(["GET", "POST"]);
  });

  it("a PUT 403 is denied at automation-put, with no read-back", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list(), keys, forbidden);
    const outcome = await deployDefenderExport(azure, INPUT);
    expect(outcome).toMatchObject({ kind: "denied", step: "automation-put", status: 403 });
    expect(methods(azure)).toEqual(["GET", "POST", "PUT"]);
  });

  it("a PUT unregistered answer is unregistered at automation-put", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list(), keys, unregistered);
    const outcome = await deployDefenderExport(azure, INPUT);
    expect(outcome).toMatchObject({ kind: "unregistered", step: "automation-put" });
  });

  it("a read-back without connectionString but otherwise matching is written-and-read-back", async () => {
    const readBack = automation({ name: "CriblDefenderExport", rg: "other-rg" }) as {
      properties: { actions: Record<string, unknown>[] };
    };
    expect(readBack.properties.actions[0]).not.toHaveProperty("connectionString");
    const azure = happy(readBack);
    expect((await deployDefenderExport(azure, INPUT)).kind).toBe("written-and-read-back");
  });

  it("a read-back with a different eventHubResourceId is accepted-not-verified", async () => {
    const azure = happy(automation({ name: "CriblDefenderExport", rg: "other-rg", target: `${HUB_ID}-other` }));
    const outcome = await deployDefenderExport(azure, INPUT);
    expect(outcome.kind).toBe("accepted-not-verified");
    if (outcome.kind === "accepted-not-verified") {
      expect(outcome.automationId).toBe(OUR_ID);
      expect(outcome.reasons.join(" ")).toContain(`${HUB_ID}-other`);
    }
  });

  it("a read-back that fails after an accepted PUT is accepted-not-verified, not failed", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list(), keys, { status: 200, body: {} }, { status: 404, body: {} });
    expect((await deployDefenderExport(azure, INPUT)).kind).toBe("accepted-not-verified");
  });

  it("an empty automations list does not refuse (first export in a subscription)", async () => {
    const azure = happy(automation({ name: "CriblDefenderExport", rg: "other-rg" }));
    await deployDefenderExport(azure, INPUT);
    expect(methods(azure)).toContain("PUT");
  });

  it("never throws on a transport rejection", async () => {
    const azure: AzureManagement = { request: () => Promise.reject(new Error("offline")) };
    const outcome = await deployDefenderExport(azure, INPUT);
    expect(outcome).toMatchObject({ kind: "failed", step: "automation-list", status: null });
  });

  describe("the connection string goes nowhere but the PUT body", () => {
    const echoesSecret = {
      status: 400,
      body: { error: { code: "InvalidRequest", message: `bad connectionString ${SENTINEL_CS}` } },
    };
    // Only the key, under a different Endpoint: the full-string scrub cannot
    // match it, so this exercises the key-only scrub on its own.
    const echoesKeyOnly = {
      status: 400,
      body: {
        error: {
          code: "InvalidRequest",
          message: `bad key Endpoint=sb://elsewhere.servicebus.windows.net/;SharedAccessKey=${SENTINEL_KEY}`,
        },
      },
    };
    const scenarios: [string, () => FakeAzureManagement][] = [
      ["happy path", () => happy(automation({ name: "CriblDefenderExport", rg: "other-rg" }))],
      [
        "PUT error echoing the body",
        () => {
          const a = new FakeAzureManagement();
          a.respondWith(list(), keys, echoesSecret);
          return a;
        },
      ],
      [
        "read-back error echoing the body",
        () => {
          const a = new FakeAzureManagement();
          a.respondWith(list(), keys, { status: 201, body: {} }, echoesSecret);
          return a;
        },
      ],
      [
        "PUT error echoing only the key",
        () => {
          const a = new FakeAzureManagement();
          a.respondWith(list(), keys, echoesKeyOnly);
          return a;
        },
      ],
      [
        "read-back error echoing only the key",
        () => {
          const a = new FakeAzureManagement();
          a.respondWith(list(), keys, { status: 201, body: {} }, echoesKeyOnly);
          return a;
        },
      ],
      [
        "read-back that returns the secret",
        () =>
          happy({
            ...(automation({ name: "CriblDefenderExport", rg: "other-rg" }) as object),
            properties: {
              isEnabled: true,
              scopes: [{ scopePath: `/subscriptions/${SUB}` }],
              sources: [{ eventSource: "Alerts" }],
              actions: [{ actionType: "EventHub", eventHubResourceId: HUB_ID, connectionString: SENTINEL_CS }],
            },
          }),
      ],
    ];
    for (const [name, make] of scenarios) {
      it(`${name}: absent from the outcome and from every log entry`, async () => {
        const azure = make();
        const logger = new FakeLogger(() => "t");
        const outcome = await deployDefenderExport(azure, INPUT, logger);
        expect(azure.calls.some((c) => c.method === "PUT")).toBe(true);
        expect(JSON.stringify(outcome)).not.toContain(SENTINEL_KEY);
        expect(logger.entries.length).toBeGreaterThan(0);
        expect(JSON.stringify(logger.entries)).not.toContain(SENTINEL_KEY);
      });
    }
  });

  it("never sends a non-GET to pricings and never DELETEs, across every scenario", async () => {
    const scripts: unknown[][] = [
      [list(), keys, { status: 201, body: {} }, { status: 200, body: automation({ name: "CriblDefenderExport", rg: "other-rg" }) }],
      [list(automation({ name: "PortalExport", rg: "x" }))],
      [list(), keys, forbidden],
      [list(), forbidden],
    ];
    for (const script of scripts) {
      const azure = new FakeAzureManagement();
      azure.respondWith(...(script as never[]));
      await deployDefenderExport(azure, INPUT);
      for (const call of azure.calls) {
        expect(call.method).not.toBe("DELETE");
        expect(call.path.toLowerCase()).not.toContain("/pricings");
      }
      expect(azure.calls.filter((c) => c.method === "PUT").length).toBeLessThanOrEqual(1);
    }
  });
});
