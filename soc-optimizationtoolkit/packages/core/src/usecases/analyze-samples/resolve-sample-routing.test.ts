/**
 * Pins for the routing usecase (2026-07-12 audit extraction): the WIRED
 * pipeline the mapping review previously assembled inline - connector hints,
 * Wave C identity, destination resolution, DCR-flow + EventsToTableMapping
 * routing, and the per-log-type precedence - plus the one-fetch-pass
 * contract with analyzeSamples.
 */

import { describe, expect, it } from "vitest";
import type { SolutionFileRef, SentinelContent } from "../../ports/sentinel-content";
import { collectGapReports } from "./analyze-samples";
import { resolveSampleRouting } from "./resolve-sample-routing";

const SOLUTION = "CrowdStrike Falcon Endpoint Protection";

const CONNECTOR_JSON = JSON.stringify({
  title: "CrowdStrike FDR",
  graphQueries: [
    {
      baseQuery:
        'CommonSecurityLog | where DeviceVendor == "CrowdStrike" | where DeviceProduct == "FalconHost"',
    },
  ],
  dataTypes: [
    { name: "CrowdStrike_Process_Events_CL" },
    { name: "CrowdStrike_Network_Events_CL" },
  ],
});

const DCR_JSON = JSON.stringify({
  resources: [
    {
      type: "Microsoft.Insights/dataCollectionRules",
      properties: {
        dataFlows: [
          {
            outputStream: "Custom-CrowdStrike_Process_Events_CL",
            transformKql:
              "source | where event_simpleName in ('ProcessRollup2', 'EndOfProcess')",
          },
        ],
      },
    },
  ],
});

const EVENTS_MAPPING = JSON.stringify({ DnsRequest: "Network" });

function content(overrides?: Partial<SentinelContent>): SentinelContent {
  const files: Record<string, string> = {
    "Solutions/CS/Data Connectors/ui.json": CONNECTOR_JSON,
    "Solutions/CS/Data Connectors/ccp/DCR.json": DCR_JSON,
    "Solutions/CS/Data Connectors/fn/EventsToTableMapping.json": EVENTS_MAPPING,
  };
  const refs: SolutionFileRef[] = Object.keys(files).map((p) => ({
    name: p.split("/").pop() ?? p,
    path: p,
    size: files[p].length,
  }));
  return {
    listSolutions: async () => [
      { name: SOLUTION, path: `Solutions/${SOLUTION}`, deprecated: false },
    ],
    listSolutionFiles: async () => [],
    listRepoFiles: async () => [],
    listConnectorFiles: async () => refs,
    readFile: async (p: string) => files[p] ?? null,
    rawFetch: async () => null,
    getCommitSha: async () => null,
    ...overrides,
  };
}

describe("resolveSampleRouting", () => {
  it("pins the precedence: override > DCR flow > EventsToTableMapping > name match > default", async () => {
    const routing = await resolveSampleRouting(content(), {
      solutionName: SOLUTION,
      logTypes: [
        "PROCESSROLLUP2", // DCR flow (event_simpleName)
        "DNSREQUEST", // EventsToTableMapping ("Network" category)
        "CrowdStrike_Network_Events", // name similarity vs connector hints
        "unknowable", // default: first resolved table
        "overridden",
      ],
      overrides: { overridden: "CommonSecurityLog" },
    });
    expect(routing.tableByLogType).toEqual({
      PROCESSROLLUP2: "CrowdStrike_Process_Events_CL",
      DNSREQUEST: "CrowdStrike_Network_Events_CL",
      CrowdStrike_Network_Events: "CrowdStrike_Network_Events_CL",
      unknowable: "CrowdStrike_Process_Events_CL",
      overridden: "CommonSecurityLog",
    });
    expect(routing.resolution.tier).toBe("connector");
    expect(routing.notes).toEqual([]);
  });

  it("derives the Wave C identity from the same connector texts", async () => {
    const routing = await resolveSampleRouting(content(), {
      solutionName: SOLUTION,
      logTypes: [],
    });
    expect(routing.connectorIdentity).toEqual({
      vendor: "CrowdStrike",
      product: "FalconHost",
    });
  });

  it("surfaces degradation notes instead of silently weakening routing", async () => {
    const broken = content({
      readFile: async (p: string) =>
        p.endsWith("EventsToTableMapping.json")
          ? "not json"
          : p.endsWith("ui.json")
            ? CONNECTOR_JSON
            : p.endsWith("DCR.json")
              ? DCR_JSON
              : null,
    });
    const routing = await resolveSampleRouting(broken, {
      solutionName: SOLUTION,
      logTypes: ["DNSREQUEST"],
    });
    expect(routing.notes.join(" ")).toContain("EventsToTableMapping.json");
    // The DNS event no longer routes via the mapping file - falls to default.
    expect(routing.tableByLogType["DNSREQUEST"]).toBe(
      "CrowdStrike_Process_Events_CL",
    );
  });

  it("hands its flows to analyzeSamples so DCR files are fetched ONCE", async () => {
    let listSolutionsCalls = 0;
    const counted = content({
      listSolutions: async () => {
        listSolutionsCalls++;
        return [
          { name: SOLUTION, path: `Solutions/${SOLUTION}`, deprecated: false },
        ];
      },
    });
    const routing = await resolveSampleRouting(counted, {
      solutionName: SOLUTION,
      logTypes: ["PROCESSROLLUP2"],
    });
    expect(listSolutionsCalls).toBe(1);
    await collectGapReports(
      { content: counted, catalog: { resolveSchema: async () => null } },
      {
        solutionName: SOLUTION,
        samples: [
          {
            logType: "PROCESSROLLUP2",
            tableName: routing.tableByLogType["PROCESSROLLUP2"],
            content: '{"event_simpleName":"ProcessRollup2"}',
          },
        ],
        dcrFlows: routing.dcrFlows,
      },
    );
    // analyzeSamples skipped its own resolveSolutionDcrFlows pass.
    expect(listSolutionsCalls).toBe(1);
  });

  it("degrades to the default resolution for an empty solution name", async () => {
    const routing = await resolveSampleRouting(content(), {
      solutionName: "",
      logTypes: ["anything"],
    });
    expect(routing.resolution.tier).toBe("default");
    expect(routing.tableByLogType["anything"]).toBe("CommonSecurityLog");
    expect(routing.connectorIdentity).toBeNull();
  });
});
