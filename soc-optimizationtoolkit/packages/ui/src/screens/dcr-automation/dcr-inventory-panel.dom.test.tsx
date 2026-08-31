// @vitest-environment happy-dom
/**
 * HON-4 (ADR 0004): the guid-loss warning REACHES THE SCREEN.
 *
 * WHY A RENDER AND NOT ONLY THE CORE PINS. `guidColumnsLostByDeployedDcr` is
 * pinned in core against hand-built column lists. Those pins say the rule is
 * right; they cannot say the preview the panel actually holds has the shape the
 * rule needs. The three inputs come from two different ARM responses and one
 * generator call, and the whole warning is worth nothing if it is computed from
 * a preview that never carries them. So this drives the real panel through a
 * stubbed ARM and reads the banner off the DOM.
 *
 * WHY THE FIXTURE IS A NATIVE TABLE WITH BOTH KINDS OF GUID COLUMN. TenantId is
 * guid on essentially every native Sentinel table and is dropped from the
 * declaration BY DESIGN (RULE 2a, which runs before the guid cast). A check
 * that compares the table schema against the declaration without honouring that
 * drop fires on nearly every healthy native table. The fixture carries TenantId
 * alongside a genuinely lost CorrelationId so the banner has to tell them
 * apart, on the screen, not just in a unit.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AzureConfig, PortHttpResponse } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { DcrInventoryPanel } from "./dcr-inventory-panel";

afterEach(cleanup);

const SUB = "sub-1";
const RG = "rg-1";
const WS = "law-1";
const DCR = "dcr-syslog";

const CONFIG = {
  tenantId: "tenant",
  clientId: "client",
  subscriptionId: SUB,
  resourceGroup: RG,
  workspaceName: WS,
  location: "eastus",
} as unknown as AzureConfig;

const ok = (body: unknown): PortHttpResponse =>
  ({ ok: true, status: 200, body }) as unknown as PortHttpResponse;

const denied = (): PortHttpResponse =>
  ({ ok: false, status: 403, body: {} }) as unknown as PortHttpResponse;

/** The table's live Log Analytics schema - the RAW types, guid included. */
const TABLE_SCHEMA = {
  properties: {
    schema: {
      standardColumns: [
        { name: "TimeGenerated", type: "datetime" },
        // Guid, and a SYSTEM column: dropped by design, never "lost".
        { name: "TenantId", type: "guid" },
        // Guid, and an ordinary column: this one is genuinely being lost.
        { name: "CorrelationId", type: "guid" },
        { name: "SyslogMessage", type: "string" },
      ],
    },
  },
};

/** One DCR resource body with the stream declaration it was deployed with. */
const dcrBody = (columns: Array<{ name: string; type: string }>) => ({
  name: DCR,
  location: "eastus",
  kind: "Direct",
  properties: {
    immutableId: "dcr-immutable-1",
    provisioningState: "Succeeded",
    endpoints: { logsIngestion: "https://example.ingest.monitor.azure.com" },
    dataFlows: [{ outputStream: "Microsoft-Syslog", transformKql: "source" }],
    streamDeclarations: { "Custom-Syslog": { columns } },
  },
});

/** What a PRE-FIX generator deployed: every guid column simply absent. */
const LEGACY_DECLARATION = [
  { name: "TimeGenerated", type: "datetime" },
  { name: "SyslogMessage", type: "string" },
];

/** What the FIXED generator deploys: the guid column declared `string`. */
const FIXED_DECLARATION = [
  { name: "TimeGenerated", type: "datetime" },
  { name: "CorrelationId", type: "string" },
  { name: "SyslogMessage", type: "string" },
];

const DCR_COLLECTION =
  `/subscriptions/${SUB}/resourceGroups/${RG}` +
  `/providers/Microsoft.Insights/dataCollectionRules`;

function makePorts(declaration: Array<{ name: string; type: string }>): UiPorts {
  return {
    azure: {
      async request(opts: { path: string }): Promise<PortHttpResponse> {
        const { path } = opts;
        // The single DCR read must be tested BEFORE the collection read - the
        // collection path is a prefix of it.
        if (path === `${DCR_COLLECTION}/${DCR}`) {
          return ok(dcrBody(declaration));
        }
        if (path === DCR_COLLECTION) {
          return ok({ value: [dcrBody(declaration)] });
        }
        if (path.endsWith("/tables/Syslog")) return ok(TABLE_SCHEMA);
        if (path.endsWith("/resourcegroups")) return ok({ value: [{ name: RG }] });
        // The RBAC permissions read. Refusing it makes the check
        // INDETERMINATE, which leaves the preview open - the warning does not
        // depend on the permission verdict and must not be gated behind it.
        return denied();
      },
    },
  } as unknown as UiPorts;
}

async function openPreview(
  declaration: Array<{ name: string; type: string }>,
): Promise<void> {
  render(
    <PortsProvider ports={makePorts(declaration)} config={CONFIG}>
      <DcrInventoryPanel />
    </PortsProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Load DCR inventory" }));
  const preview = await screen.findByRole("button", { name: "Preview update" });
  fireEvent.click(preview);
  // The preview lands before the permission read resolves; wait for the header
  // rather than the banner, so the "no banner" case waits for the same thing.
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });
}

describe("DcrInventoryPanel - the guid-loss warning on a real preview", () => {
  it("names the lost guid column on a PRE-FIX DCR", async () => {
    await openPreview(LEGACY_DECLARATION);
    const banner = await screen.findByTestId("guid-loss-warning");
    const text = banner.textContent ?? "";
    expect(text).toContain("CorrelationId");
    // The consequence and the remedy, both on the screen the operator is on.
    expect(text).toContain("stays null");
    expect(text).toContain("Update rebuilds the declaration");
  });

  it("does NOT name TenantId, which the generator drops on purpose", async () => {
    // The defect this file exists for. TenantId is guid and is absent from the
    // declaration in BOTH fixtures, so a check that ignores RULE 2a reports it
    // as lost - on every healthy native table there is.
    await openPreview(LEGACY_DECLARATION);
    const banner = await screen.findByTestId("guid-loss-warning");
    expect(banner.textContent ?? "").not.toContain("TenantId");
  });

  it("shows NO banner on a POST-FIX DCR", async () => {
    // Same table, same TenantId, declaration already rebuilt. A warning that
    // also fires here trains operators to ignore it.
    await openPreview(FIXED_DECLARATION);
    expect(screen.queryByTestId("guid-loss-warning")).toBeNull();
  });
});
