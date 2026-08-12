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
import type {
  FieldMappingOverride,
  PipelineFieldMapping,
  TablePlanInput,
} from "./models";

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

describe("multi-log-type route discriminators (live flaw 2026-07-13)", () => {
  it("gives each match-all table a filter from its unique sample fields", () => {
    const plan = buildPipelinePlan({
      solutionName: "Zscaler Internet",
      packName: "zia",
      tables: [
        {
          sentinelTable: "CommonSecurityLog",
          logType: "web-BLOCKED",
          sourceFormat: "cef",
          passthroughFields: [
            { name: "urlcategory", type: "string" },
            { name: "act", type: "string" },
          ],
        },
        {
          sentinelTable: "CommonSecurityLog",
          logType: "firewall",
          sourceFormat: "cef",
          passthroughFields: [
            { name: "nwapp", type: "string" },
            { name: "act", type: "string" },
          ],
        },
      ],
    });
    expect(plan.tables[0].routeCondition).toContain("urlcategory !== undefined");
    expect(plan.tables[0].routeCondition).toContain("urlcategory=");
    expect(plan.tables[1].routeCondition).toContain("nwapp !== undefined");
    // The shared field never discriminates.
    expect(plan.tables[0].routeCondition).not.toContain("act !==");
  });

  it("keeps explicit routing conditions and single-table match-alls untouched", () => {
    const single = buildPipelinePlan({
      solutionName: "Acme",
      packName: "acme",
      tables: [
        {
          sentinelTable: "Acme_CL",
          passthroughFields: [{ name: "a", type: "string" }],
        },
      ],
    });
    expect(single.tables[0].routeCondition).toBe("true");
  });
});

describe("overflow is enabled by the FIELDS, not only by the matcher", () => {
  // User report 2026-08-12 (Zscaler): the gap analysis said 133 of 170 fields
  // would land in AdditionalExtensions, and the generated pipeline had no
  // serialize function at all. Every ladder rung that did not come from the
  // field matcher hardcoded a DISABLED overflow config, so an `overflow` field
  // fell through the emitter entirely - not renamed (correct), not serialized
  // (the step is gated on enabled), not dropped (cleanup only removes `drop`).
  // It reached the DCR under its raw vendor name and was discarded there.
  //
  // Silent by construction: nothing errors, the pack installs, and the fields
  // are simply absent from the table.
  const overflowField = (source: string): PipelineFieldMapping => ({
    source,
    target: "AdditionalExtensions",
    type: "string",
    action: "overflow",
  });
  const renameField: PipelineFieldMapping = {
    source: "login",
    target: "SourceUserName",
    type: "string",
    action: "rename",
  };

  const planFor = (input: Partial<TablePlanInput>) =>
    buildPipelinePlan({
      solutionName: "Zscaler Internet Access",
      packName: "MS-Sentinel-Zscaler",
      version: "1.0.0",
      tables: [
        {
          sentinelTable: "CommonSecurityLog",
          logType: "ALLOWED",
          sourceFormat: "json",
          ...input,
        } as TablePlanInput,
      ],
    }).tables[0]!;

  it("enables overflow from PRESET fields - the gap-analysis path", () => {
    // The rung the DCR Gap Analysis preview and the pack build both land on.
    const plan = planFor({
      presetFields: [renameField, overflowField("cloudname"), overflowField("bamd5")],
    });
    expect(plan.provenance).toBe("preset-fields");
    expect(plan.overflowConfig.enabled).toBe(true);
    expect(plan.overflowConfig.sourceFields).toEqual(["cloudname", "bamd5"]);
    // The table's own catch-all column, not an invented name.
    expect(plan.overflowConfig.fieldName).toBe("AdditionalExtensions");
  });

  it("enables overflow from USER OVERRIDES - the reviewer-edit path", () => {
    const plan = planFor({
      fieldOverrides: [
        { source: "login", dest: "SourceUserName", destType: "string", action: "rename" },
        { source: "cloudname", dest: "AdditionalExtensions", destType: "string", action: "overflow" },
      ] as TablePlanInput["fieldOverrides"],
    });
    expect(plan.provenance).toBe("user-override");
    expect(plan.overflowConfig.enabled).toBe(true);
    expect(plan.overflowConfig.sourceFields).toEqual(["cloudname"]);
  });

  it("stays DISABLED when no field asks for overflow", () => {
    // Enabling it unconditionally would emit a serialize that sweeps up every
    // unmapped field on tables that deliberately have no catch-all behaviour.
    const plan = planFor({ presetFields: [renameField] });
    expect(plan.overflowConfig.enabled).toBe(false);
    expect(plan.overflowConfig.sourceFields).toEqual([]);
  });

  it("still lets the MATCHER's own config win", () => {
    // It carries decisions this cannot reconstruct, so it is never second-guessed.
    const mine = {
      enabled: false,
      fieldName: "SomethingElse",
      fieldType: "dynamic" as const,
      sourceFields: [],
    };
    const plan = planFor({
      presetFields: [overflowField("cloudname")],
      matchResult: { overflowConfig: mine, matched: [], overflow: [], unmatchedSource: [] } as never,
    });
    expect(plan.overflowConfig).toEqual(mine);
  });
});

