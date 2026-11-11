import { describe, expect, it } from "vitest";
import { readDiagnosticSetting } from "../activity-log-export/diagnostic-setting";
import { ENTRA_CATEGORIES } from "../entra-diagnostics/entra-categories";
import type { DefenderAutomation } from "../defender-export/defender-automation";
import { DEFENDER_EXPORT_ITEM_ID } from "../defender-export/defender-automation";
import { toListing } from "../inventory-listing/inventory-listing";
import { ACTIVITY_LOG_CATEGORIES } from "../activity-log-export/activity-log-setting";
import type { OnboardingProgress } from "../onboarding-howto/progress-document";
import { emptyProgress } from "../onboarding-howto/progress-document";
import {
  activityLogCells, archiveEvidenceFrom, categoryCards, cellTone, defenderCells, DEFENDER_EXPORT_TYPES,
  destinationsOf, entraCells, NOT_CHECKED_YET, withArchive,
} from "./tenant-inventory";
import type { AppArchiveEvidence, LogTypeCell } from "./tenant-inventory";
import type { EntraRead, SubscriptionAutomationsRead, SubscriptionSettingsRead } from "./tenant-inventory";

function setting(props: Record<string, unknown>, name = "s1") {
  return readDiagnosticSetting({ name, id: `/x/${name}`, properties: props });
}
function read(...rows: ReturnType<typeof setting>[]): EntraRead {
  return { kind: "read", settings: toListing(rows) };
}
const on = (category: string) => ({ category, enabled: true });
const grp = (categoryGroup: string) => ({ categoryGroup, enabled: true });
const cell = (cells: ReturnType<typeof entraCells>, name: string) =>
  cells.find((c) => c.logType === name)!;

describe("entraCells", () => {
  it("returns one cell per category in order", () => {
    const cells = entraCells(read());
    expect(cells.map((c) => c.logType)).toEqual(ENTRA_CATEGORIES.map((c) => c.name));
    expect(cells).toHaveLength(15);
    expect(cells.every((c) => c.category === "entraId")).toBe(true);
    expect(cells[0]!.archive).toEqual({ kind: "unknown", reason: "not classified yet" });
  });

  it("marks a named category collected with its workspace destination", () => {
    const c = cell(
      entraCells(read(setting({ workspaceId: "/ws", logs: [on("SignInLogs")] }))),
      "SignInLogs",
    );
    expect(c.state).toEqual({ kind: "collected", scopes: { collected: 1, read: 1, unread: 0 } });
    expect(c.collectors).toEqual([
      {
        kind: "diagnostic-setting",
        name: "s1",
        scope: "tenant",
        destinations: [{ kind: "workspace", resourceId: "/ws" }],
      },
    ]);
  });

  it("leaves an unnamed category not-collected with no collectors", () => {
    const cells = entraCells(read(setting({ workspaceId: "/ws", logs: [on("SignInLogs")] })));
    const audit = cell(cells, "AuditLogs");
    expect(audit.state).toEqual({ kind: "not-collected" });
    expect(audit.collectors).toEqual([]);
  });

  it("makes every cell could-not-check with the reason when unread", () => {
    const cells = entraCells({ kind: "unread", reason: "403 from aadiam" });
    expect(cells).toHaveLength(15);
    for (const c of cells) {
      expect(c.state).toEqual({ kind: "could-not-check", reason: "403 from aadiam" });
    }
  });

  it("collects all 15 for allLogs, case-insensitively", () => {
    const cells = entraCells(read(setting({ storageAccountId: "/sa", logs: [grp("ALLLOGS")] })));
    for (const c of cells) expect(c.state.kind).toBe("collected");
  });

  it("names an unknown group on categories not named elsewhere", () => {
    const cells = entraCells(
      read(setting({ workspaceId: "/ws", logs: [on("SignInLogs"), grp("audit")] })),
    );
    expect(cell(cells, "SignInLogs").state.kind).toBe("collected");
    const audit = cell(cells, "AuditLogs").state;
    expect(audit.kind).toBe("could-not-check");
    expect(audit.kind === "could-not-check" && audit.reason).toContain('"audit"');
  });

  it("makes an empty listing not-collected everywhere", () => {
    for (const c of entraCells(read())) expect(c.state).toEqual({ kind: "not-collected" });
  });
});

