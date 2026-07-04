/**
 * Tests for the Review screen's pure decisions (porting-plan Unit 7,
 * ux-flow-plan 5.2): row derivation from the core DeploymentPreview result,
 * the staleness predicate over the inputs token, and the acknowledge-gate
 * arming cascade for the Deploy handoff.
 *
 * Truth decisions (names, existence, request bodies) are the core usecase's
 * and are pinned by its own tests (including the dcr-naming legacy vectors
 * and the shared-prefix collision cases); these tests cover only the
 * display/gate derivations this module owns.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_OPERATION_OPTIONS } from "@soc/core";
import type {
  DeploymentPreview,
  DeploymentPreviewTable,
  DeploymentPreviewTableSpec,
  PreviewArmRequest,
} from "@soc/core";
import {
  HANDOFF_CHECKING_REASON,
  HANDOFF_NEEDS_ACKNOWLEDGE_REASON,
  HANDOFF_NEEDS_PREVIEW_REASON,
  HANDOFF_STALE_REASON,
  checkActionLabel,
  deriveDeployHandoff,
  deriveReviewRows,
  formatReviewSummary,
  isPreviewStale,
  previewOptionsOf,
  reviewCounts,
  reviewInputsToken,
} from "./review-state";
import type { DeployHandoffInput, ReviewScope } from "./review-state";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCOPE: ReviewScope = {
  subscriptionId: "sub-1",
  resourceGroup: "rg-sentinel",
  workspaceName: "law-prod",
};

const PREVIEW_OPTIONS = previewOptionsOf(DEFAULT_OPERATION_OPTIONS);

function armRequest(path: string): PreviewArmRequest {
  return {
    method: "PUT",
    path,
    apiVersion: "2023-03-11",
    body: { properties: { note: `body for ${path}` } },
  };
}

/** A native table whose DCR already exists, fully enriched. */
const NATIVE_EXISTING: DeploymentPreviewTable = {
  table: "SecurityEvent",
  kind: "native",
  dcrName: "dcr-securityevent-eastus2",
  tableResource: null,
  dcrResource: {
    exists: true,
    request: armRequest("/subs/s/rg/r/dcr/dcr-securityevent-eastus2"),
    immutableId: "dcr-abc123",
    ingestionEndpoint: "https://x.eastus2-1.ingest.monitor.azure.com",
  },
};

/** A custom table that does not exist yet: table PUT + DCR PUT. */
const CUSTOM_NEW: DeploymentPreviewTable = {
  table: "CloudFlare_CL",
  kind: "custom",
  dcrName: "dcr-cloudflare-eastus2",
  tableResource: {
    exists: false,
    request: armRequest("/subs/s/rg/r/ws/w/tables/CloudFlare_CL"),
  },
  dcrResource: {
    exists: false,
    request: armRequest("/subs/s/rg/r/dcr/dcr-cloudflare-eastus2"),
  },
};

/** A custom table that exists (creation skipped) with a failed detail GET. */
const CUSTOM_EXISTING_DETAIL_ERROR: DeploymentPreviewTable = {
  table: "CrowdStrike_CL",
  kind: "custom",
  dcrName: "dcr-crowdstrike-eastus2",
  tableResource: { exists: true, request: null },
  dcrResource: {
    exists: true,
    request: armRequest("/subs/s/rg/r/dcr/dcr-crowdstrike-eastus2"),
    detailError: "fetch DCR 'dcr-crowdstrike-eastus2': HTTP 503 {}",
  },
};

function directPreview(
  tables: DeploymentPreviewTable[] = [NATIVE_EXISTING, CUSTOM_NEW],
): DeploymentPreview {
  return {
    generatedAtToken: "2026-07-04T12:00:00.000Z",
    subscriptionId: SCOPE.subscriptionId,
    resourceGroup: SCOPE.resourceGroup,
    workspaceName: SCOPE.workspaceName,
    location: "eastus2",
    mode: "direct",
    dce: null,
    tables,
  };
}

