import { describe, expect, it } from "vitest";
import { readDiagnosticSetting } from "../activity-log-export/diagnostic-setting";
import { ENTRA_CATEGORIES } from "../entra-diagnostics/entra-categories";
import { toListing } from "../inventory-listing/inventory-listing";
import { destinationsOf, entraCells } from "./tenant-inventory";
import type { EntraRead } from "./tenant-inventory";

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