describe("destinationsOf", () => {
  it("maps each destination and skips empty ids", () => {
    const s = setting({
      workspaceId: "/ws",
      eventHubAuthorizationRuleId: "/rule",
      storageAccountId: "/sa",
      marketplacePartnerId: "/p",
    });
    expect(destinationsOf(s)).toEqual([
      { kind: "workspace", resourceId: "/ws" },
      { kind: "event-hub", resourceId: "/rule" },
      { kind: "storage", resourceId: "/sa" },
      { kind: "partner", resourceId: "/p" },
    ]);
    expect(destinationsOf(setting({}))).toEqual([]);
  });
});

describe("activityLogCells", () => {
  const withAdmin = (id: string, ...cats: string[]): SubscriptionSettingsRead => ({
    subscriptionId: id,
    kind: "read",
    settings: toListing([setting({ workspaceId: "/ws", logs: cats.map(on) }, `s-${id}`)]),
  });
  const without = (id: string): SubscriptionSettingsRead => ({
    subscriptionId: id,
    kind: "read",
    settings: toListing([setting({ workspaceId: "/ws", logs: [on("Security")] }, `o-${id}`)]),
  });
  const unreadSub = (id: string): SubscriptionSettingsRead => ({
    subscriptionId: id,
    kind: "unread",
    reason: "403 Forbidden",
  });
  const admin = (reads: SubscriptionSettingsRead[]) =>
    activityLogCells(reads).find((c) => c.logType === "Administrative")!;

  it("returns one cell per category in order", () => {
    const cells = activityLogCells([withAdmin("a", "Administrative")]);
    expect(cells.map((c) => c.logType)).toEqual([...ACTIVITY_LOG_CATEGORIES]);
    expect(cells.every((c) => c.category === "activityLog")).toBe(true);
  });

  it("is collected when all 3 subscriptions have it", () => {
    const c = admin([
      withAdmin("a", "Administrative"),
      withAdmin("b", "Administrative"),
      withAdmin("c", "Administrative"),
    ]);
    expect(c.state).toEqual({ kind: "collected", scopes: { collected: 3, read: 3, unread: 0 } });
    expect(c.collectors.map((x) => x.scope)).toEqual(["a", "b", "c"]);
    expect(c.collectors[0]!.name).toBe("s-a");
  });

  it("is partly when 2 of 3 have it", () => {
    const c = admin([withAdmin("a", "Administrative"), withAdmin("b", "Administrative"), without("c")]);
    expect(c.state).toEqual({ kind: "partly", scopes: { collected: 2, read: 3, unread: 0 } });
  });

  it("is partly, never not-collected, when 2 read have it and 1 is unread", () => {
    const c = admin([withAdmin("a", "Administrative"), withAdmin("b", "Administrative"), unreadSub("c")]);
    expect(c.state).toEqual({ kind: "partly", scopes: { collected: 2, read: 2, unread: 1 } });
  });

  it("is could-not-check when none found and one is unread", () => {
    expect(admin([without("a"), unreadSub("b")]).state.kind).toBe("could-not-check");
  });

  it("is not-collected when every subscription was read without it", () => {
    expect(admin([without("a"), without("b")]).state).toEqual({ kind: "not-collected" });
  });

  it("is could-not-check with the reason when all are unread", () => {
    expect(admin([unreadSub("a"), unreadSub("b")]).state).toEqual({
      kind: "could-not-check",
      reason: "403 Forbidden",
    });
  });

  it("is could-not-check when no subscription was visible", () => {
    const cells = activityLogCells([]);
    expect(cells).toHaveLength(ACTIVITY_LOG_CATEGORIES.length);
    expect(cells[0]!.state).toEqual({
      kind: "could-not-check",
      reason: "no subscription was visible to this connection",
    });
    expect(cells.every((c) => c.state.kind === "could-not-check")).toBe(true);
  });

  it("counts an allLogs group for all 8 categories", () => {
    const cells = activityLogCells([
      {
        subscriptionId: "a",
        kind: "read",
        settings: toListing([setting({ workspaceId: "/ws", logs: [grp("allLogs")] })]),
      },
    ]);
    expect(cells).toHaveLength(8);
    expect(cells.every((c) => c.state.kind === "collected")).toBe(true);
  });
});