function dcePreview(dceExists: boolean): DeploymentPreview {
  return {
    ...directPreview(),
    mode: "dce",
    dce: {
      name: "dce-law-prod-eastus2",
      exists: dceExists,
      resourceId: "/subs/s/rg/r/dce/dce-law-prod-eastus2",
      request: dceExists
        ? null
        : armRequest("/subs/s/rg/r/dce/dce-law-prod-eastus2"),
    },
  };
}

const SPECS: DeploymentPreviewTableSpec[] = [
  { table: "SecurityEvent" },
  {
    table: "CloudFlare_CL",
    customSchema: [
      { name: "TimeGenerated", type: "datetime" },
      { name: "ClientIP", type: "string" },
    ],
  },
];

// ---------------------------------------------------------------------------
// previewOptionsOf
// ---------------------------------------------------------------------------

describe("previewOptionsOf", () => {
  it("projects exactly the three preview-relevant fields", () => {
    expect(previewOptionsOf(DEFAULT_OPERATION_OPTIONS)).toEqual({
      createDCE: DEFAULT_OPERATION_OPTIONS.createDCE,
      customTableRetentionDays:
        DEFAULT_OPERATION_OPTIONS.customTableRetentionDays,
      dcePublicNetworkAccess:
        DEFAULT_OPERATION_OPTIONS.dcePublicNetworkAccess,
    });
  });

  it("ignores templateOnly and skipExistingDCRs - a preview is read-only and reports existence as fact", () => {
    const base = previewOptionsOf(DEFAULT_OPERATION_OPTIONS);
    const flipped = previewOptionsOf({
      ...DEFAULT_OPERATION_OPTIONS,
      templateOnly: !DEFAULT_OPERATION_OPTIONS.templateOnly,
      skipExistingDCRs: !DEFAULT_OPERATION_OPTIONS.skipExistingDCRs,
    });
    expect(flipped).toEqual(base);
  });
});

// ---------------------------------------------------------------------------
// Staleness token and predicate
// ---------------------------------------------------------------------------

describe("reviewInputsToken", () => {
  it("is deterministic for equal inputs", () => {
    expect(reviewInputsToken(SPECS, PREVIEW_OPTIONS, SCOPE)).toBe(
      reviewInputsToken(
        SPECS.map((s) => ({ ...s })),
        { ...PREVIEW_OPTIONS },
        { ...SCOPE },
      ),
    );
  });

  it("changes when a table is added, removed, or reordered (order is the batch's processing order)", () => {
    const base = reviewInputsToken(SPECS, PREVIEW_OPTIONS, SCOPE);
    expect(
      reviewInputsToken(SPECS.slice(0, 1), PREVIEW_OPTIONS, SCOPE),
    ).not.toBe(base);
    expect(
      reviewInputsToken([...SPECS, { table: "Syslog" }], PREVIEW_OPTIONS, SCOPE),
    ).not.toBe(base);
    expect(
      reviewInputsToken([...SPECS].reverse(), PREVIEW_OPTIONS, SCOPE),
    ).not.toBe(base);
  });

  it("changes when an attached custom schema's columns change", () => {
    const base = reviewInputsToken(SPECS, PREVIEW_OPTIONS, SCOPE);
    const changedSchema: DeploymentPreviewTableSpec[] = [
      SPECS[0] as DeploymentPreviewTableSpec,
      {
        table: "CloudFlare_CL",
        customSchema: [{ name: "TimeGenerated", type: "datetime" }],
      },
    ];
    expect(
      reviewInputsToken(changedSchema, PREVIEW_OPTIONS, SCOPE),
    ).not.toBe(base);
  });

  it("changes when a preview-relevant option or the scope changes", () => {
    const base = reviewInputsToken(SPECS, PREVIEW_OPTIONS, SCOPE);
    expect(
      reviewInputsToken(
        SPECS,
        { ...PREVIEW_OPTIONS, createDCE: !PREVIEW_OPTIONS.createDCE },
        SCOPE,
      ),
    ).not.toBe(base);
    expect(
      reviewInputsToken(SPECS, PREVIEW_OPTIONS, {
        ...SCOPE,
        workspaceName: "law-other",
      }),
    ).not.toBe(base);
  });
});

