import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPERATION_OPTIONS,
  VENDOR_SCHEMAS,
  parseTableSchemaFile,
} from "@soc/core";
import type {
  CollectedArmRequest,
  JobRecord,
  OnboardBatchOutcome,
  OperationOptions,
} from "@soc/core";
import {
  DEFAULT_BATCH_RUN_OVERRIDES,
  amplsIssueFor,
  applyRunOverrides,
  batchRunDetail,
  batchRunLabel,
  batchTemplatesArtifactName,
  buildBatchSelection,
  buildTemplatesArtifact,
  deriveBatchCounts,
  formatBatchCountsLine,
  formatBatchSummary,
  parseTableListText,
} from "./batch-state";

// A real bundled vendor entry (the library ships with the core package, so
// tests exercise the exact registry the picker offers).
const VENDOR = VENDOR_SCHEMAS[0];

describe("parseTableListText", () => {
  it("splits on newlines, commas, semicolons, and whitespace", () => {
    expect(
      parseTableListText("SecurityEvent\nSyslog, CommonSecurityLog;Heartbeat  AzureActivity"),
    ).toEqual([
      "SecurityEvent",
      "Syslog",
      "CommonSecurityLog",
      "Heartbeat",
      "AzureActivity",
    ]);
  });

  it("drops empties and dedupes exact repeats keeping the first occurrence", () => {
    expect(parseTableListText("A\n\n B,A\n,,B\nC")).toEqual(["A", "B", "C"]);
  });

  it("is case-sensitive (Azure table names are)", () => {
    expect(parseTableListText("Syslog\nsyslog")).toEqual(["Syslog", "syslog"]);
  });

  it("returns [] for blank input", () => {
    expect(parseTableListText("")).toEqual([]);
    expect(parseTableListText("  \n ,; ")).toEqual([]);
  });
});

describe("buildBatchSelection", () => {
  it("keeps typed order first, then appends vendor picks with their schemas", () => {
    const selection = buildBatchSelection("SecurityEvent\nSyslog", [VENDOR.id]);
    expect(selection.errors).toEqual([]);
    expect(selection.specs.map((spec) => spec.table)).toEqual([
      "SecurityEvent",
      "Syslog",
      VENDOR.table,
    ]);
    expect(selection.specs[0].customSchema).toBeUndefined();
    // The vendor spec carries the bundled schema through the SAME parse path
    // as a user upload.
    expect(selection.specs[2].customSchema).toEqual(
      parseTableSchemaFile(VENDOR.raw).columns,
    );
  });

  it("merges a vendor pick into a typed entry with the same table", () => {
    const selection = buildBatchSelection(
      `SecurityEvent\n${VENDOR.table}\nSyslog`,
      [VENDOR.id],
    );
    expect(selection.specs.map((spec) => spec.table)).toEqual([
      "SecurityEvent",
      VENDOR.table,
      "Syslog",
    ]);
    // Position stays where it was typed; the schema comes from the pick.
    expect(selection.specs[1].customSchema).toEqual(
      parseTableSchemaFile(VENDOR.raw).columns,
    );
    expect(selection.duplicates).toEqual([VENDOR.table]);
  });

  it("dedupes a vendor id picked twice", () => {
    const selection = buildBatchSelection("", [VENDOR.id, VENDOR.id]);
    expect(selection.specs.map((spec) => spec.table)).toEqual([VENDOR.table]);
    expect(selection.errors).toEqual([]);
  });

  it("reports an unknown vendor id as an error and keeps the rest", () => {
    const selection = buildBatchSelection("Syslog", ["no-such-vendor"]);
    expect(selection.specs.map((spec) => spec.table)).toEqual(["Syslog"]);
    expect(selection.errors).toEqual([
      "Unknown vendor schema 'no-such-vendor'.",
    ]);
  });

  it("typed _CL names without a pick carry no schema (existing table wins)", () => {
    const selection = buildBatchSelection("MyApp_CL", []);
    expect(selection.specs).toEqual([{ table: "MyApp_CL" }]);
  });
});

