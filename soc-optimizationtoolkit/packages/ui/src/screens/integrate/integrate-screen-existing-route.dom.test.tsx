// @vitest-environment happy-dom
/**
 * GEN-28 (C4): THE EXISTING PATH'S SOURCE CONNECTION, MOUNTED.
 *
 * The route to copy and the QuickConnect warning were pinned only as pure
 * functions (existing-destination-state.test.ts). Everything between those
 * functions and the operator lives in IntegrateScreen and nowhere else: the
 * per-source GET /system/inputs/:id effect and its catch branch, the stale-key
 * guard on its answer, and the Source connection body that renders only on the
 * existing path. Any of those could break - the effect dropped, the key
 * mis-guarded so every answer is discarded as stale, the read sent to the
 * wrong path - and the warning would silently stop showing while every pure
 * pin still passed. These mount the screen so that cannot happen quietly.
 *
 * They also pin the rule the screen USES for showing the route (GEN-28): the
 * route appears as soon as every table has a confirmed pick, BEFORE the pack
 * is installed, naming the id the build will install under. @soc/core
 * canWireSource is the native path's gate and deliberately not this one.
 *
 * Its own file because reaching that route needs detected tables, and those
 * come from a gap analysis no other mount in this suite runs: the DCR Gap
 * Analysis section is replaced here with a stub that reports one table, the
 * PAN-OS -> CommonSecurityLog shape of the UAT.
 */

import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_CRIBL_OPTIONS, toListing } from "@soc/core";
import type { AzureConfig, GapReport } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { IntegrateScreen } from "./integrate-screen";
import { expectedPackId } from "./existing-destination-state";

/** One detected table, as a finished gap analysis reports it. */
const REPORT = {
  tableName: "CommonSecurityLog",
  logType: "PaloAlto",
  stats: [],
  sourceFieldCount: 0,
  destFieldCount: 0,
  passthroughCount: 0,
  dcrHandledCount: 0,
  criblHandledCount: 0,
  overflowCount: 0,
  dcrRenames: [],
  dcrCoercions: [],
  criblRenames: [],
  criblCoercions: [],
  dcrHandlesSummary: "",
  criblHandlesSummary: "",
  routeCondition: "",
  fieldMappings: [],
  destSchema: [],
  overflowLossy: false,
  overflowTriage: { entries: [], unmappable: 0, outranked: 0, reviewable: 0 },
  warnings: [],
} as unknown as GapReport;

