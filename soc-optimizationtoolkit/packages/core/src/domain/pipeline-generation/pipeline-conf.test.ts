/**
 * generatePipelineConf builder - Unit 17 (b) - fixtures over IN-MEMORY outputs.
 *
 * Converts the assertions of legacy test-uat-transformations.ts TEST 5/9 (serde
 * selection, groupId presence, cleanup, timestamp, Type enrichment) to vitest,
 * built entirely from in-memory field mappings (no %APPDATA%, no repo files).
 * Also pins the CEF two-step extraction, the CEF indexOf(-1) guard, and the
 * reduction-before-rename step order.
 */

import { describe, it, expect } from "vitest";
import { generatePipelineConf } from "./pipeline-conf";
import { checkCriblYaml } from "./cribl-yaml-validator";
import type { PipelineFieldMapping } from "./models";
import type { OverflowConfig } from "../field-matcher";
import type { TableReductionRules } from "./reduction-rules";

const fdrFields: PipelineFieldMapping[] = [
  { source: "event_simpleName", target: "event_simpleName", type: "string", action: "keep" },
  { source: "CommandLine", target: "CommandLine", type: "string", action: "keep" },
  { source: "aid", target: "aid", type: "string", action: "keep" },
];

describe("serde selection per source format", () => {
  it("JSON/NDJSON -> serde type json", () => {
    const yaml = generatePipelineConf(
      "p",
      "CrowdStrike",
      "CrowdStrike_Process_Events_CL",
      fdrFields,
      undefined,
      "ndjson",
    );
    expect(yaml).toContain("id: serde");
    expect(yaml).toContain("type: json");
  });

  it("KV -> serde type kvp with delimiters", () => {
    const yaml = generatePipelineConf("p", "Fortinet", "Fortinet_CL", [], undefined, "kv");
    expect(yaml).toContain("type: kvp");
    expect(yaml).toContain('delimChar: " "');
    expect(yaml).toContain('pairDelim: "="');
  });

  it("LEEF -> serde kvp with a tab delimiter", () => {
    const yaml = generatePipelineConf("p", "IBM", "CommonSecurityLog", [], undefined, "leef");
    expect(yaml).toContain("type: kvp");
    expect(yaml).toContain('delimChar: "\\t"');
  });

  it("generic CSV -> serde type csv (no PAN-OS positional map)", () => {
    const yaml = generatePipelineConf("p", "Acme", "Acme_CL", [], undefined, "csv");
    expect(yaml).toContain("type: csv");
    expect(yaml).toContain("hasHeaderRow: false");
  });
});

describe("group structure and cleanup", () => {
  const yaml = generatePipelineConf(
    "p",
    "CrowdStrike",
    "CrowdStrike_Process_Events_CL",
    fdrFields,
    undefined,
    "ndjson",
  );

  it("has extract, enrich, and cleanup groups", () => {
    expect(yaml).toContain("groupId: extract");
    expect(yaml).toContain("groupId: enrich");
    expect(yaml).toContain("groupId: cleanup");
  });

  it("sets Type to the table name in the enrich group", () => {
    expect(yaml).toContain("name: Type");
    expect(yaml).toContain(`value: "'CrowdStrike_Process_Events_CL'"`);
  });

  it("cleanup removes Cribl metadata and transport fields", () => {
    expect(yaml).toContain("cribl_*");
    expect(yaml).toContain("__header*");
    expect(yaml).toContain("- _raw");
    expect(yaml).toContain("- sourcetype");
  });

  it("passes the checkCriblYaml core validator", () => {
    expect(checkCriblYaml(yaml, "conf.yml")).toEqual([]);
  });
});

describe("timestamp logic", () => {
  it("CrowdStrike FDR: eval-first with a backup auto_timestamp", () => {
    const yaml = generatePipelineConf(
      "p",
      "CrowdStrike Falcon",
      "CrowdStrike_Process_Events_CL",
      fdrFields,
      undefined,
      "ndjson",
    );
    expect(yaml).toContain("Number(timestamp) / 1000");
    expect(yaml).toContain("id: auto_timestamp");
    expect(yaml).toContain('filter: "!_time || _time <= 0"');
  });

  it("CEF: overrides the default timestamp to rt when detection finds none", () => {
    const yaml = generatePipelineConf("p", "PaloAlto", "CommonSecurityLog", [], undefined, "cef");
    expect(yaml).toContain("srcField: rt");
  });

  it("generic: auto_timestamp from the detected candidate field", () => {
    const fields: PipelineFieldMapping[] = [
      { source: "EventTime", target: "EventTime", type: "datetime", action: "keep" },
    ];
    const yaml = generatePipelineConf("p", "Acme", "Acme_CL", fields, undefined, "json");
    expect(yaml).toContain("srcField: EventTime");
  });
});

