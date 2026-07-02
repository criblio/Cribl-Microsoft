/**
 * Unit tests for the DCR/DCE naming compatibility contract, organized by
 * spec step so they read as documentation of the legacy behavior
 * (Create-TableDCRs.ps1 lines 2548-2631 and 2667-2668).
 *
 * The exhaustive legacy pin is dcr-naming.characterization.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  DCE_DCR_NAME_MAX_LENGTH,
  DIRECT_DCR_NAME_MAX_LENGTH,
  DIRECT_DCR_TABLE_ABBREVIATIONS,
  DcrNamingError,
  generateDcrName,
  stripCustomTableSuffix,
} from "./index";

describe("STEP 0: custom table _CL suffix stripping", () => {
  it("removes one trailing _CL from a custom table", () => {
    const result = generateDcrName({
      table: "CloudFlare_CL",
      mode: "direct",
      prefix: "dcr-",
      location: "eastus",
      isCustomTable: true,
    });
    expect(result.name).toBe("dcr-CloudFlare-eastus");
  });

  it("matches the _CL suffix case-insensitively", () => {
    expect(stripCustomTableSuffix("MYTABLE_cl")).toBe("MYTABLE");
    const result = generateDcrName({
      table: "MYTABLE_cl",
      mode: "direct",
      prefix: "dcr-",
      location: "eastus",
      isCustomTable: true,
    });
    expect(result.name).toBe("dcr-MYTABLE-eastus");
  });

  it("removes only the LAST _CL occurrence", () => {
    expect(stripCustomTableSuffix("MyApp_CL_CL")).toBe("MyApp_CL");
    const result = generateDcrName({
      table: "MyApp_CL_CL",
      mode: "direct",
      prefix: "dcr-",
      location: "eastus",
      isCustomTable: true,
    });
    expect(result.name).toBe("dcr-MyApp_CL-eastus");
  });

  it("leaves a custom table without the suffix unchanged", () => {
    const result = generateDcrName({
      table: "CloudFlare",
      mode: "direct",
      prefix: "dcr-",
      location: "eastus",
      isCustomTable: true,
    });
    expect(result.name).toBe("dcr-CloudFlare-eastus");
  });

  it("only strips _CL at the end of the string, never mid-string", () => {
    expect(stripCustomTableSuffix("My_CLApp")).toBe("My_CLApp");
  });

  it("never strips _CL from native tables (isCustomTable false)", () => {
    const result = generateDcrName({
      table: "Fake_CL",
      mode: "direct",
      prefix: "dcr-",
      location: "eastus",
      isCustomTable: false,
    });
    expect(result.name).toBe("dcr-Fake_CL-eastus");
  });

  it("treats isCustomTable as false when omitted", () => {
    const result = generateDcrName({
      table: "Fake_CL",
      mode: "direct",
      prefix: "dcr-",
      location: "eastus",
    });
    expect(result.name).toBe("dcr-Fake_CL-eastus");
  });
});

describe("STEP 1: composition (prefix + table + '-' + location [+ '-' + suffix])", () => {
  it("concatenates the prefix VERBATIM with no inserted separator", () => {
    const result = generateDcrName({
      table: "Event",
      mode: "direct",
      prefix: "dcrX",
      location: "eastus",
    });
    expect(result.name).toBe("dcrXEvent-eastus");
  });

  it("relies on the default prefix carrying its own trailing hyphen", () => {
    const result = generateDcrName({
      table: "Event",
      mode: "direct",
      prefix: "dcr-",
      location: "eastus",
    });
    expect(result.name).toBe("dcr-Event-eastus");
  });

  it("always inserts a hyphen before the location", () => {
    const result = generateDcrName({
      table: "Syslog",
      mode: "direct",
      prefix: "dcr-",
      location: "westeurope",
    });
    expect(result.name).toBe("dcr-Syslog-westeurope");
  });

  it("appends a present suffix after a hyphen", () => {
    const result = generateDcrName({
      table: "Event",
      mode: "direct",
      prefix: "dcr-",
      suffix: "prod",
      location: "eastus",
    });
    expect(result.name).toBe("dcr-Event-eastus-prod");
  });

  it("treats an empty suffix as absent", () => {
    const result = generateDcrName({
      table: "Event",
      mode: "direct",
      prefix: "dcr-",
      suffix: "",
      location: "eastus",
    });
    expect(result.name).toBe("dcr-Event-eastus");
  });

  it("treats a whitespace-only suffix as absent (IsNullOrWhiteSpace)", () => {
    for (const suffix of [" ", "   ", "\t", "\n"]) {
      const result = generateDcrName({
        table: "SecurityEvent",
        mode: "direct",
        prefix: "dcr-",
        suffix,
        location: "eastus",
      });
      expect(result.name).toBe("dcr-SecurityEvent-eastus");
    }
  });

  it("treats a null or omitted suffix as absent", () => {
    const withNull = generateDcrName({
      table: "Event",
      mode: "direct",
      prefix: "dcr-",
      suffix: null,
      location: "eastus",
    });
    const omitted = generateDcrName({
      table: "Event",
      mode: "direct",
      prefix: "dcr-",
      location: "eastus",
    });
    expect(withNull.name).toBe("dcr-Event-eastus");
    expect(omitted.name).toBe("dcr-Event-eastus");
  });
});

describe("dce-endpoint mode: STEP 1 result returned as-is, no limit ever", () => {
  it("emits a 75-char endpoint name unchanged (no 64-char enforcement)", () => {
    const result = generateDcrName({
      table: "EnterpriseSecurityTelemetryAggregationPipelineExtendedForTesting_CL",
      mode: "dce-endpoint",
      prefix: "dce-",
      location: "eastus",
      isCustomTable: true,
    });
    expect(result.name).toBe(
      "dce-EnterpriseSecurityTelemetryAggregationPipelineExtendedForTesting-eastus",
    );
    expect(result.name.length).toBeGreaterThan(DCE_DCR_NAME_MAX_LENGTH);
  });

  it("still strips _CL from custom tables (STEP 0 applies to all modes)", () => {
    const result = generateDcrName({
      table: "CloudFlare_CL",
      mode: "dce-endpoint",
      prefix: "dce-",
      location: "eastus",
      isCustomTable: true,
    });
    expect(result.name).toBe("dce-CloudFlare-eastus");
  });

  it("does NOT trim hyphens (unlike direct/dce)", () => {
    const result = generateDcrName({
      table: "X",
      mode: "dce-endpoint",
      prefix: "dce-",
      location: "",
    });
    expect(result.name).toBe("dce-X-");
  });

  it("does NOT enforce the 3-character minimum", () => {
    const result = generateDcrName({
      table: "",
      mode: "dce-endpoint",
      prefix: "",
      location: "",
    });
    expect(result.name).toBe("-");
  });

  it("never reports wasAbbreviated", () => {
    const result = generateDcrName({
      table: "EnterpriseSecurityTelemetryAggregationPipelineExtendedForTesting_CL",
      mode: "dce-endpoint",
      prefix: "dce-",
      location: "eastus",
      isCustomTable: true,
    });
    expect(result.wasAbbreviated).toBe(false);
  });
});

describe("STEP 2: limit gate (30 direct / 64 dce); within limit nothing happens", () => {
  it("leaves a direct name of exactly 30 characters unchanged", () => {
    const result = generateDcrName({
      table: "DeviceNetworkEvents",
      mode: "direct",
      prefix: "dcr-",
      location: "eastus",
    });
    expect(result.name).toBe("dcr-DeviceNetworkEvents-eastus");
    expect(result.name.length).toBe(DIRECT_DCR_NAME_MAX_LENGTH);
  });

  it("abbreviates a direct name at 31 characters", () => {
    const result = generateDcrName({
      table: "DeviceNetworkEventsA",
      mode: "direct",
      prefix: "dcr-",
      location: "eastus",
    });
    expect(result.name).toBe("dcr-Device-eastus");
  });

  it("does NOT consult the dictionary when the name fits", () => {
    // dcr-CommonSecurityLog-eastus is 28 chars, so no CSL abbreviation.
    const result = generateDcrName({
      table: "CommonSecurityLog",
      mode: "direct",
      prefix: "dcr-",
      location: "eastus",
    });
    expect(result.name).toBe("dcr-CommonSecurityLog-eastus");
  });

  it("leaves a dce name of exactly 64 characters unchanged", () => {
    const result = generateDcrName({
      table: "T".repeat(53),
      mode: "dce",
      prefix: "dcr-",
      location: "eastus",
    });
    expect(result.name).toBe(`dcr-${"T".repeat(53)}-eastus`);
    expect(result.name.length).toBe(DCE_DCR_NAME_MAX_LENGTH);
  });
});

describe("STEP 3: dce mode over limit truncates the table segment", () => {
  it("truncates the table so the recomposed name is exactly 64 chars", () => {
    const result = generateDcrName({
      table: "T".repeat(54),
      mode: "dce",
      prefix: "dcr-",
      location: "eastus",
    });
    expect(result.name).toBe(`dcr-${"T".repeat(53)}-eastus`);
    expect(result.name.length).toBe(DCE_DCR_NAME_MAX_LENGTH);
  });

  it("shrinks the table budget when a suffix is present", () => {
    const result = generateDcrName({
      table: "EnterpriseSecurityTelemetryAggregationPipelineExtendedForTesting_CL",
      mode: "dce",
      prefix: "dcr-",
      suffix: "prod",
      location: "eastus",
      isCustomTable: true,
    });
    expect(result.name).toBe(
      "dcr-EnterpriseSecurityTelemetryAggregationPipelineEx-eastus-prod",
    );
    expect(result.name.length).toBe(DCE_DCR_NAME_MAX_LENGTH);
  });

  it("allows a zero table budget (table segment becomes empty)", () => {
    const prefix = "p".repeat(57); // 64 - 57 - 6 - 1 = 0
    const result = generateDcrName({
      table: "Table",
      mode: "dce",
      prefix,
      location: "eastus",
    });
    expect(result.name).toBe(`${prefix}-eastus`);
    expect(result.name.length).toBe(DCE_DCR_NAME_MAX_LENGTH);
  });

  it("throws when prefix + location + suffix alone exceed the budget (preserved legacy defect)", () => {
    expect(() =>
      generateDcrName({
        table: "Table",
        mode: "dce",
        prefix: "p".repeat(60), // 64 - 60 - 6 - 1 = -3
        location: "eastus",
      }),
    ).toThrow(DcrNamingError);
  });
});

describe("STEP 4: direct mode over limit abbreviates the table", () => {
  it("carries all six dictionary entries", () => {
    expect(DIRECT_DCR_TABLE_ABBREVIATIONS).toEqual({
      CommonSecurityLog: "CSL",
      SecurityEvent: "SecEvt",
      WindowsEvent: "WinEvt",
      Syslog: "Syslog",
      DeviceEvents: "DevEvt",
      BehaviorAnalytics: "BehAna",
    });
  });

  it.each([
    ["CommonSecurityLog", "dcr-CSL-eastus-production"],
    ["SecurityEvent", "dcr-SecEvt-eastus-production"],
    ["WindowsEvent", "dcr-WinEvt-eastus-production"],
    ["DeviceEvents", "dcr-DevEvt-eastus-production"],
    ["BehaviorAnalytics", "dcr-BehAna-eastus-production"],
  ])("abbreviates %s via the dictionary once over the limit", (table, expected) => {
    const result = generateDcrName({
      table,
      mode: "direct",
      prefix: "dcr-",
      suffix: "production",
      location: "eastus",
    });
    expect(result.name).toBe(expected);
  });

  it("applies the Syslog identity mapping (long prefix forces the gate)", () => {
    const result = generateDcrName({
      table: "Syslog",
      mode: "direct",
      prefix: "dcr-verylongprefixname-",
      location: "eastus",
    });
    // Recomposed 36 chars -> hard cut at 30 lands on a hyphen -> TrimEnd.
    expect(result.name).toBe("dcr-verylongprefixname-Syslog");
  });

  it("matches the dictionary case-insensitively and emits the canonical casing", () => {
    const lower = generateDcrName({
      table: "commonsecuritylog",
      mode: "direct",
      prefix: "dcr-",
      suffix: "production",
      location: "eastus",
    });
    expect(lower.name).toBe("dcr-CSL-eastus-production");

    const upper = generateDcrName({
      table: "SYSLOG",
      mode: "direct",
      prefix: "dcr-verylongprefixname-",
      location: "eastus",
    });
    expect(upper.name).toBe("dcr-verylongprefixname-Syslog");
  });

  it("falls back to the first 6 characters for unknown tables (no CamelCase logic)", () => {
    const result = generateDcrName({
      table: "AnyTable12",
      mode: "direct",
      prefix: "dcr-cribl-",
      suffix: "prod",
      location: "eastus",
    });
    expect(result.name).toBe("dcr-cribl-AnyTab-eastus-prod");
  });

  it("lets different tables collide onto the same generated name", () => {
    const shared = { mode: "direct", prefix: "dcr-cribl-", suffix: "prod", location: "eastus" } as const;
    const audit = generateDcrName({ ...shared, table: "ASimAuditEventLogs" });
    const auth = generateDcrName({ ...shared, table: "ASimAuthenticationEventLogs" });
    expect(audit.name).toBe("dcr-cribl-ASimAu-eastus-prod");
    expect(auth.name).toBe("dcr-cribl-ASimAu-eastus-prod");
  });

  it("hard-cuts a still-too-long recomposed name to 30, even mid-prefix", () => {
    const result = generateDcrName({
      table: "AnyTable",
      mode: "direct",
      prefix: "dcr-extremely-long-prefix-name-here-",
      location: "eastus",
    });
    expect(result.name).toBe("dcr-extremely-long-prefix-name");
    expect(result.name.length).toBe(DIRECT_DCR_NAME_MAX_LENGTH);
  });

  it("strips trailing hyphens left by the 30-char hard cut", () => {
    // 23-char prefix + "Syslog" = 29, so the cut at 30 lands on the
    // hyphen before the location.
    const result = generateDcrName({
      table: "Syslog",
      mode: "direct",
      prefix: "dcr-verylongprefixname-",
      location: "eastus",
    });
    expect(result.name).toBe("dcr-verylongprefixname-Syslog");
    expect(result.name.endsWith("-")).toBe(false);
  });
});

describe("STEP 5: final Trim('-') always runs for direct and dce", () => {
  it("strips leading hyphens even when the name never exceeded the limit", () => {
    const result = generateDcrName({
      table: "X",
      mode: "direct",
      prefix: "-dcr-",
      location: "eastus",
    });
    expect(result.name).toBe("dcr-X-eastus");
  });

  it("strips trailing hyphens even when the name never exceeded the limit", () => {
    const result = generateDcrName({
      table: "X",
      mode: "direct",
      prefix: "dcr-",
      location: "",
    });
    expect(result.name).toBe("dcr-X");
  });

  it("applies to dce mode as well", () => {
    const result = generateDcrName({
      table: "X",
      mode: "dce",
      prefix: "-dcr-",
      location: "eastus",
    });
    expect(result.name).toBe("dcr-X-eastus");
  });
});

describe("STEP 6: minimum length validation", () => {
  it("throws the legacy error when the final name is shorter than 3 chars", () => {
    expect(() =>
      generateDcrName({
        table: "A",
        mode: "direct",
        prefix: "",
        location: "",
      }),
    ).toThrow("DCR name 'A' is too short (minimum 3 characters required)");
  });

  it("throws a DcrNamingError instance", () => {
    expect(() =>
      generateDcrName({
        table: "A",
        mode: "direct",
        prefix: "",
        location: "",
      }),
    ).toThrow(DcrNamingError);
  });

  it("accepts a final name of exactly 3 characters", () => {
    const result = generateDcrName({
      table: "Abc",
      mode: "direct",
      prefix: "",
      location: "",
    });
    expect(result.name).toBe("Abc");
  });
});

describe("wasAbbreviated flag (legacy UI warning, not part of the name)", () => {
  it("is false when the composed name fits", () => {
    const result = generateDcrName({
      table: "CommonSecurityLog",
      mode: "direct",
      prefix: "dcr-",
      location: "eastus",
    });
    expect(result.wasAbbreviated).toBe(false);
  });

  it("is true when a direct name exceeded 30 chars", () => {
    const result = generateDcrName({
      table: "DeviceNetworkEventsA",
      mode: "direct",
      prefix: "dcr-",
      location: "eastus",
    });
    expect(result.wasAbbreviated).toBe(true);
  });

  it("is true when a dce name exceeded 64 chars", () => {
    const result = generateDcrName({
      table: "T".repeat(54),
      mode: "dce",
      prefix: "dcr-",
      location: "eastus",
    });
    expect(result.wasAbbreviated).toBe(true);
  });
});
