// Pins for the Azure onboarding screen's pure state (AZR-18, unit U10).
//
// The failures these exist to catch are all one shape - an unknown rendered
// as a fact: a failed KV read treated as a first run and then overwritten, a
// failed Defender read shown as "Not selected", a denied plans read shown as
// "no paid plan", and a hedge re-worded per screen until it drifts.

import { describe, expect, it } from "vitest";
import {
  DEFENDER_EXPORT_NAME,
  FakeKvDocumentStore,
  ITEM_AVAILABILITY,
  COVERAGE_SELECTION_KEY,
  COVERAGE_SELECTION_VERSION,
  DEFENDER_PLANS,
  defaultSelection,
  encodeSelection,
  toListing,
} from "@soc/core";
import type {
  CoverageSelection,
  DefenderAutomation,
  DefenderDeployOutcome,
  DefenderPlansState,
  DefenderState,
  EventHubNamespaceInfo,
  EventHubTargetRead,
  EventHubTargetRule,
  NamespaceRef,
} from "@soc/core";
import { findHistoryInCopy } from "../../components/copy-rules";
import {
  unmeasuredInventoryMessage,
  verifiedNoneInventoryMessage,
} from "../../capabilities/empty-inventory";
import {
  DEFENDER_ITEM_ID,
  DELIVERY_NOT_VERIFIED,
  NEVER_ENABLES_PLAN_NOTE,
  PLAN_ENABLEMENT_STEPS,
  UNCONFIRMED_ABSENT_NOTE,
  ZERO_PLANS_DEPLOY_ALLOWED,
  buildSections,
  canSave,
  criblSideReadingOf,
  defenderDeployDisabledReason,
  defenderStateNote,
  deployOutcomeMessage,
  hubListMessage,
  loadBanners,
  loadStateFrom,
  loadedSelection,
  namespaceListMessage,
  planSummary,
  ruleListMessage,
  ruleNote,
  sendableRules,
  withItem,
} from "./azure-onboarding-state";
import type { DefenderDeployGate, OnboardingLoadState, OnboardingRowView } from "./azure-onboarding-state";

const KEY = COVERAGE_SELECTION_KEY;

async function loadVia(store: FakeKvDocumentStore): Promise<OnboardingLoadState> {
  return loadStateFrom(await store.load(KEY));
}

const EDITED = { dirty: true, saving: false } as const;

describe("loadStateFrom and canSave - a failed read is not a first run", () => {
  it("blocks Save on read-unknown, doc-foreign and doc-unreadable even when dirty", async () => {
    const unknown = await loadVia(
      new FakeKvDocumentStore().scriptLoad(KEY, { kind: "unknown", reason: "HTTP 403", status: 403 }),
    );
    const foreign = await loadVia(new FakeKvDocumentStore({ [KEY]: { kind: "something-else", version: 1 } }));
    const unreadable = await loadVia(
      new FakeKvDocumentStore({ [KEY]: { kind: "azure-coverage-selection", version: 2, enabled: [] } }),
    );

    expect(unknown.status).toBe("read-unknown");
    expect(foreign.status).toBe("doc-foreign");
    expect(unreadable.status).toBe("doc-unreadable");
    for (const load of [unknown, foreign, unreadable]) {
      expect(canSave(load, EDITED), load.status).toBe(false);
      expect(loadedSelection(load), load.status).toBeNull();
    }
  });

  it("an absent load shows the defaults with a banner and is not saved automatically", async () => {
    const load = await loadVia(new FakeKvDocumentStore());

    expect(load.status).toBe("absent");
    expect(loadedSelection(load)).toEqual(defaultSelection());
    // Not dirty on arrival: Save stays off until the operator changes something.
    expect(canSave(load, { dirty: false, saving: false })).toBe(false);
    expect(canSave(load, EDITED)).toBe(true);
    const banners = loadBanners(load);
    expect(banners).toHaveLength(1);
    expect(banners[0].text).toMatch(/defaults/);
    expect(banners[0].text).toMatch(/Nothing is saved until you choose Save/);
  });

  it("a readable document of ours is ready, keeps its selection, and saves only when dirty and idle", async () => {
    const mine: CoverageSelection = { ...defaultSelection(), enabled: ["defenderExport"] };
    const load = await loadVia(new FakeKvDocumentStore({ [KEY]: JSON.parse(encodeSelection(mine)) }));

    expect(load.status).toBe("ready");
    expect(loadedSelection(load)?.enabled).toEqual(["defenderExport"]);
    expect(loadBanners(load)).toEqual([]);
    expect(canSave(load, EDITED)).toBe(true);
    expect(canSave(load, { dirty: false, saving: false })).toBe(false);
    expect(canSave(load, { dirty: true, saving: true })).toBe(false);
    expect(canSave({ status: "loading" }, EDITED)).toBe(false);
  });

  it("names every blocked state in a banner, and reports dropped ids", () => {
    expect(loadBanners({ status: "read-unknown", reason: "HTTP 503" })[0].text).toContain("HTTP 503");
    expect(loadBanners({ status: "doc-foreign", kind: "other" })[0].text).toContain('"other"');
    expect(loadBanners({ status: "doc-unreadable", version: 7 })[0].text).toContain("version 7");
    for (const load of [
      { status: "read-unknown", reason: "x" },
      { status: "doc-foreign", kind: "x" },
      { status: "doc-unreadable", version: 0 },
    ] as const) {
      expect(loadBanners(load)[0].text, load.status).toMatch(/Saving is turned off/);
    }

    const withDropped = loadStateFrom({
      kind: "value",
      value: { kind: "azure-coverage-selection", version: COVERAGE_SELECTION_VERSION, enabled: ["gone-item"] },
    });
    const texts = loadBanners(withDropped).map((b) => b.text);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("gone-item");
  });
});