describe("applyRunOverrides", () => {
  const base: OperationOptions = {
    ...DEFAULT_OPERATION_OPTIONS,
    createDCE: false,
    skipExistingDCRs: true,
    templateOnly: false,
  };

  it("passes the persisted values through when everything is 'default'", () => {
    expect(applyRunOverrides(base, DEFAULT_BATCH_RUN_OVERRIDES)).toEqual(base);
  });

  it("forces the three flags on/off without touching other fields", () => {
    const effective = applyRunOverrides(base, {
      createDCE: "on",
      skipExistingDCRs: "off",
      templateOnly: "on",
    });
    expect(effective.createDCE).toBe(true);
    expect(effective.skipExistingDCRs).toBe(false);
    expect(effective.templateOnly).toBe(true);
    expect(effective.deploymentTimeoutSeconds).toBe(
      base.deploymentTimeoutSeconds,
    );
    expect(effective.amplsResourceId).toBe(base.amplsResourceId);
  });

  it("never mutates the persisted options", () => {
    const snapshot = { ...base };
    applyRunOverrides(base, {
      createDCE: "on",
      skipExistingDCRs: "off",
      templateOnly: "on",
    });
    expect(base).toEqual(snapshot);
  });

  // Recorded Unit 6.5 decision: batch-onboard relaxes to 'azure', with
  // templateOnly FORCED on when the mode has no live Cribl connection. The
  // force is a mode FACT, not a user choice, so it outranks both the
  // persisted default and the per-run override.
  it("forcedTemplateOnly outranks the persisted default AND an 'off' override", () => {
    const effective = applyRunOverrides(
      base,
      { ...DEFAULT_BATCH_RUN_OVERRIDES, templateOnly: "off" },
      true,
    );
    expect(effective.templateOnly).toBe(true);
  });

  it("forcedTemplateOnly touches nothing but templateOnly", () => {
    const effective = applyRunOverrides(
      base,
      DEFAULT_BATCH_RUN_OVERRIDES,
      true,
    );
    expect(effective).toEqual({ ...base, templateOnly: true });
  });

  it("forcedTemplateOnly=false is the exact pre-existing behavior", () => {
    expect(
      applyRunOverrides(base, DEFAULT_BATCH_RUN_OVERRIDES, false),
    ).toEqual(applyRunOverrides(base, DEFAULT_BATCH_RUN_OVERRIDES));
  });
});

describe("amplsIssueFor", () => {
  it("flags createDCE + public access disabled without an AMPLS id", () => {
    // The Unit 6 cross-field rule re-checked over the EFFECTIVE options: a
    // per-run createDCE override can create this combination even though the
    // Options screen blocks saving it.
    const issue = amplsIssueFor({
      ...DEFAULT_OPERATION_OPTIONS,
      createDCE: true,
      dcePublicNetworkAccess: false,
      amplsResourceId: "",
    });
    expect(issue).toContain("Required when Create DCE is enabled");
  });

  it("accepts the combination with a well-formed AMPLS resource id", () => {
    expect(
      amplsIssueFor({
        ...DEFAULT_OPERATION_OPTIONS,
        createDCE: true,
        dcePublicNetworkAccess: false,
        amplsResourceId:
          "/subscriptions/sub-1/resourceGroups/rg-net/providers/" +
          "Microsoft.Insights/privateLinkScopes/ampls-prod",
      }),
    ).toBeNull();
  });

  it("stays quiet when public network access is enabled", () => {
    expect(
      amplsIssueFor({
        ...DEFAULT_OPERATION_OPTIONS,
        createDCE: true,
        dcePublicNetworkAccess: true,
        amplsResourceId: "",
      }),
    ).toBeNull();
  });
});

