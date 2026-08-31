/**
 * Pins for the Tables tab's pure layer (TBL-3).
 *
 * The load-bearing one is the three-way DCR verdict. `listDcrInventory` reads
 * ONE resource group, so "nothing matched" and "we did not look" are different
 * facts, and a two-state boolean would report the second as the first - the
 * confident wrong answer the inventory standard exists to refuse.
 */

import { describe, expect, it } from "vitest";
import { emptyCapabilitySet, listingRows, toListing } from "@soc/core";
import type {
  Capability,
  CapabilitySet,
  CapabilityVerdict,
  DcrInventoryEntry,
  Listing,
  WorkspaceTable,
} from "@soc/core";
import { emptyTableListMessage } from "../table-picker/table-picker-state";
import {
  buildWorkspaceTableListing,
  buildWorkspaceTableRows,
  dcrCellLabel,
  checkTableName,
  dcrColumnNote,
  filterWorkspaceTables,
  TABLE_FILTER_PLACEHOLDER,
} from "./workspace-tables-state";
import type { WorkspaceTableRow } from "./workspace-tables-state";

const table = (
  name: string,
  kind: "custom" | "native",
  retentionInDays: number | null = 30,
  plan = "Analytics",
): WorkspaceTable => ({ name, kind, retentionInDays, plan });

/** An AUDITED set - the only kind whose verdicts are measurements. */
const audited = (
  verdicts: Partial<Record<Capability, CapabilityVerdict>>,
): CapabilitySet => ({
  verdicts,
  auditedAt: "2026-08-31T00:00:00.000Z",
  connectionId: "conn-1",
});

const connected = { azureIdentityPresent: true, criblReachable: true };

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

describe("checkTableName (TBL-2)", () => {
  const listed = [table("App_CL", "custom"), table("SecurityEvent", "native")];

  it("BLOCKS a name the workspace already has", () => {
    // The tables PUT is an upsert: creating over this name replaces a live
    // table's schema, and the first symptom is someone else's data missing.
    const check = checkTableName("App_CL", listed);
    expect(check.verdict).toBe("taken");
    expect(check.blocking).toBe(true);
    expect(check.message).toContain("replace its schema");
  });

  it("matches case-insensitively, as Log Analytics does", () => {
    expect(checkTableName("app_cl", listed).verdict).toBe("taken");
  });

  it("names the EXISTING casing, not what was typed", () => {
    // So the operator can find the table they collided with.
    expect(checkTableName("app_cl", listed).message).toContain("App_CL");
  });

  it("says free for an unused name, with nothing to report", () => {
    const check = checkTableName("Brand_New_CL", listed);
    expect(check.verdict).toBe("free");
    expect(check.message).toBeNull();
    expect(check.blocking).toBe(false);
  });

  it("does NOT claim free when the listing was never read", () => {
    // The defect this guards: an unread listing is not a measured zero.
    const check = checkTableName("Anything_CL", null);
    expect(check.verdict).toBe("unchecked");
    expect(check.message).toContain("Load the table list");
  });

  it("leaves an unchecked name NON-blocking - it annotates, never forbids", () => {
    // Capability rule 3 in miniature, and createCustomTable still GETs before
    // it writes, so attempting is safe.
    expect(checkTableName("Anything_CL", null).blocking).toBe(false);
  });

  it("says nothing at all about an empty name", () => {
    expect(checkTableName("   ", listed).message).toBeNull();
  });
});

describe("dcrColumnNote", () => {
  it("states the scope limit once, naming the group", () => {
    const note = dcrColumnNote("rg-1");
    expect(note).toContain("rg-1");
    expect(note).toContain("not visible here");
  });
});

/**
 * TBL-8. The filter, and the two honesty rules it was written under.
 *
 * The filter itself is ordinary - substring, case-insensitive, over the Name
 * column - and half these pins are about the ordinary part because it is the
 * half an operator uses. The other half is about the two ways a filter can
 * lie: minting a total from a listing that was never verified, and describing
 * its own empty result in the workspace's words.
 */
const listingOf = (
  rows: WorkspaceTable[],
  dcrEntries: readonly DcrInventoryEntry[] | null = [],
): Listing<WorkspaceTableRow> =>
  buildWorkspaceTableListing(toListing(rows), dcrEntries);

const named = (...names: string[]): WorkspaceTable[] =>
  names.map((n) => table(n, n.endsWith("_CL") ? "custom" : "native"));

describe("buildWorkspaceTableListing (TBL-8)", () => {
  it("carries an UNVERIFIED empty straight through the row build", () => {
    // The defect this exists to make unreachable: flatten here and the count
    // downstream is a 0 nobody measured. The row build is 1:1, so it has no
    // business turning an unknown into anything.
    const built = buildWorkspaceTableListing({ kind: "empty" }, []);
    expect(built.kind).toBe("empty");
  });

  it("keeps the rows branch a rows branch, joined as before", () => {
    const built = listingOf(named("SecurityEvent"), [
      dcr("dcr-SecurityEvent-eastus", ["SecurityEvent"]),
    ]);
    expect(built.kind).toBe("rows");
    expect(listingRows(built)[0]?.dcr).toBe("has");
  });
});

