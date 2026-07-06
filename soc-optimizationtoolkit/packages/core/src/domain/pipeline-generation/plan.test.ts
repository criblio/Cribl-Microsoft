/**
 * buildPipelinePlan - Unit 17 (a) - the one planner unifying the legacy branches.
 *
 * Pins the priority ladder, the no-duplicate-DCR-transforms contract (via emitted
 * conf), and the CONSCIOUS resolution of the per-logType overflow collision
 * (Cloudflare multi-logType single table).
 */

import { describe, it, expect } from "vitest";
import { matchFields } from "../field-matcher";
import type { DcrGapAnalysis } from "../gap-analysis";
import { buildPipelinePlan } from "./plan";
import { generatePipelineConfForPlan } from "./pipeline-conf";
import type { FieldMappingOverride } from "./models";

describe("planner priority ladder", () => {
  it("field-match: derives rename/overflow-drop and carries the matcher overflow config", () => {
    const match = matchFields(
      [
        { name: "src", type: "string" },
        { name: "weird_extra", type: "string" },
      ],
      [
        { name: "SourceIP", type: "string" },
        { name: "AdditionalExtensions", type: "string" },
      ],
      undefined,
      "CommonSecurityLog",
    );
    const plan = buildPipelinePlan({
      solutionName: "PaloAlto PAN-OS",
      packName: "paloalto-sentinel",
      tables: [
        { sentinelTable: "CommonSecurityLog", logType: "TRAFFIC", matchResult: match, sourceFormat: "cef" },
      ],
    });
    const t = plan.tables[0];
    expect(t.provenance).toBe("field-match");
    expect(t.fields.find((f) => f.source === "src")?.action).toBe("rename");
    expect(t.fields.find((f) => f.source === "src")?.target).toBe("SourceIP");
    expect(t.fields.find((f) => f.source === "weird_extra")?.action).toBe("drop");
    expect(t.overflowConfig.enabled).toBe(true);
    expect(t.overflowConfig.sourceFields).toContain("weird_extra");
  });

  it("user overrides win over a match result", () => {
    const match = matchFields(
      [{ name: "src", type: "string" }],
      [{ name: "SourceIP", type: "string" }],
      undefined,
      "CommonSecurityLog",
    );
    const overrides: FieldMappingOverride[] = [
      {
        source: "src",
        dest: "SourceAddress",
        sourceType: "string",
        destType: "string",
        confidence: "exact",
        action: "rename",
        needsCoercion: false,
        description: "user pick",
      },
    ];
    const plan = buildPipelinePlan({
      solutionName: "Acme",
      packName: "acme",
      tables: [
        {
          sentinelTable: "CommonSecurityLog",
          matchResult: match,
          fieldOverrides: overrides,
        },
      ],
    });
    expect(plan.tables[0].provenance).toBe("user-override");
    expect(plan.tables[0].fields[0].target).toBe("SourceAddress");
  });

  it("passthrough keeps all source fields when no schema/match is available", () => {
    const plan = buildPipelinePlan({
      solutionName: "Acme",
      packName: "acme",
      tables: [
        {
          sentinelTable: "Acme_CL",
          passthroughFields: [
            { name: "a", type: "string" },
            { name: "b", type: "int" },
          ],
        },
      ],
    });
    expect(plan.tables[0].provenance).toBe("passthrough");
    expect(plan.tables[0].fields.every((f) => f.action === "keep")).toBe(true);
    expect(plan.tables[0].fields.map((f) => f.source)).toEqual(["a", "b"]);
  });

  it("empty when nothing is provided", () => {
    const plan = buildPipelinePlan({
      solutionName: "Acme",
      packName: "acme",
      tables: [{ sentinelTable: "Acme_CL" }],
    });
    expect(plan.tables[0].provenance).toBe("empty");
    expect(plan.tables[0].fields).toEqual([]);
  });
});