describe("defenderCells", () => {
  const auto = (
    name: string,
    sources: string[],
    over: Partial<DefenderAutomation> = {},
  ): DefenderAutomation => ({
    id: `/x/${name}`,
    name,
    resourceGroup: "rg",
    isEnabled: true,
    sources,
    scopePaths: [],
    actions: [{ actionType: "EventHub", eventHubResourceId: "/hub", workspaceResourceId: "" }],
    eventHubTargets: ["/hub"],
    ...over,
  });
  const sub = (id: string, ...autos: DefenderAutomation[]): SubscriptionAutomationsRead => ({
    subscriptionId: id,
    kind: "read",
    automations: toListing(autos),
  });
  const unreadSub = (id: string): SubscriptionAutomationsRead => ({
    subscriptionId: id,
    kind: "unread",
    reason: "403 Forbidden",
  });
  const pick = (reads: SubscriptionAutomationsRead[], logType: string) =>
    defenderCells(reads).find((c) => c.logType === logType)!;

  it("returns one cell per export type in order, in the Defender category", () => {
    const cells = defenderCells([sub("a")]);
    expect(cells.map((c) => c.logType)).toEqual(DEFENDER_EXPORT_TYPES.map((t) => t.logType));
    expect(cells.every((c) => c.category === DEFENDER_EXPORT_ITEM_ID)).toBe(true);
  });

  it("collects alerts through an Event Hub action", () => {
    const c = pick([sub("a", auto("exp", ["Alerts"]))], "alerts");
    expect(c.state).toEqual({ kind: "collected", scopes: { collected: 1, read: 1, unread: 0 } });
    expect(c.collectors).toEqual([
      {
        kind: "security-automation",
        name: "exp",
        scope: "a",
        destinations: [{ kind: "event-hub", resourceId: "/hub" }],
      },
    ]);
    expect(pick([sub("a", auto("exp", ["Alerts"]))], "secureScore").state).toEqual({ kind: "not-collected" });
  });

  it("gives a Workspace action a workspace destination and ignores other action types", () => {
    const a = auto("w", ["Alerts"], {
      actions: [
        { actionType: "Workspace", eventHubResourceId: "", workspaceResourceId: "/ws" },
        { actionType: "LogicApp", eventHubResourceId: "", workspaceResourceId: "" },
      ],
    });
    expect(pick([sub("a", a)], "alerts").collectors[0]!.destinations).toEqual([
      { kind: "workspace", resourceId: "/ws" },
    ]);
  });

  it("matches eventSource case-insensitively across each types sources", () => {
    expect(pick([sub("a", auto("e", ["subassessments"]))], "recommendations").state.kind).toBe("collected");
    expect(pick([sub("a", auto("e", ["REGULATORYCOMPLIANCEASSESSMENT"]))], "compliance").state.kind).toBe(
      "collected",
    );
  });

  it("does not collect through a disabled automation but lists it", () => {
    const c = pick([sub("a", auto("off", ["Alerts"], { isEnabled: false }))], "alerts");
    expect(c.state).toEqual({ kind: "not-collected" });
    expect(c.collectors.map((x) => x.name)).toEqual(["off (disabled)"]);
  });

  it("is partly when 1 of 2 subscriptions has it, and partly when 1 has it and 1 is unread", () => {
    expect(pick([sub("a", auto("e", ["Alerts"])), sub("b")], "alerts").state).toEqual({
      kind: "partly",
      scopes: { collected: 1, read: 2, unread: 0 },
    });
    expect(pick([sub("a", auto("e", ["Alerts"])), unreadSub("b")], "alerts").state).toEqual({
      kind: "partly",
      scopes: { collected: 1, read: 1, unread: 1 },
    });
  });

  it("is could-not-check, never not-collected, when nothing found and a subscription is unread", () => {
    const s = pick([sub("a"), unreadSub("b")], "alerts").state;
    expect(s.kind).toBe("could-not-check");
    expect(s.kind === "could-not-check" && s.reason).toContain("403 Forbidden");
  });

  it("is could-not-check when every subscription is unread or none is visible", () => {
    expect(pick([unreadSub("a"), unreadSub("b")], "alerts").state).toEqual({
      kind: "could-not-check",
      reason: "403 Forbidden",
    });
    expect(pick([], "alerts").state.kind).toBe("could-not-check");
  });
});