describe("deriveBatchCounts / formatBatchCountsLine", () => {
  it("counts each terminal status", () => {
    const counts = deriveBatchCounts([
      { table: "A", status: "succeeded" },
      { table: "B", status: "skipped", reason: "already-exists" },
      { table: "C", status: "failed", error: "boom" },
      { table: "D", status: "succeeded" },
    ]);
    expect(counts).toEqual({ succeeded: 2, failed: 1, skipped: 1, total: 4 });
  });

  it("derives partial counts mid-run (results persist per table)", () => {
    expect(deriveBatchCounts([])).toEqual({
      succeeded: 0,
      failed: 0,
      skipped: 0,
      total: 0,
    });
  });

  it("says 'deployed' on deploy runs and 'templates collected' on templateOnly", () => {
    const counts = { succeeded: 2, failed: 1, skipped: 1, total: 4 };
    expect(formatBatchCountsLine(counts, false)).toBe(
      "2 deployed, 1 skipped, 1 failed (of 4 table(s))",
    );
    expect(formatBatchCountsLine(counts, true)).toBe(
      "2 templates collected, 1 skipped, 1 failed (of 4 table(s))",
    );
  });
});

function outcomeFixture(): OnboardBatchOutcome {
  return {
    tables: [
      { table: "SecurityEvent", status: "succeeded", detail: "DCR 'dcr-se' deployed" },
      {
        table: "Syslog",
        status: "skipped",
        reason: "already-exists",
        detail: "DCR 'dcr-syslog' already exists - skipped (skipExistingDCRs)",
      },
      { table: "Bad_CL", status: "failed", error: "HTTP 400 {}" },
    ],
    dce: {
      name: "dce-law-prod-eastus",
      resourceId: "/subscriptions/s/resourceGroups/r/providers/Microsoft.Insights/dataCollectionEndpoints/dce-law-prod-eastus",
      logsIngestionEndpoint: "https://dce.eastus-1.ingest.monitor.azure.com",
      reused: true,
      amplsAssociated: false,
    },
    templates: [],
    succeeded: 1,
    failed: 1,
    skipped: 1,
  };
}

describe("formatBatchSummary", () => {
  it("renders counts, the DCE line, and aligned per-table lines", () => {
    const text = formatBatchSummary(outcomeFixture(), false);
    const lines = text.split("\n");
    expect(lines[0]).toBe("1 deployed, 1 skipped, 1 failed (of 3 table(s))");
    expect(lines[1]).toBe(
      "DCE: dce-law-prod-eastus (reused) - https://dce.eastus-1.ingest.monitor.azure.com",
    );
    // Per-table lines reuse the step-line format: 'skipped' renders with its
    // distinct tag, failures carry the raw error text.
    expect(lines[2]).toBe("[succeeded] SecurityEvent - DCR 'dcr-se' deployed");
    expect(lines[3]).toBe(
      "[skipped]   Syslog - DCR 'dcr-syslog' already exists - skipped (skipExistingDCRs)",
    );
    expect(lines[4]).toBe("[failed]    Bad_CL - HTTP 400 {}");
  });

  it("announces the collected-template count on templateOnly runs", () => {
    const outcome: OnboardBatchOutcome = {
      ...outcomeFixture(),
      dce: null,
      templates: [
        {
          kind: "dcr",
          table: "SecurityEvent",
          artifactName: "dcr-SecurityEvent-eastus.json",
          method: "PUT",
          path: "/subscriptions/s/x",
          apiVersion: "2023-03-11",
          body: {},
        },
      ],
    };
    const text = formatBatchSummary(outcome, true);
    expect(text).toContain("1 templates collected");
    expect(text).toContain("1 ARM request body(ies) collected");
    expect(text).not.toContain("DCE:");
  });
});

describe("batchTemplatesArtifactName", () => {
  it("composes workspace and job id into one deterministic JSON name", () => {
    expect(batchTemplatesArtifactName("law-prod", "job-7")).toBe(
      "arm-templates-law-prod-job-7.json",
    );
  });

  it("sanitizes path separators and other unsafe characters", () => {
    // ArtifactSink names are bare file names; adapters reject separators.
    expect(batchTemplatesArtifactName("law/prod name", "id:1")).toBe(
      "arm-templates-law_prod_name-id_1.json",
    );
  });

  it("never emits an empty part", () => {
    expect(batchTemplatesArtifactName("", "")).toBe(
      "arm-templates-batch-batch.json",
    );
  });
});

