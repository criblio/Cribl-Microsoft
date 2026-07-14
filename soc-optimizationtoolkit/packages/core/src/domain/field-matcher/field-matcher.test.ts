/**
 * field-matcher unit tests - porting-plan Unit 13.
 *
 * Ports the legacy field-matcher.test.ts "matching strategies" and "overflow
 * config" blocks and adds pins for the substring guards, the actual-sample-
 * casing rule, the 'in' reserved-word overflow-by-design behavior, the exported
 * (still-unused) VALUE_NORMALIZATIONS, and the missing-overflow-field warning.
 */

import { describe, expect, it } from "vitest";
import {
  matchFields,
  getOverflowConfig,
  VALUE_NORMALIZATIONS,
} from "./index";

describe("matching strategies (legacy field-matcher.test.ts)", () => {
  it("exact match scores highest", () => {
    const result = matchFields(
      [{ name: "SourceIP", type: "string" }],
      [
        { name: "SourceIP", type: "string" },
        { name: "src", type: "string" },
      ],
    );
    expect(result.matched[0].sourceName).toBe("SourceIP");
    expect(result.matched[0].destName).toBe("SourceIP");
    expect(result.matched[0].confidence).toBe("exact");
  });

  it("alias match works for known abbreviations", () => {
    const result = matchFields(
      [{ name: "src", type: "string" }],
      [{ name: "SourceIP", type: "string" }],
    );
    expect(result.matched.length).toBe(1);
    expect(result.matched[0].destName).toBe("SourceIP");
    expect(result.matched[0].confidence).toBe("alias");
  });

  it("case-insensitive match works", () => {
    const result = matchFields(
      [{ name: "sourceip", type: "string" }],
      [{ name: "SourceIP", type: "string" }],
    );
    expect(result.matched.length).toBe(1);
    expect(result.matched[0].confidence).toBe("exact");
  });

  it("detects type coercion needs", () => {
    const result = matchFields(
      [{ name: "count", type: "string" }],
      [{ name: "count", type: "int" }],
    );
    expect(result.matched[0].needsCoercion).toBe(true);
    expect(result.matched[0].action).toBe("coerce");
  });

  it("routes unmatched fields to overflow", () => {
    const result = matchFields(
      [{ name: "vendorSpecificField", type: "string" }],
      [{ name: "TimeGenerated", type: "datetime" }],
      undefined,
      "Custom_CL",
    );
    expect(result.overflow.length).toBe(1);
    expect(result.overflow[0].sourceName).toBe("vendorSpecificField");
  });
});

describe("overflow config (legacy field-matcher.test.ts)", () => {
  it("uses AdditionalData_d for _CL tables", () => {
    const cfg = getOverflowConfig("CrowdStrike_DNS_Events_CL");
    expect(cfg.fieldName).toBe("AdditionalData_d");
    expect(cfg.fieldType).toBe("dynamic");
  });

  it("uses AdditionalExtensions for CommonSecurityLog", () => {
    const cfg = getOverflowConfig("CommonSecurityLog");
    expect(cfg.fieldName).toBe("AdditionalExtensions");
    expect(cfg.fieldType).toBe("string");
  });

  it("uses EventData for WindowsEvent", () => {
    const cfg = getOverflowConfig("WindowsEvent");
    expect(cfg.fieldName).toBe("EventData");
    expect(cfg.fieldType).toBe("dynamic");
  });

  it("uses AdditionalFields_d for CloudflareV2_CL (specific over _CL default)", () => {
    const cfg = getOverflowConfig("CloudflareV2_CL");
    expect(cfg.fieldName).toBe("AdditionalFields_d");
    expect(cfg.fieldType).toBe("dynamic");
  });
});

describe("substring guards", () => {
  it("vendor-prefixed source cannot fuzzy-claim a standard column", () => {
    const result = matchFields(
      [{ name: "PanOSIsNonStandardDestinationPort", type: "string" }],
      [{ name: "DestinationPort", type: "int" }],
      undefined,
      "CommonSecurityLog",
    );
    // Must NOT be matched to DestinationPort via substring containment.
    expect(
      result.matched.find((m) => m.destName === "DestinationPort"),
    ).toBeUndefined();
  });

  it("a *Label source cannot claim a non-Label standard column", () => {
    const result = matchFields(
      [{ name: "imageFileNameLabel", type: "string" }],
      [{ name: "FileName", type: "string" }],
      undefined,
      "CommonSecurityLog",
    );
    expect(
      result.matched.find((m) => m.destName === "FileName"),
    ).toBeUndefined();
  });
});