describe("archive classification and cards", () => {
  const NS = "/subscriptions/s/resourceGroups/r/providers/Microsoft.EventHub/namespaces/ns";
  const evidence: AppArchiveEvidence = { namespacePath: NS, lakeRoutedSources: ["entraId"] };
  const signIn = (props: Record<string, unknown>) =>
    cell(withArchive(entraCells(read(setting({ logs: [on("SignInLogs")], ...props }))), evidence), "SignInLogs");

  it("storage destination is archived via storage, even beside a workspace", () => {
    const c = signIn({ workspaceId: "/ws", storageAccountId: "/st" });
    expect(c.archive).toEqual({ kind: "archived", via: "storage" });
    expect(cellTone(c)).toBe("green");
  });

  it("event hub in the namespace with a Lake route is archived via cribl, case-insensitively", () => {
    const c = signIn({ eventHubAuthorizationRuleId: `${NS.toUpperCase()}/authorizationRules/x` });
    expect(c.archive).toEqual({ kind: "archived", via: "cribl" });
  });

  it("event hub in the namespace without a Lake route is unknown and amber", () => {
    const cells = withArchive(
      entraCells(read(setting({ logs: [on("SignInLogs")], eventHubAuthorizationRuleId: `${NS}/authorizationRules/x` }))),
      { namespacePath: NS, lakeRoutedSources: [] },
    );
    const c = cell(cells, "SignInLogs");
    expect(c.archive.kind).toBe("unknown");
    expect(cellTone(c)).toBe("amber");
  });

  it("event hub outside the namespace is unknown", () => {
    const other = "/subscriptions/s/resourceGroups/r/providers/Microsoft.EventHub/namespaces/other";
    const c = signIn({ eventHubAuthorizationRuleId: `${other}/authorizationRules/x` });
    expect(c.archive).toEqual({
      kind: "unknown",
      reason: "an Event Hub this app's Cribl sources do not read",
    });
  });

  it("a null namespace path never matches", () => {
    const cells = withArchive(
      entraCells(read(setting({ logs: [on("SignInLogs")], eventHubAuthorizationRuleId: `${NS}/authorizationRules/x` }))),
      { namespacePath: null, lakeRoutedSources: ["entraId"] },
    );
    expect(cell(cells, "SignInLogs").archive.kind).toBe("unknown");
  });

  it("workspace-only is not-archived and amber", () => {
    const c = signIn({ workspaceId: "/ws" });
    expect(c.archive).toEqual({ kind: "not-archived" });
    expect(cellTone(c)).toBe("amber");
  });

  it("not-collected stays unknown and red; could-not-check stays unknown and blue", () => {
    const nc = cell(withArchive(entraCells(read()), evidence), "SignInLogs");
    expect(nc.archive.kind).toBe("unknown");
    expect(cellTone(nc)).toBe("red");
    const bl = withArchive(entraCells({ kind: "unread", reason: "403" }), evidence)[0]!;
    expect(bl.archive.kind).toBe("unknown");
    expect(cellTone(bl)).toBe("blue");
  });

  it("a partly cell with storage is green", () => {
    const partly = {
      ...cell(entraCells(read(setting({ logs: [on("SignInLogs")], storageAccountId: "/st" }))), "SignInLogs"),
      state: { kind: "partly", scopes: { collected: 1, read: 2, unread: 0 } },
    } as LogTypeCell;
    expect(cellTone(withArchive([partly], evidence)[0]!)).toBe("green");
  });

  it("archiveEvidenceFrom needs a source record and a written route, and ignores other keys", () => {
    const base = emptyProgress();
    const src = { groupId: "g", inputId: "i", inputType: "eventhub", secretId: "k" } as const;
    const route = { groupId: "g", datasetId: "d", pipelineId: null, routeId: "rt" };
    const progress: OnboardingProgress = {
      ...base,
      planValues: { ...base.planValues, subscriptionId: "s", resourceGroup: "r", namespace: "ns" },
      criblSources: { entraId: src, activityLog: src, vnetFlowLogs: { ...src, inputType: "azure_blob" } },
      criblLakeRoutes: {
        entraId: route,
        activityLog: { ...route, routeId: null },
        vnetFlowLogs: route,
        [DEFENDER_EXPORT_ITEM_ID]: route,
      },
    };
    const ev = archiveEvidenceFrom(progress);
    expect(ev.namespacePath).toBe(NS);
    expect(ev.lakeRoutedSources).toEqual(["entraId"]);
  });

  it("archiveEvidenceFrom gives a null path when any plan value is empty", () => {
    const base = emptyProgress();
    const p = { ...base, planValues: { ...base.planValues, subscriptionId: "s", resourceGroup: "r", namespace: "" } };
    expect(archiveEvidenceFrom(p).namespacePath).toBeNull();
  });

  it("returns seven cards in order, four of them not built", () => {
    const cards = categoryCards(withArchive(entraCells(read()), evidence));
    expect(cards.map((c) => c.id)).toEqual([
      "activityLog",
      "entraId",
      DEFENDER_EXPORT_ITEM_ID,
      "xdrStreaming",
      "vnetFlowLogs",
      "nsgFlowLogs",
      "resourceLogs",
    ]);
    const unbuilt = cards.filter((c) => c.notChecked !== null);
    expect(unbuilt.map((c) => c.id).sort()).toEqual(
      ["nsgFlowLogs", "resourceLogs", "vnetFlowLogs", "xdrStreaming"].sort(),
    );
    for (const c of unbuilt) {
      expect(c.colour).toBe("blue");
      expect(c.notChecked).toBe(NOT_CHECKED_YET);
      expect(c.collectedShare).toBeNull();
    }
    expect(cards.find((c) => c.id === "resourceLogs")!.title).toBe("Resource logs");
    expect(cards.find((c) => c.id === "entraId")!.title).not.toBe("entraId");
  });

  it("rolls up counts, colour and shares", () => {
    const cells = withArchive(
      entraCells(
        read(
          setting({ logs: [on("SignInLogs"), on("AuditLogs")], storageAccountId: "/st" }, "a"),
          setting({ logs: [on("AuditLogs")], workspaceId: "/ws" }, "b"),
        ),
      ),
      evidence,
    );
    const card = categoryCards(cells).find((c) => c.id === "entraId")!;
    expect(card.counts).toEqual({ green: 2, amber: 0, red: 13, blue: 0 });
    expect(card.colour).toBe("mixed");
    expect(card.collectedShare).toBeCloseTo(2 / 15);
    expect(card.archivedShare).toBeCloseTo(2 / 15);
  });

  it("shares are null and colour blue when every cell is blue", () => {
    const card = categoryCards(withArchive(entraCells({ kind: "unread", reason: "403" }), evidence)).find(
      (c) => c.id === "entraId",
    )!;
    expect(card.colour).toBe("blue");
    expect(card.counts.blue).toBe(15);
    expect(card.collectedShare).toBeNull();
    expect(card.archivedShare).toBeNull();
    expect(card.notChecked).toBeNull();
  });

  it("a single-tone category takes that colour", () => {
    const card = categoryCards(withArchive(entraCells(read()), evidence)).find((c) => c.id === "entraId")!;
    expect(card.colour).toBe("red");
    expect(card.collectedShare).toBe(0);
  });
});