describe("no-duplicate-DCR-transforms (dcr-gap branch)", () => {
  const gap: DcrGapAnalysis = {
    tableName: "CrowdStrike_Process_Events_CL",
    dcrHandles: {
      renames: [{ source: "aid", dest: "AgentId" }],
      coercions: [{ field: "timestamp", toType: "datetime" }],
      routing: "event_simpleName in ('ProcessRollup2')",
      timeGenerated: true,
    },
    criblMustHandle: {
      renames: [{ source: "cs1", dest: "DeviceCustomString1", reason: "gap" }],
      coercions: [],
      overflow: [{ field: "weird_only", type: "string" }],
      drops: [],
      enrichments: [
        { field: "_time", value: "..." },
        { field: "Type", value: "CrowdStrike_Process_Events_CL" },
      ],
    },
    totalSourceFields: 3,
    totalDestFields: 5,
    passthroughCount: 1,
    dcrHandledCount: 2,
    criblHandledCount: 1,
    overflowCount: 1,
    warnings: [],
  };

  it("uses criblMustHandle and never re-emits a DCR-handled rename", () => {
    const plan = buildPipelinePlan({
      solutionName: "CrowdStrike Falcon",
      packName: "crowdstrike-sentinel",
      tables: [
        {
          sentinelTable: "CrowdStrike_Process_Events_CL",
          logType: "ProcessRollup2",
          gap,
          sourceFormat: "ndjson",
        },
      ],
    });
    const t = plan.tables[0];
    expect(t.provenance).toBe("dcr-gap");
    // Cribl handles cs1, NOT the DCR-owned aid rename.
    expect(t.fields.find((f) => f.source === "cs1")?.action).toBe("rename");
    expect(t.fields.find((f) => f.source === "aid")).toBeUndefined();

    // And the emitted pipeline's rename step reflects the same: DeviceCustomString1
    // is present, AgentId (DCR-owned) is absent.
    const conf = generatePipelineConfForPlan(t, "CrowdStrike Falcon");
    expect(conf).toContain("newName: DeviceCustomString1");
    expect(conf).not.toContain("AgentId");
  });
});

describe("per-logType overflow collision resolved (Cloudflare)", () => {
  it("two log types on ONE table keep distinct overflow configs and share a destination", () => {
    const httpMatch = matchFields(
      [
        { name: "ClientIP", type: "string" },
        { name: "cf_http_only", type: "string" },
      ],
      [
        { name: "ClientIP", type: "string" },
        { name: "AdditionalFields_d", type: "dynamic" },
      ],
      undefined,
      "CloudflareV2_CL",
    );
    const dnsMatch = matchFields(
      [
        { name: "QueryName", type: "string" },
        { name: "cf_dns_only", type: "string" },
      ],
      [
        { name: "QueryName", type: "string" },
        { name: "AdditionalFields_d", type: "dynamic" },
      ],
      undefined,
      "CloudflareV2_CL",
    );

    const plan = buildPipelinePlan({
      solutionName: "Cloudflare",
      packName: "cloudflare-sentinel",
      tables: [
        { sentinelTable: "CloudflareV2_CL", logType: "HTTP", matchResult: httpMatch, sourceFormat: "json" },
        { sentinelTable: "CloudflareV2_CL", logType: "DNS", matchResult: dnsMatch, sourceFormat: "json" },
      ],
    });

    expect(plan.tables).toHaveLength(2);
    expect(plan.tables[0].suffix).toBe("HTTP");
    expect(plan.tables[1].suffix).toBe("DNS");
    // Each carries its OWN overflow set - no clobbering (the legacy Map keyed by
    // table name would have overwritten HTTP's config with DNS's).
    expect(plan.tables[0].overflowConfig.sourceFields).toEqual(["cf_http_only"]);
    expect(plan.tables[1].overflowConfig.sourceFields).toEqual(["cf_dns_only"]);
    // Both route to the same shared-table destination.
    expect(plan.tables[0].destinationId).toBe("MS-Sentinel-CloudflareV2-dest");
    expect(plan.tables[1].destinationId).toBe(plan.tables[0].destinationId);
  });
});

describe("reduction rules resolution", () => {
  it("looks up the KB by (table, solution) when not supplied", () => {
    const plan = buildPipelinePlan({
      solutionName: "PaloAlto PAN-OS",
      packName: "pa",
      tables: [{ sentinelTable: "CommonSecurityLog" }],
    });
    expect(plan.tables[0].reductionRules).not.toBeNull();
  });

  it("honors an explicit null (no reduction) over a KB lookup", () => {
    const plan = buildPipelinePlan({
      solutionName: "PaloAlto PAN-OS",
      packName: "pa",
      tables: [{ sentinelTable: "CommonSecurityLog", reductionRules: null }],
    });
    expect(plan.tables[0].reductionRules).toBeNull();
  });
});