describe("filterWorkspaceTables (TBL-8)", () => {
  const three = () => listingOf(named("SecurityEvent", "Syslog", "App_CL"));

  it("matches case-insensitively, like the Logs screen's Text filter", () => {
    const view = filterWorkspaceTables(three(), "SYSLOG");
    expect(view.rows.map((r) => r.name)).toEqual(["Syslog"]);
  });

  it("matches a SUBSTRING, not a prefix", () => {
    // "does this table already have a DCR" is usually asked with a fragment
    // from the middle of a name - a prefix match would answer the wrong
    // question silently.
    const view = filterWorkspaceTables(three(), "slo");
    expect(view.rows.map((r) => r.name)).toEqual(["Syslog"]);
  });

  it("matches the NAME column only", () => {
    // "native" is the kind of two of these rows and the plan is "Analytics" on
    // all three; a filter that reached other columns would return rows whose
    // names do not contain what was typed, which is unexplainable on screen.
    expect(filterWorkspaceTables(three(), "native").rows).toHaveLength(0);
    expect(filterWorkspaceTables(three(), "Analytics").rows).toHaveLength(0);
  });

  it("LEAVES THE DCR COLUMN UNTOUCHED", () => {
    // The join happened before the filter, so a filtered row must carry the
    // same verdict and the same names it had unfiltered. A filter that reached
    // the DCR listing too would turn "has" into "none-in-scope" and invite a
    // second DCR for a table that already has one.
    //
    // THE DCR NAME DELIBERATELY DOES NOT CONTAIN THE NEEDLE. Real DCR names
    // usually embed the table name ("dcr-SecurityEvent-eastus"), so a needle
    // taken from the table matches the DCR name too and a filter applied to
    // both columns would look identical to one applied to neither - the pin
    // would pass while protecting nothing. "slo" is in "Syslog" and not in
    // "dcr-alpha".
    const listing = listingOf(named("Syslog", "App_CL"), [
      dcr("dcr-alpha", ["Syslog"]),
    ]);
    const before = listingRows(listing).find((r) => r.name === "Syslog");
    const after = filterWorkspaceTables(listing, "slo").rows[0];
    expect(after?.dcr).toBe("has");
    expect(after?.dcrNames).toEqual(["dcr-alpha"]);
    expect(after).toEqual(before);
  });

  it("shows everything for an empty or whitespace filter", () => {
    expect(filterWorkspaceTables(three(), "").rows).toHaveLength(3);
    expect(filterWorkspaceTables(three(), "   ").rows).toHaveLength(3);
  });

  it("preserves the listing order among the matches", () => {
    const view = filterWorkspaceTables(
      listingOf(named("B_CL", "A_CL", "Zed_CL")),
      "_cl",
    );
    expect(view.rows.map((r) => r.name)).toEqual(["B_CL", "A_CL", "Zed_CL"]);
  });

  it("counts SHOWN of TOTAL, both off the verified rows branch", () => {
    expect(filterWorkspaceTables(three(), "s").countLabel).toBe(
      "showing 2 of 3 tables",
    );
    expect(filterWorkspaceTables(three(), "").countLabel).toBe("3 tables");
  });

  it("MINTS NO COUNT AND NO CLAIM from an unverified empty listing", () => {
    // The rule from docs/inventory-standard.md at the one place a number would
    // otherwise appear. An RBAC-filtered ARM list is byte-identical to an empty
    // workspace, so "0 tables" here would be a zero nobody measured - and "no
    // table matches your filter" would be a claim about rows we never saw.
    const view = filterWorkspaceTables({ kind: "empty" }, "anything");
    expect(view.countLabel).toBeNull();
    expect(view.noMatchMessage).toBeNull();
    expect(view.rows).toHaveLength(0);
  });

  it("says NOTHING MATCHES THE FILTER, and quotes what was typed", () => {
    const view = filterWorkspaceTables(three(), "zzz");
    expect(view.rows).toHaveLength(0);
    expect(view.noMatchMessage).toContain("No table matches");
    expect(view.noMatchMessage).toContain("zzz");
    expect(view.noMatchMessage).toContain("filter");
    // The measured total is still on offer, so the operator can see the rows
    // are there rather than gone.
    expect(view.noMatchMessage).toContain("3 tables");
  });

  it("does NOT borrow the empty-listing wording for a no-match", () => {
    // THE POINT OF THE CARD. `emptyTableListMessage` answers "is this workspace
    // empty, or can we not read it?" - a question about the WORKSPACE. Reusing
    // any of its three answers here would tell an operator their workspace
    // might be empty, or their identity unauthorised, because they typed three
    // letters. Compared against the live wordings rather than string literals
    // so the pin cannot drift apart from the thing it is protecting.
    const workspaceWordings = [
      emptyTableListMessage(audited({ "table.read": "granted" }), connected).text,
      emptyTableListMessage(audited({ "table.read": "denied" }), connected).text,
      emptyTableListMessage(emptyCapabilitySet(), connected).text,
    ];
    const message = filterWorkspaceTables(three(), "zzz").noMatchMessage ?? "";
    expect(message).not.toBe("");
    for (const wording of workspaceWordings) {
      expect(message, `borrowed the workspace wording: ${wording}`).not.toContain(
        wording,
      );
    }
    // And nothing that reads as a permission problem, which is the harmful
    // half of that wording however it is phrased.
    expect(message).not.toMatch(/permission|identity|Cannot list/i);
  });

  it("grammar: one table is not '1 tables'", () => {
    const one = listingOf(named("Syslog"));
    expect(filterWorkspaceTables(one, "").countLabel).toBe("1 table");
    expect(filterWorkspaceTables(one, "zzz").noMatchMessage).toContain(
      "1 table ",
    );
  });
});

describe("TABLE_FILTER_PLACEHOLDER", () => {
  it("is the Logs screen's wording, verbatim", () => {
    // Two substring filters that describe themselves differently teach an
    // operator that they behave differently. Pinned as a literal because the
    // Logs screen writes its own copy inline.
    expect(TABLE_FILTER_PLACEHOLDER).toBe("substring, case-insensitive");
  });
});