describe("withItem", () => {
  it("ticks a built item, unticks any item, and refuses to tick a not-built one", () => {
    const base: CoverageSelection = { ...defaultSelection(), enabled: ["entraId"] };

    expect(withItem(base, "defenderExport", true).enabled).toEqual(["entraId", "defenderExport"]);
    expect(withItem(base, "entraId", false).enabled).toEqual([]);
    expect(withItem(base, "activityLog", true)).toBe(base);
  });
});

function itemRow(sections: ReturnType<typeof buildSections>, id: string): Extract<OnboardingRowView, { kind: "item" }> {
  for (const s of sections) {
    for (const r of s.rows) if (r.kind === "item" && r.id === id) return r;
  }
  throw new Error(`no row ${id}`);
}

describe("buildSections - an unread state is never a confident negative", () => {
  const ticked: CoverageSelection = { ...defaultSelection(), enabled: ["defenderExport"] };
  const unticked: CoverageSelection = { ...defaultSelection(), enabled: [] };

  it("an unknown Defender row never reads 'will be deployed' or 'Not selected', ticked or not", () => {
    const unknown = new Map([[DEFENDER_ITEM_ID, "HTTP 403 listing automations"]]);
    for (const selection of [ticked, unticked]) {
      for (const deployed of [[], [DEFENDER_ITEM_ID], null]) {
        const row = itemRow(buildSections(selection, deployed, unknown), DEFENDER_ITEM_ID);
        expect(row.label).not.toMatch(/will be deployed|Not selected/);
        expect(row.label).toBe("Deployment state could not be read - HTTP 403 listing automations");
        expect(row.state).toBe("unknown");
      }
    }
  });

  it("before any read, the Defender row makes no deployment claim either", () => {
    for (const selection of [ticked, unticked]) {
      const row = itemRow(buildSections(selection, null, new Map()), DEFENDER_ITEM_ID);
      expect(row.label).not.toMatch(/will be deployed|Not selected/);
      expect(row.state).toBe("unread");
    }
  });

  it("labels the four read states, and deployed-unselected always says it is still running", () => {
    const at = (sel: CoverageSelection, deployed: string[]) =>
      itemRow(buildSections(sel, deployed, new Map()), DEFENDER_ITEM_ID);

    expect(at(ticked, []).label).toBe("Selected - will be deployed");
    expect(at(unticked, []).label).toBe("Not selected");
    expect(at(ticked, [DEFENDER_ITEM_ID]).label).toBe("Deployed");
    const left = at(unticked, [DEFENDER_ITEM_ID]);
    expect(left.state).toBe("deployed-unselected");
    expect(left.label).toMatch(/still running/);
  });

  it("entraId, ticked by default, reads 'Selected - not available yet' and is not tickable", () => {
    const row = itemRow(buildSections(defaultSelection(), [], new Map()), "entraId");

    expect(row.label).toBe("Selected - not available yet");
    expect(row.tickable).toBe(false);
    expect(itemRow(buildSections(defaultSelection(), [], new Map()), DEFENDER_ITEM_ID).tickable).toBe(true);
  });

  it("with no selection loaded, nothing is tickable", () => {
    const row = itemRow(buildSections(null, [], new Map()), DEFENDER_ITEM_ID);
    expect(row.tickable).toBe(false);
  });

  it("keeps core's layout: every section, the unsupported rows and the XDR row", () => {
    const sections = buildSections(defaultSelection(), [], new Map());
    const none = sections.find((s) => s.key === "none");
    const xdr = none?.rows.find((r) => r.kind === "xdr-tables");
    expect(sections.map((s) => s.key)).toEqual([
      "built-in-policy",
      "custom-initiative",
      "script",
      "guided-portal",
      "none",
    ]);
    expect(xdr?.kind === "xdr-tables" ? xdr.tables : []).toEqual(
      expect.arrayContaining(["BehaviorEntities", "BehaviorInfo"]),
    );
    expect(sections.find((s) => s.key === "script")?.availability).toBe("available");
  });
});

