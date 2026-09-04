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
import {
  buildCefIdentityOverrideFn,
  generatePipelineConf,
  generatePipelineConfForPlan,
  generateReductionConfForPlan,
  positionalColumns,
} from "./pipeline-conf";
import { checkCriblYaml } from "./cribl-yaml-validator";
import type { PipelineFieldMapping } from "./models";
import type { OverflowConfig } from "../field-matcher";
import type { TableReductionRules } from "./reduction-rules";
import { parseSampleContent } from "../sample-parsing/parse-sample";
import {
  CEF_HEADER_ESCAPE,
  CEF_HEADER_PATTERN,
  parseCef,
} from "../sample-parsing/parsers";
import { parsePositional } from "../sample-parsing/positional";
import { matchSampleToSchema } from "../field-matcher/match-fields";
import { buildPipelinePlan } from "./plan";

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

  /** One backslash, from its code point, so no source escaping can lose it. */
  const BS = String.fromCharCode(92);

  /**
   * The `add:` entries of the CEF HEADER EVAL only, run in order as Cribl would -
   * each seeing the fields the earlier ones set.
   *
   * Scoped to that one function rather than to the whole conf: the enrich group
   * adds `Type` too, and evaluating unrelated expressions here would make a
   * failure in this block mean something else.
   *
   * The `\\` unescape is the YAML step: the file carries `\\s` inside a
   * double-quoted scalar, which a YAML loader hands to Cribl as `\s`.
   */
  function runEmittedHeader(rawLine: string): Record<string, unknown> {
    const block = yaml
      .split(/^ {2}- id: /m)
      .find((f) => f.includes("description: Parse CEF header from _raw"));
    expect(block, "no CEF header eval in the emitted conf").toBeDefined();
    const adds = [...block!.matchAll(/^ +- name: (\S+)\n +value: "(.*)"$/gm)];
    expect(adds.length, "no add entries in the CEF header eval").toBe(9);
    const event: Record<string, unknown> = {};
    for (const [, name, raw] of adds) {
      const expr = (raw ?? "").replace(/\\\\/g, "\\");
      event[name ?? ""] = new Function(
        "_raw",
        "__cefParts",
        `return (${expr});`,
      )(rawLine, event["__cefParts"]);
    }
    return event;
  }

  /**
   * THE INDEPENDENT ORACLE (DBT-98). A character scanner sharing no code with
   * either the parser or the emitter - no regex, no split - so "both sides agree"
   * cannot mean "both sides carry the same bug". It is the CEF rule stated
   * directly: a backslash consumes the next character, an unescaped pipe ends a
   * field, and the remainder after the seventh separator is the extension,
   * verbatim. A dangling escape is malformed and yields nothing.
   */
  function scanCefHeader(
    line: string,
  ): { fields: string[]; extension: string | undefined } | null {
    const start = line.indexOf("CEF:");
    if (start < 0) return null;
    const s = line.slice(start + 4);
    const fields: string[] = [];
    let current = "";
    let i = 0;
    while (i < s.length) {
      if (s[i] === BS) {
        if (i + 1 >= s.length) return null;
        current += s[i + 1];
        i += 2;
        continue;
      }
      if (s[i] === "|") {
        fields.push(current);
        current = "";
        i += 1;
        if (fields.length === 7) return { fields, extension: s.slice(i) };
        continue;
      }
      current += s[i];
      i += 1;
    }
    fields.push(current);
    if (fields.length !== 7) return null;
    return { fields, extension: undefined };
  }

  /** The pack's names for the seven header fields, in header order. */
  const PACK_HEADER_NAMES = [
    "CEFVersion",
    "DeviceVendor",
    "DeviceProduct",
    "DeviceVersion",
    "DeviceEventClassID",
    "Activity",
    "LogSeverity",
  ];
  /** parseCef's names for the same seven, in the same order. */
  const PARSER_HEADER_NAMES = [
    "CEFVersion",
    "DeviceVendor",
    "DeviceProduct",
    "DeviceVersion",
    "DeviceEventClassID",
    "Name",
    "Severity",
  ];

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
    const expr = m![1]!.replace(/\\\\/g, "\\");
    expect(expr).toContain("indexOf('CEF:') >= 0 ?");
    // Evaluate the emitted Cribl expression for both cases.
    const evalCef = new Function("_raw", `return (${expr});`) as (
      raw: string,
    ) => string[];
    expect(evalCef("plain syslog line, no header")).toEqual([]);
    const parts = evalCef("CEF:0|Palo Alto Networks|PAN-OS|10.1|TRAFFIC|end|3|src=1.2.3.4");
    // SLOT 0 IS THE VERSION, not "CEF:0" (DBT-98). The header is matched, not
    // split, so the `CEF:` prefix is consumed by the anchor and `.slice(1)` drops
    // the whole-match element - which is why nothing downstream re-strips it.
    expect(parts[0]).toBe("0");
    expect(parts[1]).toBe("Palo Alto Networks");
    expect(parts[7]).toBe("src=1.2.3.4");
    // A PLAIN ARRAY, not a match object. `.slice(1)` is what drops `index`,
    // `input` and `groups`, so nothing downstream depends on Cribl preserving
    // properties a match result carries and an array does not. Pinned rather
    // than asserted in a comment, because it is the reason for the `.slice`.
    expect(Object.keys(parts)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
    ]);
    // A header the pattern cannot read yields [], never a partial fill. Before
    // DBT-98 this line produced five header fields in the pack and NO record in
    // the analyzer - the two halves disagreed about the same bytes.
    expect(evalCef("CEF:0|V|P|1.0|100")).toEqual([]);
  });

  it("emits sample-parsing's OWN header pattern, so the two cannot drift", () => {
    // THE ANTI-DRIFT PIN (DBT-98). Not "a regex is present" - the exact source
    // text of the constant parseCef matches with, recovered by undoing the YAML
    // escaping rather than by re-running the emitter's escaper, so the pin is
    // independent of the code that wrote the line.
    const m = yaml.match(/name: __cefParts\s+value: "(.+)"/);
    expect(m).not.toBeNull();
    const expr = m![1]!.replace(/\\\\/g, "\\");
    expect(expr).toContain(`/${CEF_HEADER_PATTERN.source}/`);
    const vendor = yaml.match(/name: DeviceVendor\s+value: "(.+)"/);
    expect(vendor).not.toBeNull();
    expect(vendor![1]!.replace(/\\\\/g, "\\")).toContain(
      `/${CEF_HEADER_ESCAPE.source}/g`,
    );
  });

  it("agrees with parseCef AND with a scanner, on every escape shape", () => {
    // THE LOAD-BEARING PIN (DBT-98). The emitted pipeline used to split the
    // header on `|`, so a `\|` written per the CEF specification shifted every
    // header field by one AT RUNTIME, in the pack an operator installs. The
    // analyzer had the same defect, which is the only reason the two agreed.
    //
    // VALUES, not names. All seven names are present and correct in the broken
    // parse too - that is what made this survive - so a name-list or a
    // toBeDefined assertion here would be worth nothing.
    const lines = [
      "CEF:0|V|P|1.0|100|worm|5|src=1.1.1.1",
      `CEF:0|V${BS}|W|P|1.0|100|worm|5|src=1.1.1.1`,
      `CEF:0|V${BS}${BS}|P|1.0|100|worm|5|src=1.1.1.1`,
      `CEF:0|V${BS}${BS}${BS}|W|P|1.0|100|worm|5|src=1.1.1.1`,
      `CEF:0|V|P|1.0|100|worm${BS}|trojan|5|src=1.1.1.1`,
      `CEF:0|V|P|1.0|100|worm|5${BS}|6|src=1.1.1.1`,
      `CEF:0|V|P|1.0|100|worm|5|msg=a${BS}|b src=1.1.1.1`,
      "CEF:0|V|P|1.0|100|worm|5|msg=a|b dst=2.2.2.2",
      "CEF:0|V|P|1.0|100|worm|5",
      "CEF:0|V|P|1.0|100|worm|5|",
      `<134>host1 CEF:0|V${BS}|W|P|1.0|100|worm|5|src=1.1.1.1`,
    ];

    for (const line of lines) {
      const expected = scanCefHeader(line);
      expect(expected, line).not.toBeNull();

      // 1. the analyzer's record
      const parsed = parseCef(line)[0];
      expect(parsed, line).toBeDefined();
      expect(
        PARSER_HEADER_NAMES.map((n) => parsed![n]),
        line,
      ).toEqual(expected!.fields);

      // 2. the emitted pipeline's fields, run as Cribl would run them
      const event = runEmittedHeader(line);
      expect(
        PACK_HEADER_NAMES.map((n) => event[n]),
        line,
      ).toEqual(expected!.fields);
      expect(event["__cefExtension"], line).toBe(expected!.extension);
    }

    // The escaped-pipe row, spelled out, because a loop that silently matched
    // nothing would still pass everything above.
    const shifted = runEmittedHeader(`CEF:0|V${BS}|W|P|1.0|100|worm|5|src=1.1.1.1`);
    expect(shifted["DeviceVendor"]).toBe("V|W"); // was `V\`
    expect(shifted["DeviceProduct"]).toBe("P"); // was `W`
    expect(shifted["LogSeverity"]).toBe("5"); // was `worm`
    expect(shifted["__cefExtension"]).toBe("src=1.1.1.1"); // was `5|src=1.1.1.1`
  });

  it("still passes the Cribl YAML validator with the pattern inlined", () => {
    // The emitted value is a long line carrying brackets, pipes and backslashes.
    // The rule that reads `- name:` lines is not idle on this conf - it reads all
    // nine minted names - so an empty issue list means "every minted name is
    // addressable", not "nothing was read".
    expect(checkCriblYaml(yaml, "conf.yml")).toEqual([]);
    expect(yaml).not.toContain("\t");
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

describe("decode action + vendor/preset union (2026-07-09)", () => {
  it("emits a base64-decode Eval that consumes the source field", () => {
    const conf = generatePipelineConf(
      "p",
      "Zscaler Internet Access",
      "CommonSecurityLog",
      [
        { source: "b64url", target: "RequestURL", type: "string", action: "decode" },
        { source: "cltip", target: "SourceIP", type: "string", action: "rename" },
      ],
    );
    expect(conf).toContain('value: "C.Decode.base64(b64url)"');
    expect(conf).toContain("name: RequestURL");
    expect(conf).toContain("Decode base64 source fields into DCR schema");
    // The encoded source is consumed once decoded.
    expect(conf).toMatch(/remove:\n        - b64url/);
  });

  it("preset renames survive when enrichment vendorMappings are present", () => {
    // The legacy either/or made ANY vendor mapping (enrichment constants
    // included) silently discard every preset rename - fixed as a union.
    const conf = generatePipelineConf(
      "p",
      "Zscaler Internet Access",
      "CommonSecurityLog",
      [{ source: "cltip", target: "SourceIP", type: "string", action: "rename" }],
      [
        {
          sourceName: "DeviceVendor",
          destName: "DeviceVendor",
          sourceType: "string",
          destType: "string",
          action: "enrich",
          description: "Zscaler",
        },
      ],
    );
    expect(conf).toContain("currentName: cltip");
    expect(conf).toContain("newName: SourceIP");
    expect(conf).toContain("name: DeviceVendor");
  });
});

describe("reviewer drops vs overflow (2026-07-13 live fix)", () => {
  const FIELDS = [
    { source: "act", target: "DeviceAction", type: "string", action: "rename" as const },
    { source: "noise", target: "", type: "string", action: "drop" as const },
    { source: "extra", target: "AdditionalExtensions", type: "string", action: "overflow" as const },
  ];

  it("removes dropped sources in cleanup and excludes them from the serialize", () => {
    const conf = generatePipelineConf(
      "Sentinel_Test_web",
      "Test Solution",
      "CommonSecurityLog",
      FIELDS,
      undefined,
      "json",
      {
        enabled: true,
        fieldName: "AdditionalExtensions",
        fieldType: "string",
        sourceFields: ["extra"],
      },
    );
    // Cleanup removes the dropped field outright.
    expect(conf).toContain("- noise");
    // The serialize excludes it so it never lands in the catch-all...
    expect(conf).toContain('- "!noise"');
    // ...while the overflow field stays serializable (no exclusion).
    expect(conf).not.toContain('- "!extra"');
    // RE-PINNED 2026-08-13, reversing the 2026-07-13 assertion that an
    // overflow source is never removed. Cribl's Serialize COPIES, so keeping
    // the original meant every catch-all field went over the wire twice - once
    // in the JSON and once top-level, where the DCR has no column and drops it.
    // The serialize runs in the `overflow` group and this eval in `cleanup`
    // immediately after, so the value is already inside AdditionalExtensions
    // before the original is removed.
    const cleanup = conf.slice(conf.indexOf("Remove internal fields") - 800);
    expect(cleanup).toContain("- extra");
  });

  it("keeps the serialized VALUE while dropping the duplicate top-level copy", () => {
    // The pin that makes the reversal safe: removing the original must not
    // empty the catch-all. Order is the only thing guaranteeing that, so it is
    // asserted as order - serialize before cleanup, in the emitted file.
    const conf = generatePipelineConf(
      "p",
      "V",
      "CommonSecurityLog",
      [{ source: "extra", target: "extra", type: "string", action: "overflow" }],
      undefined,
      "json",
      {
        enabled: true,
        fieldName: "AdditionalExtensions",
        fieldType: "string",
        sourceFields: ["extra"],
      },
    );
    const serializeAt = conf.indexOf("groupId: overflow");
    const cleanupAt = conf.indexOf("groupId: cleanup");
    expect(serializeAt).toBeGreaterThan(-1);
    expect(cleanupAt).toBeGreaterThan(serializeAt);
    // The field is serialized (not excluded) and then removed.
    expect(conf).not.toContain('- "!extra"');
    expect(conf.slice(cleanupAt - 900)).toContain("- extra");
  });

  it("never removes a MAPPED column - that would delete what the DCR wants", () => {
    const conf = generatePipelineConf(
      "p",
      "V",
      "CommonSecurityLog",
      [
        { source: "src", target: "SourceIP", type: "string", action: "rename" },
        { source: "extra", target: "extra", type: "string", action: "overflow" },
      ],
      undefined,
      "json",
      {
        enabled: true,
        fieldName: "AdditionalExtensions",
        fieldType: "string",
        sourceFields: ["extra"],
      },
    );
    const cleanup = conf.slice(conf.indexOf("Remove internal fields") - 900);
    expect(cleanup).not.toContain("- SourceIP");
    expect(cleanup).not.toContain("- src");
  });
});

describe("CEF identity override", () => {
  const FIELDS: PipelineFieldMapping[] = [
    { source: "src", target: "SourceIP", action: "keep", type: "string" },
  ];
  const conf = (override?: { DeviceVendor?: string; DeviceProduct?: string }) =>
    generatePipelineConf(
      "p", "Sol", "CommonSecurityLog", FIELDS, undefined, "cef",
      undefined, null, undefined, override,
    );

  it("emits nothing when no override is given", () => {
    expect(buildCefIdentityOverrideFn(undefined)).toBeNull();
    expect(buildCefIdentityOverrideFn({})).toBeNull();
    expect(conf()).not.toContain("Override CEF identity");
  });

  it("treats a blank value as 'leave it', never as 'clear it'", () => {
    // An empty DeviceVendor makes reconstructCefLine return null, so a blank
    // must not reach the pipeline as a field assignment.
    expect(buildCefIdentityOverrideFn({ DeviceVendor: "   " })).toBeNull();
  });

  it("sets the fields the override names", () => {
    const fn = buildCefIdentityOverrideFn({
      DeviceVendor: "Palo Alto Networks",
      DeviceProduct: "PAN-OS",
    })!;
    expect(fn).toContain("- name: DeviceVendor");
    expect(fn).toContain('"Palo Alto Networks"');
    expect(fn).toContain("- name: DeviceProduct");
  });

  it("escapes a quote rather than emitting a broken expression", () => {
    // An unescaped quote would produce a Cribl expression that fails to parse,
    // breaking the whole pipeline over a punctuation mark.
    const fn = buildCefIdentityOverrideFn({ DeviceVendor: 'A"B' })!;
    expect(fn).toContain('\\"');
  });

  it("runs AFTER CEF extraction, so it is not overwritten by it", () => {
    // The load-bearing pin. The CEF branch sets DeviceVendor FROM the raw
    // header; an override emitted before it would be silently undone by the
    // extraction it exists to correct.
    const yaml = conf({ DeviceVendor: "ZScaler" });
    const extraction = yaml.indexOf("__cefParts");
    const override = yaml.indexOf("Override CEF identity");
    expect(extraction).toBeGreaterThan(-1);
    expect(override).toBeGreaterThan(extraction);
  });

  it("runs BEFORE reduction and rename, so downstream sees the corrected value", () => {
    const yaml = conf({ DeviceVendor: "ZScaler" });
    const override = yaml.indexOf("Override CEF identity");
    const rename = yaml.indexOf("groupId: enrich");
    expect(rename).toBeGreaterThan(-1);
    expect(override).toBeLessThan(rename);
  });

  it("still emits valid Cribl YAML", () => {
    expect(
      checkCriblYaml(conf({ DeviceVendor: "Palo Alto Networks" }), "conf.yml"),
    ).toEqual([]);
  });
});

/**
 * GEN-6 - a positional sample must get a POSITIONAL extraction.
 *
 * THE DEFECT, as it reached a user. They uploaded a 22-line AWS VPC Flow Logs
 * sample. DBT-77 taught the parser to read it, so the app named the v2 columns
 * and ran a correct gap analysis - and then this emitter, having no positional
 * branch, fell to the trailing else and wrote `serde type: json` over `_raw`. A
 * whitespace line is not JSON, so the step extracted nothing, the rename below
 * it addressed a field no event carried, and the operator saw success on every
 * screen while installing a pack that produced empty events.
 *
 * WHAT THESE PINS ASSERT, and it is deliberately NOT "a split step exists".
 * That would pass with every column named wrongly, which is the same defect one
 * layer down. The property is that the names AND SLOTS the PARSER produced and
 * the names AND SLOTS the PIPELINE mints are the same - so the assertions run
 * the emitted Cribl expressions as JavaScript over a real sample line and
 * compare the resulting record to parsePositional's record for that same line.
 * An off-by-one, a hyphenated AWS spelling, or a re-detection that disagreed
 * with the parser all fail it.
 */
describe("positional extraction (GEN-6)", () => {
  // A real AWS VPC Flow Logs v2 default-format sample, including the
  // all-dashes NODATA row that made the reported file decline to be named
  // until DBT-77 corrected isVpcFlowV2.
  const VPC_V2 = [
    "2 123456789010 eni-1235b8ca123456789 172.31.16.139 172.31.16.21 20641 22 6 20 4249 1418530010 1418530070 ACCEPT OK",
    "2 123456789010 eni-1235b8ca123456789 172.31.9.69 172.31.9.12 49761 3389 6 20 4249 1418530010 1418530070 REJECT OK",
    "2 123456789010 eni-1235b8ca123456789 - - - - - - - 1431280876 1431280934 - NODATA",
    "2 123456789010 eni-1235b8ca123456789 10.0.1.5 10.0.2.7 443 51234 6 14 1200 1418530010 1418530070 ACCEPT OK",
  ].join("\n");

  // Six consistent whitespace columns and nothing AWS about them: the
  // UNRECOGNISED half, which parsePositional names field1..field6.
  const UNRECOGNISED = [
    "alpha bravo charlie delta echo foxtrot",
    "one two three four five six",
    "aa bb cc dd ee ff",
    "gg hh ii jj kk ll",
  ].join("\n");

  const SCHEMA = [
    { name: "SrcIpAddr", type: "string" },
    { name: "DstIpAddr", type: "string" },
    { name: "AccountId", type: "string" },
    { name: "TimeGenerated", type: "datetime" },
  ];

  /**
   * THE REAL CHAIN, byte-to-conf: parseSampleContent -> matchSampleToSchema ->
   * buildPipelinePlan -> generatePipelineConfForPlan. Hand-built field lists
   * cannot show that the parser and the emitter agree, because they would let
   * the test choose both halves.
   */
  function chain(content: string) {
    const parsed = parseSampleContent(content, { sourceName: "flow.log" });
    const match = matchSampleToSchema(
      parsed.fields.map((f) => ({
        name: f.name,
        type: f.type,
        sampleValues: f.examples,
      })),
      SCHEMA,
    );
    const plan = buildPipelinePlan({
      solutionName: "AWS VPC Flow Logs",
      packName: "cribl-aws-vpc-flow",
      tables: [
        {
          sentinelTable: "AWSVPCFlow",
          matchResult: match,
          sourceFormat: parsed.format,
        },
      ],
    });
    const table = plan.tables[0];
    if (table === undefined) throw new Error("planner produced no table");
    return {
      parsed,
      table,
      conf: generatePipelineConfForPlan(table, "AWS VPC Flow Logs"),
      reduction: generateReductionConfForPlan(table, "AWS VPC Flow Logs"),
    };
  }

  /**
   * Run the emitted eval's `add` entries as Cribl would - in order, each seeing
   * the fields the earlier ones set - and return the resulting event fields.
   *
   * The `\\` unescape is the YAML step: the file carries `\\s+` inside a
   * double-quoted scalar, which a YAML loader hands to Cribl as `\s+`.
   */
  function runEmittedExtraction(
    conf: string,
    rawLine: string,
  ): Record<string, unknown> {
    const adds = [...conf.matchAll(/^ +- name: (\S+)\n +value: "(.*)"$/gm)];
    expect(
      adds.length,
      "no add entries found in the emitted conf",
    ).toBeGreaterThan(0);
    const event: Record<string, unknown> = {};
    for (const [, name, raw] of adds) {
      const expr = (raw ?? "").replace(/\\\\/g, "\\");
      event[name ?? ""] = new Function(
        "_raw",
        "__posParts",
        `return (${expr});`,
      )(rawLine, event["__posParts"]);
    }
    delete event["__posParts"];
    return event;
  }

  it("extracts EXACTLY the columns the parser named, at the same slots (v2)", () => {
    const { parsed, conf } = chain(VPC_V2);

    // Asserted so a detection change cannot move this case off the positional
    // path and leave everything below passing for a different reason.
    expect(parsed.format).toBe("positional");
    expect(parsed.fields.map((f) => f.name)).toEqual([
      "version",
      "account_id",
      "interface_id",
      "srcaddr",
      "dstaddr",
      "srcport",
      "dstport",
      "protocol",
      "packets",
      "bytes",
      "start",
      "end",
      "action",
      "log_status",
    ]);

    // THE DEFECT ITSELF: no serde of any kind, and specifically not a JSON one.
    expect(conf).not.toContain("id: serde");
    expect(conf).not.toContain("type: json");

    // THE PROPERTY. Not "a split step exists" - the pipeline's own expressions,
    // executed, must reproduce the parser's record for the same line. Every
    // line of the sample, so a slot that only differs on the NODATA row cannot
    // hide.
    for (const line of VPC_V2.split("\n")) {
      const fromParser = parsePositional(line)[0];
      expect(fromParser, line).toBeDefined();
      expect(runEmittedExtraction(conf, line), line).toEqual(fromParser);
    }

    // ...and the names are the AWS-documented ones with UNDERSCORES, never the
    // hyphenated display spellings. `account-id` is not a Cribl property
    // accessor and is precisely what failed at runtime for the reporting user.
    expect(conf).toContain("- name: account_id");
    expect(conf).toContain("- name: interface_id");
    expect(conf).toContain("- name: log_status");
    expect(conf).not.toContain("account-id");

    // The whole conf is Cribl-acceptable, and the rule is NOT idle on it: the
    // 14 minted `- name:` lines are exactly the shape checkCriblYaml reads, so
    // 0 issues means "every minted name is addressable", not "nothing was
    // read". Measured: with a hyphen forced into one emitted name the count
    // goes 0 -> 1.
    expect(checkCriblYaml(conf, "conf.yml")).toEqual([]);
  });

  it("extracts field1..fieldN when the shape was NOT recognised", () => {
    // The honest case. The parser refuses to guess what column 4 means, so the
    // pipeline must mint the same placeholder names rather than invent a
    // vendor layout - and it must still extract, because the operator can map
    // field4 by hand only if field4 exists at runtime.
    const { parsed, conf } = chain(UNRECOGNISED);

    expect(parsed.format).toBe("positional");
    expect(parsed.fields.map((f) => f.name)).toEqual([
      "field1",
      "field2",
      "field3",
      "field4",
      "field5",
      "field6",
    ]);
    expect(conf).not.toContain("id: serde");
    expect(conf).not.toContain("type: json");

    for (const line of UNRECOGNISED.split("\n")) {
      expect(runEmittedExtraction(conf, line), line).toEqual(
        parsePositional(line)[0],
      );
    }
    expect(checkCriblYaml(conf, "conf.yml")).toEqual([]);
  });

  it("splits on RUNS of whitespace, as splitPositional does", () => {
    // A hand-edited sample carrying a tab or a doubled space must not shift
    // every column right. Pinned through the emitted expression rather than
    // asserted about the regex text, so a change to `split(' ')` fails here.
    const { conf } = chain(VPC_V2);
    const messy =
      "2  123456789010\teni-1235b8ca123456789 172.31.16.139 172.31.16.21 20641 22 6 20 4249 1418530010 1418530070 ACCEPT OK";
    const event = runEmittedExtraction(conf, messy);
    expect(event["account_id"]).toBe("123456789010");
    expect(event["interface_id"]).toBe("eni-1235b8ca123456789");
    expect(event["log_status"]).toBe("OK");
  });

  it("gives the FALLBACK REDUCTION pipeline the same extraction, not a JSON serde", () => {
    // That pipeline's triage step exists so a drop filter an operator writes by
    // hand can SEE a field. A JSON serde over a whitespace line gives it none,
    // so every filter they add silently matches nothing - the same defect in
    // the other conf the pack ships.
    const { reduction } = chain(VPC_V2);
    expect(reduction).not.toContain("type: json");
    expect(reduction).toContain("groupId: triage");
    expect(reduction).toContain("- name: log_status");
    const line = VPC_V2.split("\n")[0] ?? "";
    expect(runEmittedExtraction(reduction, line)).toEqual(
      parsePositional(line)[0],
    );
    expect(checkCriblYaml(reduction, "conf.yml")).toEqual([]);
  });

  it("says so LOUDLY when no column names can be derived", () => {
    // The one case that cannot be made right: positional format, but the plan
    // carries no name of either shape. Emitting nothing would be the original
    // defect wearing a different mask - a pipeline that quietly extracts
    // nothing - so the conf splits anyway (leaving the values visible in
    // __posParts) and carries a Comment saying what happened.
    const conf = generatePipelineConf(
      "p",
      "Acme",
      "Acme_CL",
      [],
      undefined,
      "positional",
    );
    expect(conf).not.toContain("type: json");
    expect(conf).toContain("name: __posParts");
    expect(conf).toContain("id: comment");
    expect(conf).toContain("no vendor fields at all");
    // The split still runs, and __posParts is NOT removed here - it is the only
    // thing the operator has left to look at.
    expect(conf).not.toContain("        - __posParts");
    expect(checkCriblYaml(conf, "conf.yml")).toEqual([]);
  });

  describe("positionalColumns", () => {
    const f = (source: string): PipelineFieldMapping => ({
      source,
      target: source,
      type: "string",
      action: "keep",
    });

    it("emits ALL 14 v2 columns even when the plan carries only some", () => {
      // The plan's field list is not evidence about the FILE's width, and an
      // unextracted column cannot be serialized into the catch-all or removed
      // by cleanup. Recognising the layout means knowing all of it.
      const cols = positionalColumns([f("srcaddr"), f("log_status")]);
      expect(cols).toHaveLength(14);
      expect(cols[0]).toEqual({ name: "version", index: 0 });
      expect(cols[13]).toEqual({ name: "log_status", index: 13 });
    });

    it("keeps each numbered column at ITS OWN slot, inventing no width", () => {
      // A subset must not become field1..field9 by inferring a width from the
      // highest name seen - that would mint nine columns from evidence for two.
      expect(positionalColumns([f("field9"), f("field2")])).toEqual([
        { name: "field2", index: 1 },
        { name: "field9", index: 8 },
      ]);
    });

    it("refuses both shapes at once rather than picking a half", () => {
      // Two shapes means these names did not come from one positional parse,
      // so there is no honest column order - the caller makes that loud.
      expect(positionalColumns([f("srcaddr"), f("field2")])).toEqual([]);
      expect(positionalColumns([])).toEqual([]);
      expect(positionalColumns([f("wat"), f("field0")])).toEqual([]);
    });
  });
});
