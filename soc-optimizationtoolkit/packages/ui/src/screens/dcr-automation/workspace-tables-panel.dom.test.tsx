// @vitest-environment happy-dom
/**
 * Surface pins for the Tables tab (TBL-3).
 *
 * Two of these guard rules that used to hold BY CONSTRUCTION and no longer do.
 * The deleted TablePickerSection auto-loaded and had no button, so "a denied
 * capability never removes the attempt" and "no request storm" were both free.
 * This panel has a button, so both are now claims about code - which is
 * exactly when they need pins.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AzureConfig,
  Capability,
  CapabilitySet,
  CapabilityVerdict,
  PortHttpResponse,
} from "@soc/core";
import { emptyCapabilitySet } from "@soc/core";
import { emptyTableListMessage } from "../table-picker/table-picker-state";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { FALLBACK_POINTER_LABEL } from "../../capabilities/fallback-notice-state";
import { WorkspaceTablesPanel } from "./workspace-tables-panel";

afterEach(cleanup);

const SUB = "sub-1";
const RG = "rg-1";
const WS = "law-1";

const CONFIG = {
  tenantId: "t",
  clientId: "c",
  subscriptionId: SUB,
  resourceGroup: RG,
  workspaceName: WS,
  location: "eastus",
} as unknown as AzureConfig;

const ok = (body: unknown): PortHttpResponse =>
  ({ ok: true, status: 200, body }) as unknown as PortHttpResponse;

const TABLES = {
  value: [
    {
      name: "SecurityEvent",
      properties: { retentionInDays: 30, plan: "Analytics" },
    },
    { name: "App_CL", properties: { plan: "Analytics" } },
  ],
};

const DCRS = {
  value: [
    {
      name: "dcr-SecurityEvent-eastus",
      location: "eastus",
      properties: {
        dataFlows: [{ outputStream: "Microsoft-SecurityEvent" }],
        streamDeclarations: {},
      },
    },
  ],
};

/** Records every path requested so a pin can assert the attempt was MADE. */
function makePorts(
  opts: {
    dcrFails?: boolean;
    tablesFail?: boolean;
    /** `200 []` - byte-identical to an RBAC-filtered list, hence unverified. */
    tablesEmpty?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const ports = {
    azure: {
      async request(o: { path: string }): Promise<PortHttpResponse> {
        calls.push(o.path);
        if (o.path.includes("/dataCollectionRules")) {
          if (opts.dcrFails === true) {
            return { ok: false, status: 403, body: {} } as unknown as PortHttpResponse;
          }
          return ok(DCRS);
        }
        if (o.path.endsWith("/tables")) {
          if (opts.tablesEmpty === true) {
            return ok({ value: [] });
          }
          if (opts.tablesFail === true) {
            return {
              ok: false,
              status: 403,
              body: { error: { message: "denied by RBAC" } },
            } as unknown as PortHttpResponse;
          }
          return ok(TABLES);
        }
        return ok({ value: [] });
      },
    },
  } as unknown as UiPorts;
  return { ports, calls };
}

/** An AUDITED set - the only kind that can produce a `denied` verdict. */
function measured(
  verdicts: Partial<Record<Capability, CapabilityVerdict>>,
): CapabilitySet {
  return {
    verdicts,
    auditedAt: "2026-08-31T00:00:00.000Z",
    connectionId: "conn-1",
  };
}

const CONNECTED = { azureIdentityPresent: true, criblReachable: true };

function renderPanel(
  ports: UiPorts,
  props: Record<string, unknown> = {},
) {
  return render(
    <PortsProvider ports={ports} config={CONFIG}>
      <WorkspaceTablesPanel {...props} />
    </PortsProvider>,
  );
}

describe("WorkspaceTablesPanel", () => {
  it("does NOT list until the button is pressed", async () => {
    // The deleted panel auto-loaded; one 403 against an ~842-row listing on
    // every mount is the request storm that lesson was about.
    const { ports, calls } = makePorts();
    renderPanel(ports);
    await Promise.resolve();
    expect(calls).toEqual([]);
    expect(screen.getByRole("button", { name: "Load tables" })).toBeTruthy();
  });

  it("lists tables and marks which one a DCR targets", async () => {
    const { ports } = makePorts();
    renderPanel(ports);
    fireEvent.click(screen.getByRole("button", { name: "Load tables" }));
    await waitFor(() => {
      expect(screen.getByText("SecurityEvent")).toBeTruthy();
    });
    expect(screen.getByText("dcr-SecurityEvent-eastus")).toBeTruthy();
    // The unmatched row names the SCOPE rather than claiming a flat no.
    expect(screen.getByText(`none in ${RG}`)).toBeTruthy();
  });

  it("keeps Load ENABLED when the capability audit says table.read is denied", async () => {
    // Capability rule 1: a denied verdict annotates, it never removes the
    // attempt. This held by construction until this panel grew a button.
    //
    // TBL-4 strengthened this: it passed emptyCapabilitySet(), which resolves
    // to `unknown`, so it asserted nothing about a DENIAL despite its name. A
    // measured denial is the case the rule is about.
    const { ports, calls } = makePorts();
    renderPanel(ports, {
      capabilities: measured({ "table.read": "denied" }),
      capabilityContext: CONNECTED,
    });
    const button = screen.getByRole("button", { name: "Load tables" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    // And the attempt actually reaches the port - Azure's own answer is the gate.
    await waitFor(() => {
      expect(calls.some((p) => p.endsWith("/tables"))).toBe(true);
    });
  });

  it("renders the real failure rather than an empty listing", async () => {
    // Swallowing a 403 would leave an empty table that reads as an empty
    // workspace - the exact confusion listWorkspaceTables refuses to create.
    const { ports } = makePorts({ tablesFail: true });
    renderPanel(ports);
    fireEvent.click(screen.getByRole("button", { name: "Load tables" }));
    await waitFor(() => {
      expect(screen.getByText(/denied by RBAC|403/)).toBeTruthy();
    });
  });

  it("degrades the DCR column, not the page, when the DCR listing fails", async () => {
    const { ports } = makePorts({ dcrFails: true });
    renderPanel(ports);
    fireEvent.click(screen.getByRole("button", { name: "Load tables" }));
    await waitFor(() => {
      expect(screen.getByText("SecurityEvent")).toBeTruthy();
    });
    // "not checked" everywhere - never "none in rg-1", which would be a
    // measured zero we did not measure.
    expect(screen.getAllByText("not checked")).toHaveLength(2);
    expect(screen.queryByText(`none in ${RG}`)).toBeNull();
  });

  it("offers Create table with no host wiring - the panel owns that flow", () => {
    // Create table needs only Azure, so the panel creates the table itself
    // rather than handing off. Create DCR still needs a host, because it
    // navigates to another tab.
    const { ports } = makePorts();
    renderPanel(ports);
    expect(screen.getByRole("button", { name: "Create table" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create DCR" })).toBeNull();
  });

  it("keeps the create form CLOSED until asked", () => {
    const { ports } = makePorts();
    const { container } = renderPanel(ports);
    expect(container.querySelector(".create-table-form")).toBeNull();
  });

  it("REFUSES a name the loaded listing already holds", async () => {
    // TBL-2. The tables PUT is an upsert, so creating over a live table
    // replaces its schema - and the panel already knows the names, so this
    // costs no extra request.
    const { ports } = makePorts();
    renderPanel(ports);
    fireEvent.click(screen.getByRole("button", { name: "Load tables" }));
    await waitFor(() => {
      expect(screen.getByText("App_CL")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Create table" }));
    fireEvent.change(screen.getByLabelText("Table name"), {
      target: { value: "app_cl" },
    });
    expect(screen.getByText(/already exists in this workspace/)).toBeTruthy();
    // And the action is actually blocked, not merely annotated.
    const create = screen
      .getAllByRole("button", { name: "Create table" })
      .find((b) => (b as HTMLButtonElement).disabled);
    expect(create, "the Create action should be disabled").toBeTruthy();
  });

  it("does not claim a name is free before the listing is read", async () => {
    // An unread listing cannot say "free" - it annotates and lets the
    // operator proceed, because createCustomTable GETs before it writes.
    const { ports } = makePorts();
    renderPanel(ports);
    fireEvent.click(screen.getByRole("button", { name: "Create table" }));
    fireEvent.change(screen.getByLabelText("Table name"), {
      target: { value: "Brand_New_CL" },
    });
    expect(screen.getByText(/Load the table list/)).toBeTruthy();
  });

  it("offers Create DCR per row, and passes THAT row's table", async () => {
    // Located by row content, not by index: listWorkspaceTables sorts its
    // results, so an index-based click silently tests a different row.
    const onCreateDcr = vi.fn();
    const { ports } = makePorts();
    const { container } = renderPanel(ports, { onCreateDcr });
    fireEvent.click(screen.getByRole("button", { name: "Load tables" }));
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Create DCR" })).toHaveLength(2);
    });
    const row = Array.from(container.querySelectorAll("tbody tr")).find((tr) =>
      (tr.textContent ?? "").includes("App_CL"),
    );
    expect(row, "no row rendered for App_CL").toBeTruthy();
    fireEvent.click(row!.querySelector("button")!);
    expect(onCreateDcr).toHaveBeenCalledWith("App_CL");
  });

  it("has NO filter box until there are rows to filter", async () => {
    // This pin used to read "has NO filter box - filterTables was deleted with
    // the old panel", and it was protecting the CONDITION that deletion set:
    // a filter is defensible once rows are actionable, but must be written
    // fresh rather than resurrected. TBL-8 met the condition (843 rows, and a
    // Create DCR button on each), so the assertion moves to the half still
    // worth protecting - a control that filters nothing is a control that
    // implies rows were read.
    const { ports } = makePorts();
    const { container } = renderPanel(ports);
    expect(container.querySelectorAll("input")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Load tables" }));
    await waitFor(() => {
      expect(screen.getByText("SecurityEvent")).toBeTruthy();
    });
    expect(screen.getByLabelText("Name filter")).toBeTruthy();
  });
});

/**
 * TBL-8: the filter, on the surface.
 *
 * The pure pins in workspace-tables-state.test.ts own the matching rules and
 * the wording. These own the wiring, which is the half that rots silently -
 * HON-7's lesson was a component whose own pins all passed while its only call
 * site wired nothing.
 */
describe("WorkspaceTablesPanel - the Name filter (TBL-8)", () => {
  const loadRows = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Load tables" }));
    await waitFor(() => {
      expect(screen.getByText("SecurityEvent")).toBeTruthy();
    });
  };

  const typeFilter = (value: string) => {
    fireEvent.change(screen.getByLabelText("Name filter"), {
      target: { value },
    });
  };

  it("narrows the rendered rows, case-insensitively, on a substring", async () => {
    const { ports } = makePorts();
    const { container } = renderPanel(ports);
    await loadRows();
    typeFilter("app_c");
    const names = Array.from(container.querySelectorAll("tbody tr")).map(
      (tr) => tr.querySelector("td")?.textContent,
    );
    expect(names).toEqual(["App_CL"]);
    expect(screen.queryByText("SecurityEvent")).toBeNull();
  });

  it("ISSUES NOTHING - it filters rows already loaded", async () => {
    // The card's constraint, and the reason it can be typed into freely: no
    // new request, no re-list, no change to loading behaviour.
    const { ports, calls } = makePorts();
    renderPanel(ports);
    await loadRows();
    const before = calls.length;
    typeFilter("app");
    typeFilter("app_cl");
    typeFilter("");
    expect(calls.length).toBe(before);
  });

  it("leaves the DCR column reading exactly what it read unfiltered", async () => {
    const { ports } = makePorts();
    renderPanel(ports);
    await loadRows();
    expect(screen.getByText("dcr-SecurityEvent-eastus")).toBeTruthy();
    typeFilter("securityevent");
    // Same cell, same DCR - the filter narrows which rows are shown and
    // touches neither the join nor its verdict.
    expect(screen.getByText("dcr-SecurityEvent-eastus")).toBeTruthy();
  });

  it("counts shown of total beside the box", async () => {
    const { ports } = makePorts();
    renderPanel(ports);
    await loadRows();
    expect(screen.getByText("2 tables")).toBeTruthy();
    typeFilter("app");
    expect(screen.getByText("showing 1 of 2 tables")).toBeTruthy();
  });

  it("says the FILTER matched nothing, never that the workspace is empty", async () => {
    // The two sentences answer different questions and the panel must not
    // swap them: `emptyTableListMessage` is a claim about the workspace (or
    // about what we may read), and this is a claim about four letters someone
    // typed. Asserted against the live wording, not a copy of it.
    const { ports } = makePorts();
    const { container } = renderPanel(ports);
    await loadRows();
    typeFilter("zzz");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(0);
    expect(screen.getByText(/No table matches "zzz"/)).toBeTruthy();
    const rendered = container.textContent ?? "";
    for (const wording of [
      emptyTableListMessage(measured({ "table.read": "granted" }), CONNECTED).text,
      emptyTableListMessage(measured({ "table.read": "denied" }), CONNECTED).text,
      emptyTableListMessage(emptyCapabilitySet(), CONNECTED).text,
    ]) {
      expect(
        rendered,
        `the no-match state borrowed the workspace wording: ${wording}`,
      ).not.toContain(wording);
    }
  });

  it("hides the table entirely rather than leaving bare headings", async () => {
    const { ports } = makePorts();
    const { container } = renderPanel(ports);
    await loadRows();
    typeFilter("zzz");
    expect(container.querySelector("table")).toBeNull();
  });

  it("brings every row back when the filter is cleared", async () => {
    const { ports } = makePorts();
    const { container } = renderPanel(ports);
    await loadRows();
    typeFilter("zzz");
    typeFilter("");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
  });

  it("offers NO filter and NO count for an unverified empty listing", async () => {
    // `200 []` from ARM is indistinguishable from a list RBAC filtered away, so
    // there is nothing here to filter and no total to print. The empty-listing
    // message owns this space alone - a "0 tables" beside a filter box would be
    // a count nobody measured, dressed as a fact.
    const { ports } = makePorts({ tablesEmpty: true });
    const { container } = renderPanel(ports, {
      capabilities: emptyCapabilitySet(),
      capabilityContext: CONNECTED,
    });
    fireEvent.click(screen.getByRole("button", { name: "Load tables" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
    });
    expect(screen.queryByLabelText("Name filter")).toBeNull();
    expect(container.textContent ?? "").not.toContain("0 table");
    expect(
      screen.getByText(
        emptyTableListMessage(emptyCapabilitySet(), CONNECTED).text,
      ),
    ).toBeTruthy();
  });

  it("does not call a name FREE off an unverified empty listing", async () => {
    // Same read, the other consumer. `checkTableName` documents that an unread
    // listing cannot say a name is free, and an unverified empty listing is
    // one - the panel used to unwrap it to `[]` first, which silently made
    // every name look available over an upsert that replaces a live schema.
    const { ports } = makePorts({ tablesEmpty: true });
    renderPanel(ports);
    fireEvent.click(screen.getByRole("button", { name: "Load tables" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Create table" }));
    fireEvent.change(screen.getByLabelText("Table name"), {
      target: { value: "Brand_New_CL" },
    });
    expect(screen.getByText(/Load the table list/)).toBeTruthy();
  });
});

/**
 * TBL-4: the two write actions this panel added must carry the fallback offer,
 * gated on the MEASURED capability so it appears beside the button rather than
 * after a 403.
 *
 * The defect these are written against is HON-7's: `FallbackNotice` had pins of
 * its own and every one of them passed while the only production caller wired
 * no producer, so rule 2 had no button anywhere. Pinning the component again
 * would not have caught that - only mounting a CALL SITE does. So each pin
 * below asserts the control exists AND is enabled, not merely that the artifact
 * is named.
 */
describe("WorkspaceTablesPanel - a blocked write still gets an artifact (TBL-4)", () => {
  const loadRows = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Load tables" }));
    await waitFor(() => {
      expect(screen.getByText("SecurityEvent")).toBeTruthy();
    });
  };

  it("offers the DCR ARM bodies with a CONTROL once dcr.write is measured denied", async () => {
    const { ports } = makePorts();
    renderPanel(ports, {
      onCreateDcr: vi.fn(),
      capabilities: measured({ "dcr.write": "denied" }),
      capabilityContext: CONNECTED,
    });
    await loadRows();
    expect(screen.getByText("DCR ARM request bodies")).toBeTruthy();
    const offer = screen.getByRole("button", {
      name: FALLBACK_POINTER_LABEL,
    }) as HTMLButtonElement;
    // The half the shipped defect failed: a named artifact with no usable
    // control is not an offer.
    expect(offer.disabled).toBe(false);
  });

  it("leaves every Create DCR button exactly as available", async () => {
    // Rule 3, and the card says it outright: the offer sits BESIDE the live
    // control, it does not replace or disable it.
    const onCreateDcr = vi.fn();
    const { ports } = makePorts();
    const { container } = renderPanel(ports, {
      onCreateDcr,
      capabilities: measured({ "dcr.write": "denied" }),
      capabilityContext: CONNECTED,
    });
    await loadRows();
    const creates = screen.getAllByRole("button", { name: "Create DCR" });
    expect(creates).toHaveLength(2);
    expect(
      creates.every((b) => !(b as HTMLButtonElement).disabled),
      "a denied verdict must not disable Create DCR",
    ).toBe(true);
    // And the click still does its job rather than being intercepted.
    const row = Array.from(container.querySelectorAll("tbody tr")).find((tr) =>
      (tr.textContent ?? "").includes("App_CL"),
    );
    fireEvent.click(row!.querySelector("button")!);
    expect(onCreateDcr).toHaveBeenCalledWith("App_CL");
  });

  it("offers NOTHING when dcr.write was never measured", async () => {
    // `unknown` must not collapse into `denied`. An unaudited connection is
    // the normal state, and an offer there would imply a block nobody
    // established.
    const { ports } = makePorts();
    renderPanel(ports, {
      onCreateDcr: vi.fn(),
      capabilities: emptyCapabilitySet(),
      capabilityContext: CONNECTED,
    });
    await loadRows();
    expect(screen.queryByText("DCR ARM request bodies")).toBeNull();
    expect(
      screen.queryByRole("button", { name: FALLBACK_POINTER_LABEL }),
    ).toBeNull();
  });

  it("POINTS at the run that makes the bodies instead of building one here", async () => {
    // D-2: "dcr-arm-bodies" is a RUN kind, so the honest control says where it
    // comes from. A button labelled "Download the ARM request bodies" that
    // answered with a sentence would be the dishonesty the notice exists
    // against.
    const { ports, calls } = makePorts();
    renderPanel(ports, {
      onCreateDcr: vi.fn(),
      capabilities: measured({ "dcr.write": "denied" }),
      capabilityContext: CONNECTED,
    });
    await loadRows();
    expect(
      screen.queryByRole("button", { name: "Download the ARM request bodies" }),
    ).toBeNull();
    const before = calls.length;
    fireEvent.click(
      screen.getByRole("button", { name: FALLBACK_POINTER_LABEL }),
    );
    expect(screen.getByText(/Batch tab produces these/)).toBeTruthy();
    // The half that would otherwise rot silently: this panel owns no run, so
    // taking the offer must not fire a request of any kind.
    expect(calls.length).toBe(before);
  });

  it("offers the custom-table PUT bodies inside the create flow, not on the listing", async () => {
    // The offer annotates the control it belongs to. On the closed listing
    // there is no create action, so there is nothing to annotate.
    const { ports } = makePorts();
    renderPanel(ports, {
      capabilities: measured({ "table.write": "denied" }),
      capabilityContext: CONNECTED,
    });
    expect(screen.queryByText("Custom-table ARM PUT bodies")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create table" }));
    expect(screen.getByText("Custom-table ARM PUT bodies")).toBeTruthy();
    const offer = screen.getByRole("button", {
      name: FALLBACK_POINTER_LABEL,
    }) as HTMLButtonElement;
    expect(offer.disabled).toBe(false);
  });

  it("names the run's schema prerequisite rather than pointing at a failure", async () => {
    // collectTableTemplates collects a table PUT only for a custom table that
    // does NOT exist and DOES carry a supplied schema, and the Batch tab's only
    // schema source is its bundled vendor list. A pointer that omitted this
    // would send the operator to "does not exist and no customSchema was
    // provided" - which is the whole class of defect this card is about.
    const { ports } = makePorts();
    renderPanel(ports, {
      capabilities: measured({ "table.write": "denied" }),
      capabilityContext: CONNECTED,
    });
    fireEvent.click(screen.getByRole("button", { name: "Create table" }));
    fireEvent.click(
      screen.getByRole("button", { name: FALLBACK_POINTER_LABEL }),
    );
    expect(screen.getByText(/bundled vendor list/)).toBeTruthy();
    expect(screen.getByText(/does not carry the fields typed here/)).toBeTruthy();
  });

  it("leaves Create table enabled for a valid draft while table.write is denied", async () => {
    // The submit button is disabled by the DRAFT alone - a name, a suffix, a
    // field - never by the verdict.
    const { ports } = makePorts();
    const { container } = renderPanel(ports, {
      capabilities: measured({ "table.write": "denied" }),
      capabilityContext: CONNECTED,
    });
    fireEvent.click(screen.getByRole("button", { name: "Create table" }));
    fireEvent.change(screen.getByLabelText("Table name"), {
      target: { value: "Brand_New_CL" },
    });
    fireEvent.change(screen.getByLabelText("Field 1 name"), {
      target: { value: "ClientIP" },
    });
    // Located INSIDE the form: "Create table" also names the toggle above it,
    // and an index-based pick would silently assert about the wrong button.
    const form = container.querySelector(".create-table-form");
    expect(form, "the create form should be open").toBeTruthy();
    const submit = Array.from(form!.querySelectorAll("button")).find(
      (b) => b.textContent === "Create table",
    );
    expect(submit, "no submit button in the create form").toBeTruthy();
    expect(submit!.disabled).toBe(false);
  });

  it("offers no DCR artifact where the panel presents no Create DCR action", async () => {
    // Without a host there is no Create DCR button (it navigates), so there is
    // no blocked action here to offer an artifact for.
    const { ports } = makePorts();
    renderPanel(ports, {
      capabilities: measured({ "dcr.write": "denied" }),
      capabilityContext: CONNECTED,
    });
    await loadRows();
    expect(screen.queryByRole("button", { name: "Create DCR" })).toBeNull();
    expect(screen.queryByText("DCR ARM request bodies")).toBeNull();
  });
});