// ---------------------------------------------------------------------------
// Defender deploy gate
// ---------------------------------------------------------------------------

const SUB = "00000000-0000-0000-0000-000000000001";
const NS: NamespaceRef = { subscriptionId: SUB, resourceGroup: "rg-eh", name: "ns-a" };
const HUB_ID = `/subscriptions/${SUB}/resourceGroups/rg-eh/providers/Microsoft.EventHub/namespaces/ns-a/eventhubs/defender`;

function automation(over: Partial<DefenderAutomation>): DefenderAutomation {
  return {
    id: `/subscriptions/${SUB}/resourceGroups/rg-x/providers/Microsoft.Security/automations/${over.name ?? "x"}`,
    name: "x",
    resourceGroup: "rg-x",
    isEnabled: true,
    sources: ["Alerts"],
    scopePaths: [`/subscriptions/${SUB}`],
    actions: [{ actionType: "EventHub", eventHubResourceId: HUB_ID }],
    eventHubTargets: [HUB_ID],
    ...over,
  };
}

const READ_PLANS: DefenderPlansState = {
  kind: "read",
  pricings: {
    kind: "read",
    enabled: [{ name: "VirtualMachines", displayName: "Defender for Servers", tier: "Standard" }],
    disabled: [],
    unrecognized: [],
  },
};

function state(over: Partial<DefenderState> = {}): DefenderState {
  return {
    plans: READ_PLANS,
    automations: { kind: "listed", listing: toListing<DefenderAutomation>([]) },
    ours: { kind: "absent", measured: false },
    deployed: [],
    ...over,
  };
}

// READY's state is the UNMEASURED absent (an empty automations list) on
// purpose: that is what a fresh subscription returns, so it must stay
// deployable. Its uncertainty is surfaced by defenderStateNote, not the gate.
const READY: DefenderDeployGate = {
  running: false,
  selection: { ...defaultSelection(), enabled: [DEFENDER_ITEM_ID] },
  state: state(),
  namespace: NS,
  hubName: "defender",
  rule: { name: "cribl-send", rights: ["Send"] },
  resourceGroup: "rg-security",
};

