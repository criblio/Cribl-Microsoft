import { describe, expect, it } from "vitest";
import { readDiagnosticSetting } from "../activity-log-export/diagnostic-setting";
import { ENTRA_CATEGORIES } from "../entra-diagnostics/entra-categories";
import { toListing } from "../inventory-listing/inventory-listing";
import { ACTIVITY_LOG_CATEGORIES } from "../activity-log-export/activity-log-setting";
import { activityLogCells, destinationsOf, entraCells } from "./tenant-inventory";
import type { EntraRead, SubscriptionSettingsRead } from "./tenant-inventory";

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