describe("isPreviewStale", () => {
  const token = reviewInputsToken(SPECS, PREVIEW_OPTIONS, SCOPE);

  it("is never stale with no preview (the gate names that case separately)", () => {
    expect(isPreviewStale(null, token)).toBe(false);
  });

  it("is fresh while the current inputs match the generated ones", () => {
    expect(isPreviewStale({ inputsToken: token }, token)).toBe(false);
  });

  it("flips stale the moment any input changes after generation", () => {
    const drifted = reviewInputsToken(
      SPECS,
      { ...PREVIEW_OPTIONS, createDCE: !PREVIEW_OPTIONS.createDCE },
      SCOPE,
    );
    expect(isPreviewStale({ inputsToken: token }, drifted)).toBe(true);
  });

  it("returns to fresh when the inputs are reverted to exactly what was reviewed", () => {
    const reverted = reviewInputsToken(
      SPECS.map((s) => ({ ...s })),
      { ...PREVIEW_OPTIONS },
      { ...SCOPE },
    );
    expect(isPreviewStale({ inputsToken: token }, reverted)).toBe(false);
  });
});

describe("checkActionLabel", () => {
  it("relabels to Re-check once a preview exists (legacy Analyze/Re-Analyze pattern)", () => {
    expect(checkActionLabel(false)).toBe("Check resources");
    expect(checkActionLabel(true)).toBe("Re-check");
  });
});

// ---------------------------------------------------------------------------
// Row derivation
// ---------------------------------------------------------------------------

describe("deriveReviewRows", () => {
  it("orders rows: per table the TBL row (custom only) before its DCR row, preview order preserved", () => {
    const rows = deriveReviewRows(directPreview());
    expect(rows.map((r) => `${r.tag}:${r.name}`)).toEqual([
      "DCR:dcr-securityevent-eastus2",
      "TBL:CloudFlare_CL",
      "DCR:dcr-cloudflare-eastus2",
    ]);
  });

  it("maps existence to the verdict pills", () => {
    const rows = deriveReviewRows(directPreview());
    expect(rows.map((r) => r.verdict)).toEqual([
      "exists",
      "will-create",
      "will-create",
    ]);
  });

  it("carries immutableId and the VERBATIM ingestion endpoint for existing DCRs", () => {
    const [securityEvent] = deriveReviewRows(directPreview([NATIVE_EXISTING]));
    expect(securityEvent?.detailLines).toEqual([
      "immutableId: dcr-abc123",
      "ingestion endpoint: https://x.eastus2-1.ingest.monitor.azure.com",
    ]);
  });

  it("surfaces a failed per-match detail GET honestly on an existing row", () => {
    const rows = deriveReviewRows(
      directPreview([CUSTOM_EXISTING_DETAIL_ERROR]),
    );
    const dcr = rows.find((r) => r.tag === "DCR");
    expect(dcr?.verdict).toBe("exists");
    expect(dcr?.detailLines).toEqual([
      "detail fetch failed: fetch DCR 'dcr-crowdstrike-eastus2': HTTP 503 {}",
    ]);
  });

  it("attaches expandable request JSON that round-trips the ARM request, and none when nothing would be sent", () => {
    const rows = deriveReviewRows(
      directPreview([CUSTOM_NEW, CUSTOM_EXISTING_DETAIL_ERROR]),
    );
    const newTable = rows.find((r) => r.key === "tbl:CloudFlare_CL");
    expect(newTable?.requestJson).not.toBeNull();
    const parsed = JSON.parse(newTable?.requestJson ?? "") as {
      method: string;
      path: string;
      apiVersion: string;
      body: unknown;
    };
    expect(parsed.method).toBe("PUT");
    expect(parsed.path).toBe("/subs/s/rg/r/ws/w/tables/CloudFlare_CL");
    expect(parsed.apiVersion).toBe("2023-03-11");
    // Existing custom table: creation is skipped, nothing would be sent.
    const existingTable = rows.find((r) => r.key === "tbl:CrowdStrike_CL");
    expect(existingTable?.requestJson).toBeNull();
    // DCR rows always attach the request a run would send.
    for (const row of rows.filter((r) => r.tag === "DCR")) {
      expect(row.requestJson).not.toBeNull();
    }
  });

  it("puts the batch-shared DCE row first in DCE mode", () => {
    const rows = deriveReviewRows(dcePreview(false));
    expect(rows[0]?.tag).toBe("DCE");
    expect(rows[0]?.name).toBe("dce-law-prod-eastus2");
    expect(rows[0]?.verdict).toBe("will-create");
    expect(rows[0]?.requestJson).not.toBeNull();
    expect(rows[0]?.detailLines).toEqual([
      "resource id: /subs/s/rg/r/dce/dce-law-prod-eastus2",
    ]);
  });

  it("shows an existing DCE as reused with no request", () => {
    const [dce] = deriveReviewRows(dcePreview(true));
    expect(dce?.verdict).toBe("exists");
    expect(dce?.note).toContain("reuses");
    expect(dce?.requestJson).toBeNull();
  });

  it("emits no DCE row in direct mode", () => {
    const rows = deriveReviewRows(directPreview());
    expect(rows.some((r) => r.tag === "DCE")).toBe(false);
  });
});