describe("defenderDeployDisabledReason", () => {
  it("is null when every input is in place - no capability verdict gates it", () => {
    expect(defenderDeployDisabledReason(READY)).toBeNull();
  });

  it("refuses when ours is already deployed", () => {
    const ours = automation({ name: DEFENDER_EXPORT_NAME, resourceGroup: "CriblSecurityExport" });
    const reason = defenderDeployDisabledReason({
      ...READY,
      state: state({ ours: { kind: "present-matching", automation: ours }, deployed: [DEFENDER_ITEM_ID] }),
    });
    expect(reason).toMatch(/already exists in CriblSecurityExport/);
  });

  it("refuses when ours is present but differs, naming the differences", () => {
    const ours = automation({ name: DEFENDER_EXPORT_NAME, isEnabled: false });
    const reason = defenderDeployDisabledReason({
      ...READY,
      state: state({ ours: { kind: "present-differs", automation: ours, diffs: ["It is disabled."] } }),
    });
    expect(reason).toContain("It is disabled.");
  });

  it("refuses a possible duplicate: another export already targets the chosen hub", () => {
    const other = automation({ name: "SomeoneElsesExport" });
    const reason = defenderDeployDisabledReason({
      ...READY,
      state: state({ automations: { kind: "listed", listing: toListing([other]) } }),
    });
    expect(reason).toMatch(/SomeoneElsesExport/);
    expect(reason).toMatch(/twice/);
  });

  it("refuses a rule that can only Listen", () => {
    const reason = defenderDeployDisabledReason({ ...READY, rule: { name: "listen-only", rights: ["Listen"] } });
    expect(reason).toBe("The selected rule cannot send events - it has Listen.");
  });

  it("reports one reason, in the fixed priority", () => {
    const dupState = (over: Partial<DefenderState> = {}): DefenderState =>
      state({
        automations: { kind: "listed", listing: toListing([automation({ name: "SomeoneElsesExport" })]) },
        ...over,
      });
    // Each step breaks one more input than the next, so each must report the
    // highest-priority reason among those broken.
    const cases: Array<[Partial<DefenderDeployGate>, RegExp]> = [
      [{ running: true, selection: null, state: null, hubName: "", rule: null, resourceGroup: "" }, /already running/],
      [{ selection: null, state: null, hubName: "", rule: null, resourceGroup: "" }, /has not loaded/],
      [{ selection: { ...defaultSelection(), enabled: [] }, state: null }, /Tick the Defender/],
      // The duplicate and present-differs refusals outrank every later input:
      // with the same-target export listed, a missing rule or resource group
      // (or an unread ours) must not hide the duplicate.
      [{ state: dupState(), rule: null, resourceGroup: "" }, /twice/],
      [{ state: dupState({ ours: { kind: "unknown", reason: "HTTP 500" } }), resourceGroup: "" }, /twice/],
      [
        {
          state: dupState({
            ours: {
              kind: "present-differs",
              automation: automation({ name: DEFENDER_EXPORT_NAME, isEnabled: false }),
              diffs: ["It is disabled."],
            },
          }),
          rule: null,
        },
        /differs from what this app writes/,
      ],
      [{ state: null, hubName: "", rule: null }, /Read the Defender state first/],
      [{ state: state({ ours: { kind: "unknown", reason: "HTTP 500" } }), hubName: "" }, /could not be read - HTTP 500/],
      [{ hubName: "", rule: null, resourceGroup: "" }, /Choose the Event Hub/],
      [{ rule: null, resourceGroup: "" }, /authorization rule/],
      [{ rule: { name: "l", rights: ["Listen"] }, resourceGroup: "" }, /cannot send/],
      [{ resourceGroup: "" }, /resource group/],
    ];
    for (const [over, expected] of cases) {
      expect(defenderDeployDisabledReason({ ...READY, ...over }), String(expected)).toMatch(expected);
    }
  });

  it("allows zero paid plans by default, and refuses when the constant says so", () => {
    const zero = state({
      plans: { kind: "read", pricings: { kind: "read", enabled: [], disabled: [], unrecognized: [] } },
    });
    expect(ZERO_PLANS_DEPLOY_ALLOWED).toBe(true);
    expect(defenderDeployDisabledReason({ ...READY, state: zero })).toBeNull();
    expect(defenderDeployDisabledReason({ ...READY, state: zero, zeroPlansAllowed: false })).toMatch(/No paid plan/);
  });
});

