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

/**
 * An UNRELATED solution that sorts FIRST (the port documents listSolutions as
 * sorted by name). It is the half of the fixture that makes the DBT-42 pin
 * below mean something: with no solution selected, the pre-fix code matched
 * this one - matchSolutionName is `includes`-based and an empty needle is
 * contained in every name - and adopted ITS DCR as the feed's routing.
 */
const OTHER_SOLUTION = "Auth0 Single Sign On";

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

/** The other vendor's DCR - the one an unselected analysis used to inherit. */
const OTHER_DCR_JSON = JSON.stringify({
  resources: [
    {
      type: "Microsoft.Insights/dataCollectionRules",
      properties: {
        dataFlows: [
          {
            outputStream: "Custom-Auth0_CL",
            transformKql: "source | where event_simpleName in ('sso')",
          },
        ],
      },
    },
  ],
});

const FILES_BY_SOLUTION: Readonly<Record<string, Record<string, string>>> = {
  [SOLUTION]: {
    "Solutions/CS/Data Connectors/ui.json": CONNECTOR_JSON,
    "Solutions/CS/Data Connectors/ccp/DCR.json": DCR_JSON,
    "Solutions/CS/Data Connectors/fn/EventsToTableMapping.json": EVENTS_MAPPING,
  },
  [OTHER_SOLUTION]: {
    "Solutions/Auth0/Data Connectors/Auth0DCR.json": OTHER_DCR_JSON,
  },
};

/** readFile is PATH-addressed, so it answers for every solution's files. */
const ALL_FILES: Record<string, string> = {
  ...FILES_BY_SOLUTION[SOLUTION],
  ...FILES_BY_SOLUTION[OTHER_SOLUTION],
};

function refsFor(solutionName: string): SolutionFileRef[] {
  const files = FILES_BY_SOLUTION[solutionName] ?? {};
  return Object.keys(files).map((p) => ({
    name: p.split("/").pop() ?? p,
    path: p,
    size: files[p].length,
  }));
}

const SOLUTIONS = [
  { name: OTHER_SOLUTION, path: `Solutions/${OTHER_SOLUTION}`, deprecated: false },
  { name: SOLUTION, path: `Solutions/${SOLUTION}`, deprecated: false },
];

function content(overrides?: Partial<SentinelContent>): SentinelContent {
  return {
    listSolutions: async () => [...SOLUTIONS],
    listSolutionFiles: async () => [],
    listRepoFiles: async () => [],
    // Answers PER SOLUTION rather than handing the same files to any name:
    // a fixture that ignores the argument cannot tell "asked for the right
    // solution" from "asked for whatever the repo listed first", which is
    // exactly the DBT-42 defect.
    listConnectorFiles: async (solutionName: string) => refsFor(solutionName),
    readFile: async (p: string) => ALL_FILES[p] ?? null,
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
        return [...SOLUTIONS];
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

  it("adopts NO solution's DCR flows when no solution is selected (DBT-42)", async () => {
    // THE DEFECT: the DCR-flow call ran unguarded while the connector listing
    // beside it was guarded. matchSolutionName is `includes`-based, so the
    // empty name matched the FIRST solution the repo lists and the analysis
    // reported that vendor's renames, coercions and route condition as this
    // feed's - while the UI told the operator connector detection had been
    // disabled for the run. Blank-but-not-empty must behave the same, because
    // the sibling guard trims.
    for (const solutionName of ["", "   "]) {
      // Counted, not just asserted empty: TWO things now stop a borrowed DCR
      // (this guard, and matchSolutionName refusing a blank needle), so an
      // empty map alone no longer says which one held. With nothing selected
      // the usecase must not GO LOOKING at all - which is also the only
      // reading that respects the port's per-analysis fetch budget.
      let listSolutionsCalls = 0;
      let listConnectorFilesCalls = 0;
      const counted = content({
        listSolutions: async () => {
          listSolutionsCalls++;
          return [...SOLUTIONS];
        },
        listConnectorFiles: async (name: string) => {
          listConnectorFilesCalls++;
          return refsFor(name);
        },
      });
      const routing = await resolveSampleRouting(counted, {
        solutionName,
        logTypes: ["anything"],
      });
      expect([...routing.dcrFlows.keys()]).toEqual([]);
      expect([listSolutionsCalls, listConnectorFilesCalls]).toEqual([0, 0]);
    }

    // POSITIVE CONTROL, so the empty maps above cannot pass because the
    // fixture simply has no DCRs to find: the SAME fixture yields a flow the
    // moment a solution is named, and the flow it used to leak for "" was the
    // alphabetically-first Auth0 one, not this.
    const selected = await resolveSampleRouting(content(), {
      solutionName: SOLUTION,
      logTypes: ["anything"],
    });
    expect([...selected.dcrFlows.keys()]).toEqual([
      "crowdstrike_process_events_cl",
    ]);
    const other = await resolveSampleRouting(content(), {
      solutionName: OTHER_SOLUTION,
      logTypes: [],
    });
    expect([...other.dcrFlows.keys()]).toEqual(["auth0_cl"]);
  });
});
