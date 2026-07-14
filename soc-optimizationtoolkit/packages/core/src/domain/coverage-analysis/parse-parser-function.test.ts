/**
 * Pins for the parser-function reader (Wave D): SentinelOne-style solutions
 * bind rules to a KQL function over unioned tables with friendly-name
 * renames - coverage must resolve that indirection.
 */

import { describe, expect, it } from "vitest";
import {
  parseParserYaml,
  parserFieldSynonyms,
} from "./parse-parser-function";

const SENTINELONE_STYLE = `id: 12345
FunctionName: SentinelOne
FunctionAlias: SentinelOne
FunctionQuery: |
  union isfuzzy=true SentinelOne_CL, SentinelOneActivities_CL
  | extend AlertId = column_ifexists('alertId_s', "")
  | extend ActivityType = column_ifexists("activityType_d", 0)
  | project-rename AgentName = agentDetectionInfoName_s, SiteId = siteId_s
Category: Security
`;

describe("parseParserYaml", () => {
  it("extracts alias, unioned tables, and both rename shapes", () => {
    const parsed = parseParserYaml(SENTINELONE_STYLE);
    expect(parsed?.alias).toBe("SentinelOne");
    expect(parsed?.tables).toEqual(["SentinelOneActivities_CL", "SentinelOne_CL"]);
    expect(parsed?.renames).toEqual([
      { output: "AlertId", source: "alertId_s" },
      { output: "ActivityType", source: "activityType_d" },
      { output: "AgentName", source: "agentDetectionInfoName_s" },
      { output: "SiteId", source: "siteId_s" },
    ]);
  });

  it("reads a single-table query head and survives a trailing key", () => {
    const parsed = parseParserYaml(
      "FunctionAlias: Cloudflare\nFunctionQuery: |\n  CloudflareV2_CL\n  | extend Action = column_ifexists('OriginResponseStatus', 0)\nVersion: 1\n",
    );
    expect(parsed?.tables).toEqual(["CloudflareV2_CL"]);
    expect(parsed?.renames).toEqual([
      { output: "Action", source: "OriginResponseStatus" },
    ]);
  });

  it("returns null without an alias or without a query", () => {
    expect(parseParserYaml("FunctionQuery: |\n  T_CL\n")).toBeNull();
    expect(parseParserYaml("FunctionAlias: X\nCategory: Security\n")).toBeNull();
  });
});

describe("parserFieldSynonyms", () => {
  it("exposes output names whose SOURCE column is available", () => {
    const parsed = parseParserYaml(SENTINELONE_STYLE);
    const available = new Set(["alertid_s", "siteid_s", "activitytype"]);
    // ActivityType is ALREADY available under its own name - not a synonym;
    // AgentName's source is not available - excluded.
    expect(parserFieldSynonyms([parsed!], available)).toEqual([
      "AlertId",
      "SiteId",
    ]);
  });

  it("is empty with no parsers or no overlap", () => {
    expect(parserFieldSynonyms([], new Set(["x"]))).toEqual([]);
  });
});