describe("the pipeline a gap-analysis plan emits actually collects overflow", () => {
  // The plan pins above prove the CONFIG is enabled. This proves the emitted
  // conf.yml contains the serialize that acts on it - the two are separate
  // steps, and the bug lived in the seam between them.
  it("emits a serialize into the catch-all for preset overflow fields", () => {
    const plan = buildPipelinePlan({
      solutionName: "Zscaler Internet Access",
      packName: "MS-Sentinel-Zscaler",
      version: "1.0.0",
      tables: [
        {
          sentinelTable: "CommonSecurityLog",
          logType: "ALLOWED",
          sourceFormat: "json",
          presetFields: [
            { source: "login", target: "SourceUserName", type: "string", action: "rename" },
            { source: "cloudname", target: "AdditionalExtensions", type: "string", action: "overflow" },
          ],
        } as TablePlanInput,
      ],
    }).tables[0]!;

    // The SAME entry point the pack build uses, so this exercises the real seam
    // rather than a hand-assembled argument list that could drift from it.
    const conf = generatePipelineConfForPlan(plan, "Zscaler Internet Access");

    // The function the whole report was about - absent before this fix.
    expect(conf).toContain("- id: serialize");
    expect(conf).toContain("dstField: AdditionalExtensions");
    expect(conf).toContain("groupId: overflow");
    // The rename still happens; the two are not alternatives.
    expect(conf).toContain("SourceUserName");
    // The renamed DESTINATION is excluded from the catch-all, so a mapped field
    // is never duplicated into it.
    expect(conf).toContain('- "!SourceUserName"');
  });

  it("emits NO serialize when nothing overflows", () => {
    const plan = buildPipelinePlan({
      solutionName: "Zscaler Internet Access",
      packName: "MS-Sentinel-Zscaler",
      version: "1.0.0",
      tables: [
        {
          sentinelTable: "CommonSecurityLog",
          logType: "ALLOWED",
          sourceFormat: "json",
          presetFields: [
            { source: "login", target: "SourceUserName", type: "string", action: "rename" },
          ],
        } as TablePlanInput,
      ],
    }).tables[0]!;
    const conf = generatePipelineConfForPlan(plan, "Zscaler Internet Access");
    expect(conf).not.toContain("- id: serialize");
  });
});

describe("selective drop inside the catch-all (user decision 2026-08-12)", () => {
  // Newly reachable: until overflow could be enabled from the fields, this
  // interaction never occurred in the app at all, because the serialize step
  // never ran. Now that it does, the reviewer's lever has to work - the whole
  // point of the catch-all is that it is not all-or-nothing.
  //
  // "We should not remove the AdditionalExtensions fields if it exists, as
  // there may be some situations where the user only wants to drop SOME of the
  // fields that would be added to it. We should instead drop individual fields
  // that the app marks for drop."
  const confFor = (fields: PipelineFieldMapping[]) => {
    const plan = buildPipelinePlan({
      solutionName: "Zscaler Internet Access",
      packName: "MS-Sentinel-Zscaler",
      version: "1.0.0",
      tables: [
        {
          sentinelTable: "CommonSecurityLog",
          logType: "ALLOWED",
          sourceFormat: "json",
          presetFields: fields,
        } as TablePlanInput,
      ],
    }).tables[0]!;
    return generatePipelineConfForPlan(plan, "Zscaler Internet Access");
  };

  const MIXED: PipelineFieldMapping[] = [
    { source: "login", target: "SourceUserName", type: "string", action: "rename" },
    { source: "cloudname", target: "AdditionalExtensions", type: "string", action: "overflow" },
    { source: "bamd5", target: "AdditionalExtensions", type: "string", action: "overflow" },
    { source: "noisy", target: "", type: "string", action: "drop" },
  ];

  it("keeps the catch-all while removing ONLY the field marked drop", () => {
    const conf = confFor(MIXED);
    // The catch-all still runs for everything else.
    expect(conf).toContain("- id: serialize");
    expect(conf).toContain("dstField: AdditionalExtensions");
    // The dropped field is kept OUT of the catch-all...
    expect(conf).toContain('- "!noisy"');
    // ...and removed from the event entirely.
    const cleanup = conf.slice(conf.indexOf("Remove internal fields") - 900);
    expect(cleanup).toContain("- noisy");
  });

  it("does NOT remove the fields that overflow - dropping is per-field", () => {
    // The regression this guards: bulk-removing the overflow set would make the
    // reviewer choose between the whole catch-all and none of it.
    const conf = confFor(MIXED);
    const cleanup = conf.slice(conf.indexOf("Remove internal fields") - 900);
    expect(cleanup).not.toContain("- cloudname");
    expect(cleanup).not.toContain("- bamd5");
    // And they are not excluded from the serialize either, so they land in it.
    expect(conf).not.toContain('- "!cloudname"');
    expect(conf).not.toContain('- "!bamd5"');
  });

  it("still collects the catch-all when EVERY unmapped field is dropped", () => {
    // The degenerate end of the same lever: drop them all and the serialize has
    // nothing left to collect, but a mapped field must never be swept in.
    const conf = confFor([
      { source: "login", target: "SourceUserName", type: "string", action: "rename" },
      { source: "noisy", target: "", type: "string", action: "drop" },
    ]);
    expect(conf).not.toContain("- id: serialize");
    expect(conf).toContain("SourceUserName");
  });
});
