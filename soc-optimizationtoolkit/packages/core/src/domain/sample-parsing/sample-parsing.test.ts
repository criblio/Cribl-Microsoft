import { describe, expect, it } from "vitest";

import {
  collectFields,
  guessTimestampField,
  inferFieldType,
  mergeFieldType,
  parseSampleContent,
  parseCef,
  parseKv,
  parseLeef,
  parseSyslog,
} from "./index";
import type { FieldType } from "./index";

// These vectors are ported near-verbatim from the legacy sample-parser
// behavior (IS/sample-parser.ts). They pin the format-dispatch, the type
// inference lattice, field discovery, and timestamp guessing.

describe("inferFieldType", () => {
  it("classifies primitives and numeric/date-shaped strings", () => {
    expect(inferFieldType(null)).toBe("string");
    expect(inferFieldType(undefined)).toBe("string");
    expect(inferFieldType(true)).toBe("boolean");
    expect(inferFieldType(5)).toBe("int");
    expect(inferFieldType(5.5)).toBe("real");
    expect(inferFieldType({ a: 1 })).toBe("dynamic");
    expect(inferFieldType("true")).toBe("boolean");
    expect(inferFieldType("30")).toBe("int");
    expect(inferFieldType("3.14")).toBe("real");
    expect(inferFieldType("2024-01-01T12:00:00Z")).toBe("datetime");
    expect(inferFieldType("Oct 11 22:14:15")).toBe("datetime");
    expect(inferFieldType("hello")).toBe("string");
  });

  it("treats a 16+ digit numeric string as string, not int (legacy guard)", () => {
    expect(inferFieldType("123456789012345")).toBe("int"); // 15 digits
    expect(inferFieldType("1234567890123456")).toBe("string"); // 16 digits
  });
});

describe("mergeFieldType lattice", () => {
  it("reconciles int and real to real, collapses disagreement to string", () => {
    const cases: Array<[FieldType, FieldType, FieldType]> = [
      ["int", "int", "int"],
      ["int", "real", "real"],
      ["real", "int", "real"],
      ["int", "string", "string"],
      ["datetime", "int", "string"],
      ["boolean", "boolean", "boolean"],
    ];
    for (const [a, b, expected] of cases) {
      expect(mergeFieldType(a, b)).toBe(expected);
    }
  });
});

describe("collectFields", () => {
  it("merges types, caps examples, and marks >=90% fields required", () => {
    const records = [
      { a: "1", b: "x", c: 1 },
      { a: "2", b: "y", c: 2 },
      { a: "3.5", b: "z" }, // c missing -> not required
    ];
    const fields = collectFields(records);
    const a = fields.find((f) => f.name === "a");
    const b = fields.find((f) => f.name === "b");
    const c = fields.find((f) => f.name === "c");

    // a mixes int ("1","2") and real ("3.5") -> lattice reconciles to real.
    expect(a?.type).toBe("real");
    expect(a?.types).toEqual(["int", "real"]);
    expect(a?.required).toBe(true);
    expect(b?.type).toBe("string");
    // c present in 2 of 3 records -> below 90% -> not required.
    expect(c?.occurrence).toBe(2);
    expect(c?.required).toBe(false);
  });

  it("keeps at most a few distinct examples", () => {
    const records = [{ v: "a" }, { v: "b" }, { v: "c" }, { v: "d" }];
    const v = collectFields(records).find((f) => f.name === "v");
    expect(v?.examples.length).toBeLessThanOrEqual(3);
  });
});

describe("guessTimestampField", () => {
  it("prefers a known candidate name over a datetime-typed field", () => {
    const fields = collectFields([
      { timestamp: "1700000000000", other: "2024-01-01T00:00:00Z" },
    ]);
    expect(guessTimestampField(fields)).toBe("timestamp");
  });

  it("falls back to a datetime-typed field, then a *time* name, then none", () => {
    const dtOnly = collectFields([{ whenish: "2024-01-01T00:00:00Z" }]);
    expect(guessTimestampField(dtOnly)).toBe("whenish");
    const timeish = collectFields([{ uptimeSeconds: "hello" }]);
    expect(guessTimestampField(timeish)).toBe("uptimeSeconds");
    const none = collectFields([{ foo: "bar" }]);
    expect(guessTimestampField(none)).toBeUndefined();
  });
});

describe("parseSampleContent format dispatch", () => {
  it("parses a JSON array", () => {
    const parsed = parseSampleContent('[{"x":1},{"x":2}]');
    expect(parsed.format).toBe("json");
    expect(parsed.eventCount).toBe(2);
    expect(parsed.errors).toEqual([]);
  });

  it("parses an NDJSON stream", () => {
    const parsed = parseSampleContent('{"a":1,"b":2}\n{"a":3,"b":4}');
    expect(parsed.format).toBe("ndjson");
    expect(parsed.eventCount).toBe(2);
    expect(parsed.fields.map((f) => f.name).sort()).toEqual(["a", "b"]);
  });

  it("parses CSV with a header row and infers column types", () => {
    const parsed = parseSampleContent(
      "name,age,city,country\nAlice,30,NYC,US\nBob,25,LA,US",
    );
    expect(parsed.format).toBe("csv");
    expect(parsed.eventCount).toBe(2);
    expect(parsed.fields.find((f) => f.name === "age")?.type).toBe("int");
  });

  it("parses key=value lines", () => {
    const parsed = parseSampleContent("key1=val1 key2=val2 key3=val3");
    expect(parsed.format).toBe("kv");
    expect(parsed.records[0]).toEqual({
      key1: "val1",
      key2: "val2",
      key3: "val3",
    });
  });

  it("parses a CEF line into header + extension fields", () => {
    const parsed = parseSampleContent(
      "CEF:0|Security|threatmanager|1.0|100|worm detected|10|src=10.0.0.1 dst=2.1.2.2",
    );
    expect(parsed.format).toBe("cef");
    expect(parsed.records[0]).toMatchObject({
      DeviceVendor: "Security",
      DeviceProduct: "threatmanager",
      src: "10.0.0.1",
      dst: "2.1.2.2",
    });
  });

  it("records an error and empty result for unparseable content", () => {
    const parsed = parseSampleContent("!!!");
    expect(parsed.eventCount).toBe(0);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });
});

describe("individual parsers", () => {
  it("parseKv keeps quoted values with spaces intact", () => {
    expect(parseKv('user=admin msg="login ok" ip=1.2.3.4')[0]).toEqual({
      user: "admin",
      msg: "login ok",
      ip: "1.2.3.4",
    });
  });

  it("parseLeef splits the tab-delimited extension", () => {
    const record = parseLeef(
      "LEEF:1.0|Vendor|Product|1.0|EVT-1|src=1.1.1.1\tdst=2.2.2.2",
    )[0];
    expect(record).toMatchObject({
      DeviceVendor: "Vendor",
      EventID: "EVT-1",
      src: "1.1.1.1",
      dst: "2.2.2.2",
    });
  });

  it("parseCef preserves a leading syslog header", () => {
    const record = parseCef("<134>host CEF:0|V|P|1|1|n|5|a=b")[0];
    expect(record._syslogHeader).toBe("<134>host");
    expect(record.DeviceVendor).toBe("V");
  });

  it("parseSyslog decodes RFC 3164 priority into facility/severity", () => {
    const record = parseSyslog("<34>Oct 11 22:14:15 mymachine su: msg")[0];
    expect(record).toMatchObject({
      Priority: 34,
      Hostname: "mymachine",
      Program: "su",
      Facility: 4,
      Severity: 2,
    });
  });
});