describe("buildTemplatesArtifact", () => {
  const templates: CollectedArmRequest[] = [
    {
      kind: "custom-table",
      table: "MyApp_CL",
      artifactName: "MyApp_CL.json",
      method: "PUT",
      path: "/subscriptions/s/resourceGroups/r/providers/Microsoft.OperationalInsights/workspaces/w/tables/MyApp_CL",
      apiVersion: "2022-10-01",
      body: { properties: { plan: "Analytics" } },
    },
    {
      kind: "dcr",
      table: "MyApp_CL",
      artifactName: "dcr-MyApp-eastus.json",
      method: "PUT",
      path: "/subscriptions/s/resourceGroups/r/providers/Microsoft.Insights/dataCollectionRules/dcr-MyApp-eastus",
      apiVersion: "2023-03-11",
      body: { location: "eastus" },
    },
  ];

  it("serializes every collected request with its ARM addressing intact", () => {
    const parsed = JSON.parse(buildTemplatesArtifact(templates)) as {
      kind: string;
      templates: CollectedArmRequest[];
    };
    expect(parsed.kind).toBe("onboard-batch-arm-templates");
    expect(parsed.templates).toHaveLength(2);
    expect(parsed.templates[0].path).toBe(templates[0].path);
    expect(parsed.templates[0].apiVersion).toBe("2022-10-01");
    expect(parsed.templates[1].body).toEqual({ location: "eastus" });
    // Collection order is preserved (custom-table PUT before its DCR).
    expect(parsed.templates.map((t) => t.kind)).toEqual([
      "custom-table",
      "dcr",
    ]);
  });

  it("is deterministic (no timestamps, no random ids)", () => {
    expect(buildTemplatesArtifact(templates)).toBe(
      buildTemplatesArtifact(templates),
    );
  });
});

function batchRecordFixture(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-3",
    kind: "onboard-batch",
    status: "failed",
    input: {
      tables: [{ table: "SecurityEvent" }, { table: "Syslog" }, { table: "Bad_CL" }],
      options: { templateOnly: false },
    },
    result: outcomeFixture(),
    error: "1 of 3 table(s) failed",
    steps: [
      { name: "fetch-workspace", status: "succeeded", detail: "location eastus" },
      { name: "table:SecurityEvent", status: "succeeded" },
      { name: "table:Syslog", status: "skipped", detail: "already exists" },
      { name: "table:Bad_CL", status: "failed", detail: "HTTP 400 {}" },
    ],
    createdAt: "2026-07-03T10:00:00.000Z",
    updatedAt: "2026-07-03T10:01:00.000Z",
    ...overrides,
  };
}

describe("batchRunLabel / batchRunDetail", () => {
  it("labels a batch record with its table count and terminal status", () => {
    expect(batchRunLabel(batchRecordFixture())).toBe(
      "2026-07-03T10:01:00.000Z  batch: 3 table(s)  [failed]",
    );
  });

  it("marks templateOnly records in the label", () => {
    const job = batchRecordFixture({
      input: { tables: [{ table: "A" }], options: { templateOnly: true } },
      status: "succeeded",
    });
    expect(batchRunLabel(job)).toBe(
      "2026-07-03T10:01:00.000Z  batch: 1 table(s) (templateOnly)  [succeeded]",
    );
  });

  it("tolerates a malformed persisted input", () => {
    const job = batchRecordFixture({ input: null });
    expect(batchRunLabel(job)).toBe(
      "2026-07-03T10:01:00.000Z  batch  [failed]",
    );
  });

  it("details steps, the combined summary, and the error line", () => {
    const detail = batchRunDetail(batchRecordFixture());
    expect(detail).toContain("[succeeded] fetch-workspace - location eastus");
    expect(detail).toContain("[skipped]   table:Syslog - already exists");
    expect(detail).toContain("1 deployed, 1 skipped, 1 failed (of 3 table(s))");
    expect(detail).toContain("error: 1 of 3 table(s) failed");
  });

  it("omits the summary when no result was persisted yet", () => {
    const detail = batchRunDetail(
      batchRecordFixture({ result: undefined, error: undefined }),
    );
    expect(detail).toContain("[succeeded] fetch-workspace");
    expect(detail).not.toContain("deployed,");
    expect(detail).not.toContain("error:");
  });
});