describe("CEF two-step extraction + indexOf(-1) guard", () => {
  const yaml = generatePipelineConf("p", "PaloAlto", "CommonSecurityLog", [], undefined, "cef");

  it("emits the header eval then a serde kvp for the extension", () => {
    expect(yaml).toContain("name: __cefParts");
    expect(yaml).toContain("name: __cefExtension");
    expect(yaml).toContain("srcField: __cefExtension");
    expect(yaml).toContain("type: kvp");
    // header parsed via eval (avoiding regex_extract), not serde on _raw
    const evalIdx = yaml.indexOf("name: __cefParts");
    const serdeIdx = yaml.indexOf("srcField: __cefExtension");
    expect(evalIdx).toBeGreaterThan(-1);
    expect(serdeIdx).toBeGreaterThan(evalIdx);
  });

  it("guards indexOf('CEF:') so a non-CEF line yields [] not garbage", () => {
    const m = yaml.match(/name: __cefParts\s+value: "(.+)"/);
    expect(m).not.toBeNull();
    const expr = m![1];
    expect(expr).toContain("indexOf('CEF:') >= 0 ?");
    // Evaluate the emitted Cribl expression for both cases.
    const evalCef = new Function("_raw", `return (${expr});`) as (
      raw: string,
    ) => string[];
    expect(evalCef("plain syslog line, no header")).toEqual([]);
    const parts = evalCef("CEF:0|Palo Alto Networks|PAN-OS|10.1|TRAFFIC|end|3|src=1.2.3.4");
    expect(parts[0]).toBe("CEF:0");
    expect(parts[1]).toBe("Palo Alto Networks");
  });
});

describe("reduction runs BEFORE rename (pinned order)", () => {
  const rules: TableReductionRules = {
    keep: [{ id: "k", description: "keep", filter: "act", reason: "r" }],
    drop: [{ id: "d", description: "drop", filter: "true", reason: "r" }],
    suppress: [],
  };
  const renameFields: PipelineFieldMapping[] = [
    { source: "src", target: "SourceIP", type: "string", action: "rename" },
  ];

  it("the reduce group precedes the rename function", () => {
    const yaml = generatePipelineConf(
      "p",
      "PaloAlto",
      "CommonSecurityLog",
      renameFields,
      undefined,
      "cef",
      undefined,
      rules,
    );
    const reduceIdx = yaml.indexOf("groupId: reduce");
    const renameIdx = yaml.indexOf("id: rename");
    expect(reduceIdx).toBeGreaterThan(-1);
    expect(renameIdx).toBeGreaterThan(reduceIdx);
    // Volume Reduction group header present only when rules exist.
    expect(yaml).toContain("name: Volume Reduction");
  });
});

describe("coercion emission", () => {
  it("emits a Number() coercion for an int-typed coerce field", () => {
    const fields: PipelineFieldMapping[] = [
      { source: "bytes", target: "SentBytes", type: "int", action: "coerce" },
    ];
    const yaml = generatePipelineConf("p", "Acme", "Acme_CL", fields, undefined, "json");
    expect(yaml).toContain("name: SentBytes");
    expect(yaml).toContain("Number(SentBytes) || 0");
  });
});

describe("overflow serialize group", () => {
  it("emits a serialize into the overflow field with exclusions + wildcard", () => {
    const overflow: OverflowConfig = {
      enabled: true,
      fieldName: "AdditionalData_d",
      fieldType: "dynamic",
      sourceFields: ["weird_field_1", "weird_field_2"],
    };
    const yaml = generatePipelineConf(
      "p",
      "Acme",
      "Acme_CL",
      [],
      undefined,
      "json",
      overflow,
    );
    expect(yaml).toContain("groupId: overflow");
    expect(yaml).toContain("dstField: AdditionalData_d");
    expect(yaml).toContain('- "!__*"');
    expect(yaml).toContain('- "*"');
  });

  it("no vendor mappings and no overflow -> no duplicate DCR transforms leak in", () => {
    // A pure keep pipeline has no rename step at all.
    const yaml = generatePipelineConf("p", "Acme", "Acme_CL", fdrFields, undefined, "json");
    expect(yaml).not.toContain("id: rename");
  });
});