vi.mock("../mapping-review/mapping-review-section", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../mapping-review/mapping-review-section")>();
  return {
    ...actual,
    MappingReviewSection: ({
      onReportsChange,
    }: {
      onReportsChange: (reports: GapReport[]) => void;
    }) => {
      // Report once, on mount - what a completed Analyze run hands the screen.
      useEffect(() => {
        onReportsChange([REPORT]);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return null;
    },
  };
});

afterEach(cleanup);

/** The UAT's org: no Azure identity and no scope. */
const CONFIG: AzureConfig = {
  clientId: "",
  tenantId: "",
  subscriptionId: "",
  resourceGroup: "",
  workspaceName: "",
  setupPath: "existing",
};

/** A hand-built Sentinel destination whose custom stream names no table. */
const PAN_CSL = {
  id: "PAN-CSL",
  type: "sentinel",
  endpointURLConfiguration: "ID",
  dcrID: "dcr-0123456789abcdef0123456789abcdef",
  streamName: "Custom-dev-TMNA-PaloAltoNetworks-Firewall-stream",
  client_id: "'11111111-2222-3333-4444-555555555555'",
  secret: "!{pan_csl_secret}",
};

/** The UAT's source: in_syslog, QuickConnected to S3. */
const IN_SYSLOG_QUICKCONNECTED = {
  status: 200,
  body: {
    items: [
      {
        id: "in_syslog",
        type: "syslog",
        sendToRoutes: false,
        connections: [{ output: "S3", pipeline: "passthru" }],
      },
    ],
  },
};

function renderExistingRoute(
  sourceRead: () => Promise<{ status: number; body: unknown }>,
) {
  const azure = vi.fn(async () => {
    throw new Error("Azure must not be called on the existing-destination path");
  });
  const request = vi.fn(
    async (req: { method: string; path: string; groupId?: string }) => {
      if (req.path === "/system/outputs") {
        return { status: 200, body: { items: [{ id: "S3", type: "s3" }, PAN_CSL] } };
      }
      if (req.path === "/system/inputs") {
        return { status: 200, body: { items: [{ id: "in_syslog", type: "syslog" }] } };
      }
      if (req.path === "/system/inputs/in_syslog") return sourceRead();
      throw new Error("offline");
    },
  );
  const ports = {
    azure: { request: azure },
    cribl: {
      request,
      listGroups: vi
        .fn()
        .mockResolvedValue(toListing([{ id: "TMNA_POV", product: "stream" }])),
    },
    packs: { list: vi.fn().mockRejectedValue(new Error("offline")) },
    packInstall: { list: vi.fn().mockRejectedValue(new Error("offline")) },
    jobs: { list: vi.fn().mockResolvedValue([]) },
  } as unknown as UiPorts;
  const view = render(
    <PortsProvider ports={ports} config={CONFIG}>
      <IntegrateScreen
        toolkitVersion="9.9.9-test"
        scopeCommitted={false}
        offline
        onCommitScope={vi.fn().mockResolvedValue({ ok: true } as never)}
        criblDefaults={DEFAULT_CRIBL_OPTIONS}
      />
    </PortsProvider>,
  );
  const connection = () =>
    view.container.querySelector(
      '[data-testid="existing-source-connection"]',
    ) as HTMLElement | null;
  const notice = () => connection()?.querySelector(".connection-notice")?.textContent;
  return { ...view, azure, request, connection, notice };
}

/** Open one combobox and click the option whose text contains `label`. */
function pickOption(combo: HTMLElement, label: string): void {
  const root = combo.closest(".searchable-select");
  if (root === null) throw new Error("combobox is not inside a searchable-select");
  fireEvent.click(combo);
  const option = [...root.querySelectorAll(".searchable-select-option")].find((o) =>
    o.textContent?.includes(label),
  );
  if (option === undefined) throw new Error(`no option matching "${label}"`);
  fireEvent.click(option);
}

/** Choose in_syslog in TMNA_POV under Add Sample Data - the capture source. */
async function captureFromInSyslog(container: HTMLElement): Promise<void> {
  await waitFor(() => {
    expect(screen.getByText("Capture from a live source")).toBeTruthy();
  });
  fireEvent.click(screen.getByText("Capture from a live source"));
  const picker = container.querySelector(".sample-source-picker") as HTMLElement;
  const combos = () =>
    [...picker.querySelectorAll(".searchable-select-control")] as HTMLElement[];
  pickOption(combos()[0], "TMNA_POV");
  await waitFor(() => expect(combos()).toHaveLength(2));
  pickOption(combos()[1], "in_syslog");
}

describe("IntegrateScreen - the existing path's source connection (GEN-28)", () => {
  it("warns that a QuickConnected source will not fire the route", async () => {
    const view = renderExistingRoute(async () => IN_SYSLOG_QUICKCONNECTED);
    await captureFromInSyslog(view.container);
    await waitFor(() => {
      expect(view.notice()).toBe(
        "in_syslog is QuickConnected (to S3), so it does not send to routes: this " +
          "route will not fire until the source is switched to send to routes. The " +
          "app does not change the source's QuickConnect flow.",
      );
    });
    // The read went to the source's own path, in the pack's group.
    expect(
      view.request.mock.calls.filter(
        (c) => c[0].path === "/system/inputs/in_syslog" && c[0].groupId === "TMNA_POV",
      ),
    ).toHaveLength(1);
  });

  it("says it could not tell when the source read throws", async () => {
    const view = renderExistingRoute(async () => {
      throw new Error("boom");
    });
    await captureFromInSyslog(view.container);
    await waitFor(() => {
      expect(view.notice()).toBe(
        "Could not tell whether in_syslog sends to routes (boom) - check that it " +
          "is not QuickConnected before relying on this route.",
      );
    });
  });

  it("shows the route to copy once the pick is confirmed, before the pack is installed", async () => {
    const view = renderExistingRoute(async () => IN_SYSLOG_QUICKCONNECTED);
    await captureFromInSyslog(view.container);
    // The picks reset on a group change, so pick only once the capture group
    // has become the pack's group and its destinations are listed.
    const select = await waitFor(() => {
      const found = screen.getByLabelText(
        "Existing destination for CommonSecurityLog",
      ) as HTMLSelectElement;
      expect([...found.options].map((o) => o.value)).toContain("PAN-CSL");
      return found;
    });
    fireEvent.change(select, { target: { value: "PAN-CSL" } });
    // A custom stream names no table, so the pick asks for a confirmation.
    const confirm = await waitFor(() => {
      const box = select
        .closest("label")
        ?.parentElement?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      expect(box).toBeTruthy();
      return box as HTMLInputElement;
    });
    fireEvent.click(confirm);

    const routeJson = await waitFor(() => {
      const pre = view.container.querySelector('[data-testid="existing-route-json"]');
      expect(pre).toBeTruthy();
      return pre as HTMLElement;
    });
    const packId = expectedPackId("MS-Sentinel");
    expect(JSON.parse(routeJson.textContent ?? "")).toEqual({
      id: `${packId}_in_syslog`,
      name: `in_syslog to PAN-CSL via ${packId}`,
      filter: "__inputId.startsWith('syslog:in_syslog:')",
      pipeline: `pack:${packId}`,
      output: "PAN-CSL",
      final: true,
      description: `Sends in_syslog through pack ${packId} to the existing Sentinel destination PAN-CSL.`,
    });
    // Nothing is installed yet, and the route says which id it names.
    expect(view.connection()?.textContent).toContain(
      `(install the pack first - the route names pack:${packId}, the id it is built under)`,
    );
    // The QuickConnect warning still stands beside the route it concerns.
    expect(view.notice()).toMatch(/^in_syslog is QuickConnected \(to S3\)/);
    // The run's gate passes the pick and the run's own prerequisites and lands
    // on the pack's: no client id and no table name in between, because the
    // core says the existing path needs neither (deployAzureRequirements). An
    // absence check alone would also pass with no hint rendered at all.
    expect(view.container.querySelector(".readiness-footer-hint")?.textContent).toBe(
      "Approve the DCR Gap Analysis mappings (section 3) first - the pack is built from them.",
    );
    expect(view.azure).not.toHaveBeenCalled();
  });
});
