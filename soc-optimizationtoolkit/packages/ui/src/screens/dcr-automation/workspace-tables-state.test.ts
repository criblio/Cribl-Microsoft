/**
 * Pins for the Tables tab's pure layer (TBL-3).
 *
 * The load-bearing one is the three-way DCR verdict. `listDcrInventory` reads
 * ONE resource group, so "nothing matched" and "we did not look" are different
 * facts, and a two-state boolean would report the second as the first - the
 * confident wrong answer the inventory standard exists to refuse.
 */

import { describe, expect, it } from "vitest";
import type { DcrInventoryEntry, WorkspaceTable } from "@soc/core";
import {
  buildWorkspaceTableRows,
  dcrCellLabel,
  dcrColumnNote,
} from "./workspace-tables-state";

const table = (
  name: string,
  kind: "custom" | "native",
  retentionInDays: number | null = 30,
  plan = "Analytics",
): WorkspaceTable => ({ name, kind, retentionInDays, plan });

const dcr = (name: string, tables: string[]): DcrInventoryEntry =>
  ({
    name,
    tables,
    location: "eastus",
    kind: "Direct",
    immutableId: "",
    ingestionEndpoint: "",
    provisioningState: "Succeeded",
    dataCollectionEndpointId: "",
    streamDeclarationCount: 1,
  }) as DcrInventoryEntry;

describe("buildWorkspaceTableRows", () => {
  it("marks a table a DCR targets, and names the DCR", () => {
    const [row] = buildWorkspaceTableRows(
      [table("SecurityEvent", "native")],
      [dcr("dcr-SecurityEvent-eastus", ["SecurityEvent"])],
    );
    expect(row?.dcr).toBe("has");
    expect(row?.dcrNames).toEqual(["dcr-SecurityEvent-eastus"]);
  });

  it("matches case-insensitively, as Log Analytics does", () => {
    // DcrInventoryEntry.tables is derived by stripping a stream prefix, not
    // read off the table resource, so the casing is not guaranteed to agree.
    const [row] = buildWorkspaceTableRows(
      [table("App_CL", "custom")],
      [dcr("dcr-app", ["app_cl"])],
    );
    expect(row?.dcr).toBe("has");
  });

  it("distinguishes NOT LOOKED from NOTHING FOUND", () => {
    // The defect this pin exists for. A boolean would render both as "no".
    const notLooked = buildWorkspaceTableRows([table("SecurityEvent", "native")], null);
    const lookedAndEmpty = buildWorkspaceTableRows(
      [table("SecurityEvent", "native")],
      [],
    );
    expect(notLooked[0]?.dcr).toBe("unchecked");
    expect(lookedAndEmpty[0]?.dcr).toBe("none-in-scope");
    expect(notLooked[0]?.dcr).not.toBe(lookedAndEmpty[0]?.dcr);
  });

  it("collects several DCRs onto one table without repeating a name", () => {
    const [row] = buildWorkspaceTableRows(
      [table("Syslog", "native")],
      [
        dcr("dcr-a", ["Syslog"]),
        dcr("dcr-b", ["Syslog", "SecurityEvent"]),
        dcr("dcr-a", ["Syslog"]),
      ],
    );
    expect(row?.dcrNames).toEqual(["dcr-a", "dcr-b"]);
  });

  it("renders a null retention as the workspace default, never 'null' or 0", () => {
    const [row] = buildWorkspaceTableRows([table("App_CL", "custom", null)], []);
    expect(row?.retentionLabel).toBe("workspace default");
  });

  it("renders a missing plan as a dash", () => {
    const [row] = buildWorkspaceTableRows([table("App_CL", "custom", 30, "")], []);
    expect(row?.planLabel).toBe("-");
  });

  it("preserves the listing order", () => {
    const rows = buildWorkspaceTableRows(
      [table("B_CL", "custom"), table("A_CL", "custom")],
      [],
    );
    expect(rows.map((r) => r.name)).toEqual(["B_CL", "A_CL"]);
  });
});

describe("dcrCellLabel", () => {
  it("NAMES THE RESOURCE GROUP instead of claiming a flat no", () => {
    // The column can only see one group; "no" would overstate what was read.
    const [row] = buildWorkspaceTableRows([table("SecurityEvent", "native")], []);
    const label = dcrCellLabel(row!, "rg-jpederson-QuickstartLab");
    expect(label).toContain("rg-jpederson-QuickstartLab");
    expect(label).not.toBe("no");
  });

  it("says 'not checked' when the DCR listing was never read", () => {
    const [row] = buildWorkspaceTableRows([table("SecurityEvent", "native")], null);
    expect(dcrCellLabel(row!, "rg-1")).toBe("not checked");
  });

  it("lists the DCR names when there are any", () => {
    const [row] = buildWorkspaceTableRows(
      [table("Syslog", "native")],
      [dcr("dcr-a", ["Syslog"]), dcr("dcr-b", ["Syslog"])],
    );
    expect(dcrCellLabel(row!, "rg-1")).toBe("dcr-a, dcr-b");
  });
});

describe("dcrColumnNote", () => {
  it("states the scope limit once, naming the group", () => {
    const note = dcrColumnNote("rg-1");
    expect(note).toContain("rg-1");
    expect(note).toContain("not visible here");
  });
});