describe("defenderStateNote - an empty automations list is not a measured absence", () => {
  it("warns on an unmeasured absent and stays silent when the absence was measured", () => {
    const listed = toListing([automation({ name: "SomeoneElsesExport", eventHubTargets: [], actions: [] })]);

    expect(defenderStateNote(state())).toEqual({ tone: "warning", text: UNCONFIRMED_ABSENT_NOTE });
    // The hedge is the shared unmeasured wording, not phrased per screen.
    expect(UNCONFIRMED_ABSENT_NOTE).toBe(
      `${unmeasuredInventoryMessage("continuous exports").text}, so the duplicate check had nothing to compare against.`,
    );
    expect(defenderStateNote(state({ ours: { kind: "absent", measured: true }, automations: { kind: "listed", listing: listed } }))).toBeNull();
    expect(defenderStateNote(state({ ours: { kind: "unknown", reason: "HTTP 500" } }))).toBeNull();
    expect(defenderStateNote(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

const ALL_FREE = DEFENDER_PLANS.map((p) => ({ ...p, tier: "Free" }));

describe("planSummary - only a read with no Standard pricing says no paid plan", () => {
  it("12 known Free plans plus one unrecognised Standard pricing is NOT 'no paid plan'", () => {
    expect(ALL_FREE).toHaveLength(12);
    const summary = planSummary({
      kind: "read",
      pricings: { kind: "read", enabled: [], disabled: ALL_FREE, unrecognized: [{ name: "CloudPosture", tier: "Standard" }] },
    });
    expect(summary.headline).not.toMatch(/no .*paid plan/i);
    expect(summary.tone).toBe("ok");
    expect(summary.rows.find((r) => r.name === "CloudPosture")?.status).toBe("Enabled, not in the known plan list");
    // The headline lists exactly the pricings the rows call enabled.
    expect(summary.headline).toBe("Paid Defender plans enabled: CloudPosture.");
  });

  it("denied, unregistered and failed never say no paid plan", () => {
    for (const kind of ["denied", "unregistered", "failed"] as const) {
      const summary = planSummary({ kind, status: 403, code: "AuthorizationFailed", message: "Read Defender plans: HTTP 403" });
      expect(summary.headline, kind).not.toMatch(/no .*paid plan/i);
      expect(summary.headline, kind).toMatch(/unknown/);
      expect(summary.tone).toBe("error");
      expect(summary.rows).toEqual([]);
    }
  });

  it("all Free with nothing unrecognised: a warning, the deploy still allowed, and the portal steps", () => {
    const summary = planSummary({
      kind: "read",
      pricings: { kind: "read", enabled: [], disabled: ALL_FREE, unrecognized: [{ name: "Other", tier: "Free" }] },
    });
    expect(summary.headline).toMatch(/no .*paid plan/i);
    expect(summary.headline).toMatch(/can still be created/);
    expect(summary.tone).toBe("warning");
    expect(summary.steps).toEqual(PLAN_ENABLEMENT_STEPS);
    expect(summary.rows).toHaveLength(13);
  });
});

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

function rulesRead(rules: EventHubTargetRule[]): EventHubTargetRead<EventHubTargetRule> {
  return { ok: true, listing: toListing(rules), truncated: false };
}

describe("Event Hub picker messages reuse the shared empty-inventory wording", () => {
  it("an empty namespace listing is exactly unmeasuredInventoryMessage('Event Hub namespaces')", () => {
    expect(namespaceListMessage(toListing<EventHubNamespaceInfo>([]))?.text).toBe(
      unmeasuredInventoryMessage("Event Hub namespaces").text,
    );
  });

  it("a verified-none listing is the shared verified-zero wording, not per-screen copy", () => {
    expect(namespaceListMessage({ kind: "none" })?.text).toBe(
      verifiedNoneInventoryMessage("Event Hub namespaces").text,
    );
    expect(hubListMessage({ ok: true, listing: { kind: "none" }, truncated: false })?.text).toBe(
      verifiedNoneInventoryMessage("Event Hubs").text,
    );
    expect(ruleListMessage({ ok: true, listing: { kind: "none" }, truncated: false })?.text).toBe(
      verifiedNoneInventoryMessage("authorization rules").text,
    );
  });

  it("empty hub and rule listings use the same helper; failures show their message", () => {
    expect(hubListMessage({ ok: true, listing: toListing([]), truncated: false })?.text).toBe(
      unmeasuredInventoryMessage("Event Hubs").text,
    );
    expect(ruleListMessage(rulesRead([]))?.text).toBe(unmeasuredInventoryMessage("authorization rules").text);
    expect(
      hubListMessage({ ok: false, failure: { kind: "denied", status: 403, message: "Could not list hubs: HTTP 403" } })?.text,
    ).toBe("Could not list hubs: HTTP 403");
    expect(hubListMessage({ ok: true, listing: toListing([{ name: "h" } as never]), truncated: true })?.text).toMatch(
      /first page/,
    );
  });

  it("offers only Send-capable rules, and says so when rules exist but none can send", () => {
    const listen: EventHubTargetRule = { name: "listen", id: "", rights: ["Listen"], canSend: false };
    const send: EventHubTargetRule = { name: "send", id: "", rights: ["Send"], canSend: true };

    expect(sendableRules(rulesRead([listen, send])).map((r) => r.name)).toEqual(["send"]);
    expect(ruleListMessage(rulesRead([listen, send]))).toBeNull();
    expect(ruleListMessage(rulesRead([listen]))?.text).toMatch(/None of this namespace's authorization rules can send/);
  });

  it("a truncated list with no Send rule keeps the first-page caveat and claims only the listed rules", () => {
    const listen: EventHubTargetRule = { name: "listen", id: "", rights: ["Listen"], canSend: false };
    const text = ruleListMessage({ ok: true, listing: toListing([listen]), truncated: true })?.text ?? "";

    expect(text).toMatch(/first page/);
    expect(text).toMatch(/^None of the listed authorization rules can send events: listen \(Listen\)\./);
    expect(text).not.toMatch(/this namespace's/);
  });

  it("notes a Manage rule and the built-in root rule, not a Send-only one", () => {
    expect(ruleNote({ name: "RootManageSharedAccessKey", rights: ["Listen", "Manage", "Send"] })).toMatch(/safer/);
    expect(ruleNote({ name: "ops", rights: ["Manage", "Send", "Listen"] })).toMatch(/safer/);
    expect(ruleNote({ name: "cribl-send", rights: ["Send"] })).toBeNull();
    // The built-in rule is noted by NAME even when its rights read back without Manage.
    expect(ruleNote({ name: "RootManageSharedAccessKey", rights: ["Send"] })).toMatch(/safer/);
  });
});

// ---------------------------------------------------------------------------
// Outcomes and copy
// ---------------------------------------------------------------------------

const OUTCOMES: DefenderDeployOutcome[] = [
  { kind: "written-and-read-back", automationId: "/x" },
  { kind: "accepted-not-verified", automationId: "/x", reasons: ["isEnabled differs."] },
  { kind: "already-exists", automationId: "/x", resourceGroup: "rg" },
  { kind: "present-differs", automationId: "/x", diffs: ["It is disabled."] },
  { kind: "possible-duplicate", names: ["Other"] },
  { kind: "denied", step: "list-keys", status: 403, code: "AuthorizationFailed", message: "HTTP 403" },
  { kind: "unregistered", step: "automation-put", status: 409, code: "MissingSubscriptionRegistration", message: "m" },
  { kind: "failed", step: "automation-list", status: null, code: "", message: "timeout" },
];

describe("deployOutcomeMessage", () => {
  it("a success says delivery is not verified until an alert arrives", () => {
    expect(deployOutcomeMessage(OUTCOMES[0]).text).toContain(DELIVERY_NOT_VERIFIED);
    expect(deployOutcomeMessage(OUTCOMES[1]).text).toContain(DELIVERY_NOT_VERIFIED);
    expect(DELIVERY_NOT_VERIFIED).toMatch(/not verified until .*alert arrives/);
  });

  it("a refusal says nothing was written; a failure names the step", () => {
    for (const o of OUTCOMES.slice(2, 5)) expect(deployOutcomeMessage(o).text, o.kind).toMatch(/^Nothing was written/);
    expect(deployOutcomeMessage(OUTCOMES[5]).text).toMatch(/connection string/);
  });
});

describe("visible copy carries no project history", () => {
  it("findHistoryInCopy finds nothing in any string this module returns, nor in core's availability reasons", () => {
    const entries: { where: string; text: string }[] = [];
    const add = (where: string, text: string | null | undefined) => {
      if (text) entries.push({ where, text });
    };

    for (const [id, a] of Object.entries(ITEM_AVAILABILITY)) {
      if (a.status === "not-built") add(`ITEM_AVAILABILITY.${id}`, a.reason);
    }
    expect(entries.length).toBeGreaterThan(0);

    const loads: OnboardingLoadState[] = [
      { status: "read-unknown", reason: "r" },
      { status: "doc-foreign", kind: "k" },
      { status: "doc-unreadable", version: 2 },
      loadStateFrom({ kind: "absent", why: "not-found" }),
      loadStateFrom({ kind: "value", value: { version: 1, enabled: ["gone"] } }),
    ];
    for (const l of loads) for (const b of loadBanners(l)) add(`banner.${l.status}`, b.text);

    const sel = defaultSelection();
    for (const deployed of [[], [DEFENDER_ITEM_ID], null]) {
      for (const s of buildSections(sel, deployed, new Map())) {
        add(`section.${s.key}`, s.title);
        for (const r of s.rows) {
          add(`row.${r.id}.title`, r.title);
          if (r.kind === "item") add(`row.${r.id}.label`, r.label);
          else if (r.kind === "unsupported") {
            add(`row.${r.id}.description`, r.description);
            add(`row.${r.id}.alternative`, r.alternative);
          } else add(`row.${r.id}.reason`, r.reason);
        }
      }
    }
    add("unknown-label", itemRow(buildSections(sel, [], new Map([[DEFENDER_ITEM_ID, "r"]])), DEFENDER_ITEM_ID).label);

    const gates: Partial<DefenderDeployGate>[] = [
      { running: true },
      { selection: null },
      { selection: { ...sel, enabled: [] } },
      { state: state({ ours: { kind: "present-matching", automation: automation({ name: DEFENDER_EXPORT_NAME }) } }) },
      { state: state({ ours: { kind: "present-differs", automation: automation({}), diffs: ["d"] } }) },
      { state: state({ automations: { kind: "listed", listing: toListing([automation({ name: "o" })]) } }) },
      { state: null },
      { state: state({ ours: { kind: "unknown", reason: "r" } }) },
      { zeroPlansAllowed: false, state: state({ plans: { kind: "read", pricings: { kind: "read", enabled: [], disabled: [], unrecognized: [] } } }) },
      { hubName: "" },
      { rule: null },
      { rule: { name: "l", rights: [] } },
      { resourceGroup: "" },
    ];
    for (const [i, g] of gates.entries()) add(`gate.${i}`, defenderDeployDisabledReason({ ...READY, ...g }));

    const plans: DefenderPlansState[] = [
      READ_PLANS,
      { kind: "read", pricings: { kind: "read", enabled: [], disabled: ALL_FREE, unrecognized: [{ name: "X", tier: "Standard" }] } },
      { kind: "read", pricings: { kind: "read", enabled: [], disabled: ALL_FREE, unrecognized: [] } },
      { kind: "denied", status: 403, code: "", message: "m" },
      { kind: "unregistered", status: 409, code: "", message: "m" },
      { kind: "failed", status: null, code: "", message: "m" },
    ];
    for (const p of plans) {
      const s = planSummary(p);
      add(`plans.${p.kind}`, s.headline);
      for (const r of s.rows) add(`plans.row.${r.name}`, r.status);
      for (const step of s.steps) add("plans.step", step);
    }
    add("NEVER_ENABLES_PLAN_NOTE", NEVER_ENABLES_PLAN_NOTE);

    add("ns.empty", namespaceListMessage(toListing<EventHubNamespaceInfo>([]))?.text);
    add("ns.none", namespaceListMessage({ kind: "none" })?.text);
    add("rules.empty", ruleListMessage(rulesRead([]))?.text);
    add("rules.none", ruleListMessage({ ok: true, listing: { kind: "none" }, truncated: false })?.text);
    add("rules.nosend.truncated", ruleListMessage({ ok: true, listing: toListing([{ name: "l", id: "", rights: ["Listen"], canSend: false }]), truncated: true })?.text);
    add("state.note", defenderStateNote(state())?.text);
    add("rules.nosend", ruleListMessage(rulesRead([{ name: "l", id: "", rights: ["Listen"], canSend: false }]))?.text);
    add("hubs.truncated", hubListMessage({ ok: true, listing: toListing([{ name: "h" } as never]), truncated: true })?.text);
    add("rule.note", ruleNote({ name: "r", rights: ["Manage"] }));
    for (const o of OUTCOMES) add(`outcome.${o.kind}`, deployOutcomeMessage(o).text);

    expect(entries.length).toBeGreaterThan(40);
    expect(findHistoryInCopy(entries)).toEqual([]);
  });
});

// DBT-162: the lane reading keeps a bare-id route's flag, so the lane card
// never presents the app's own bare-id route as a confirmed one.
describe("criblSideReadingOf", () => {
  it("carries legacyBareMatch from the consuming route, and only from it", () => {
    const side = (legacy: boolean) => ({
      groupId: "g1",
      requests: [],
      inputs: [
        {
          inputId: "in1",
          inputType: "eventhub",
          input: { kind: "absent" as const },
          route: {
            kind: "consumes" as const,
            routes: [
              { id: "w", name: "wired", filter: "", output: "sentinel_out", final: true, ...(legacy ? { legacyBareMatch: true as const } : {}) },
            ],
          },
        },
      ],
    });
    expect(criblSideReadingOf(side(true)).routes["in1"]).toEqual({
      kind: "consumes",
      route: "wired",
      destination: "sentinel_out",
      legacyBareMatch: true,
    });
    expect(criblSideReadingOf(side(false)).routes["in1"]).toEqual({
      kind: "consumes",
      route: "wired",
      destination: "sentinel_out",
    });
  });
});