describe("reviewCounts and formatReviewSummary", () => {
  it("counts exists vs will-create across all rows", () => {
    const rows = deriveReviewRows(dcePreview(true));
    // DCE exists, SecurityEvent DCR exists, CloudFlare TBL + DCR will create.
    expect(reviewCounts(rows)).toEqual({
      exists: 2,
      willCreate: 2,
      total: 4,
    });
  });

  it("formats the one-line summary", () => {
    expect(
      formatReviewSummary({ exists: 2, willCreate: 2, total: 4 }),
    ).toBe("2 to create, 2 already existing (4 resource(s) checked against live Azure)");
  });
});

// ---------------------------------------------------------------------------
// The acknowledge gate
// ---------------------------------------------------------------------------

describe("deriveDeployHandoff", () => {
  function input(overrides: Partial<DeployHandoffInput> = {}): DeployHandoffInput {
    return {
      journeyBlockedReason: null,
      hasPreview: true,
      stale: false,
      acknowledged: true,
      checking: false,
      ...overrides,
    };
  }

  it("arms only when prerequisites, a fresh preview, and the acknowledgement all hold", () => {
    expect(deriveDeployHandoff(input())).toEqual({
      armed: true,
      reason: null,
    });
  });

  it("puts the journey-state unlock hint first (identity/scope prerequisites outrank everything)", () => {
    const result = deriveDeployHandoff(
      input({
        journeyBlockedReason: "Commit an Azure target first.",
        hasPreview: false,
        acknowledged: false,
      }),
    );
    expect(result.armed).toBe(false);
    expect(result.reason).toBe("Commit an Azure target first.");
  });

  it("names generation-in-flight, then the missing preview", () => {
    expect(
      deriveDeployHandoff(input({ checking: true, hasPreview: false })).reason,
    ).toBe(HANDOFF_CHECKING_REASON);
    expect(deriveDeployHandoff(input({ hasPreview: false })).reason).toBe(
      HANDOFF_NEEDS_PREVIEW_REASON,
    );
  });

  it("disarms a STALE preview even when acknowledged - the acknowledgement never survives an input change", () => {
    const result = deriveDeployHandoff(input({ stale: true, acknowledged: true }));
    expect(result.armed).toBe(false);
    expect(result.reason).toBe(HANDOFF_STALE_REASON);
  });

  it("asks for the acknowledgement last, as the single remaining thing", () => {
    expect(deriveDeployHandoff(input({ acknowledged: false })).reason).toBe(
      HANDOFF_NEEDS_ACKNOWLEDGE_REASON,
    );
  });

  it("never arms while any single condition is missing", () => {
    const cases: Partial<DeployHandoffInput>[] = [
      { journeyBlockedReason: "x" },
      { checking: true },
      { hasPreview: false },
      { stale: true },
      { acknowledged: false },
    ];
    for (const overrides of cases) {
      expect(deriveDeployHandoff(input(overrides)).armed).toBe(false);
    }
  });
});