describe("actual-sample-casing rule (Cribl renames are case-sensitive)", () => {
  it("uses the real source-field casing even when a vendor mapping differs", () => {
    const result = matchFields(
      [{ name: "loginSessionId", type: "string" }],
      [{ name: "SessionId", type: "string" }],
      [
        {
          sourceName: "LoginSessionId", // vendor-doc casing
          destName: "SessionId",
          sourceType: "string",
          destType: "string",
          action: "rename",
        },
      ],
    );
    expect(result.matched).toHaveLength(1);
    // The matched output name must be the ACTUAL field casing, not the doc casing.
    expect(result.matched[0].sourceName).toBe("loginSessionId");
    expect(result.matched[0].destName).toBe("SessionId");
    expect(result.matched[0].action).toBe("rename");
  });
});

describe("'in' reserved-word overflow-by-design", () => {
  it("'out' aliases to SentBytes but 'in' has no alias and overflows", () => {
    const result = matchFields(
      [
        { name: "out", type: "int" },
        { name: "in", type: "int" },
      ],
      [{ name: "SentBytes", type: "int" }],
      undefined,
      "CommonSecurityLog",
    );
    // 'out' is an alias for SentBytes.
    expect(result.matched.find((m) => m.sourceName === "out")?.destName).toBe(
      "SentBytes",
    );
    // 'in' is a JS reserved word, deliberately absent from ALIAS_TABLE, so it
    // is routed to overflow rather than matched or dropped.
    expect(result.matched.find((m) => m.sourceName === "in")).toBeUndefined();
    expect(
      result.overflow.find((o) => o.sourceName === "in"),
    ).toBeDefined();
  });
});

describe("coalesce priority", () => {
  it("prefers 'timestamp' over 'rt' for TimeGenerated", () => {
    const result = matchFields(
      [
        { name: "rt", type: "string" },
        { name: "timestamp", type: "string" },
      ],
      [{ name: "TimeGenerated", type: "datetime" }],
    );
    const tg = result.matched.find((m) => m.destName === "TimeGenerated");
    expect(tg?.sourceName).toBe("timestamp");
  });
});

describe("missing-overflow-field warning (fix + pin)", () => {
  it("warns when overflow fields exist but the overflow column is absent", () => {
    const result = matchFields(
      [{ name: "vendorOnlyField", type: "string" }],
      [{ name: "TimeGenerated", type: "datetime" }],
      undefined,
      "SomeVendor_CL", // _CL default overflow column is AdditionalData_d (absent here)
    );
    expect(result.overflow.length).toBe(1);
    expect(result.overflowConfig.enabled).toBe(false);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("AdditionalData_d");
  });

  it("does NOT warn when the overflow column is present in the schema", () => {
    const result = matchFields(
      [{ name: "vendorOnlyField", type: "string" }],
      [
        { name: "TimeGenerated", type: "datetime" },
        { name: "AdditionalData_d", type: "dynamic" },
      ],
      undefined,
      "SomeVendor_CL",
    );
    expect(result.overflow.length).toBe(1);
    expect(result.overflowConfig.enabled).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});

describe("VALUE_NORMALIZATIONS (exported, still unused)", () => {
  it("carries the curated DeviceAction/LogSeverity dictionaries verbatim", () => {
    expect(VALUE_NORMALIZATIONS.DeviceAction.allow).toBe("Allow");
    expect(VALUE_NORMALIZATIONS.DeviceAction.deny).toBe("Deny");
    expect(VALUE_NORMALIZATIONS.LogSeverity.critical).toBe("10");
    expect(VALUE_NORMALIZATIONS.Protocol["6"]).toBe("TCP");
    expect(VALUE_NORMALIZATIONS.EventOutcome.success).toBe("Success");
  });
});
