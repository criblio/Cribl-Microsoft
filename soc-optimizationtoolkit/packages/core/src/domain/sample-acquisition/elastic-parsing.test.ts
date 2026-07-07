import { describe, expect, it } from "vitest";

import {
  parseElasticFileContent,
  extractInnerEvent,
  unwrapElasticEvents,
  logTypeFromFilename,
} from "./index";

describe("parseElasticFileContent (6-format cascade)", () => {
  it("1: JSON array", () => {
    expect(parseElasticFileContent('[{"a":1},{"a":2}]', "x.json")).toEqual([
      '{"a":1}',
      '{"a":2}',
    ]);
  });

  it("2: single object with an events[] wrapper", () => {
    expect(
      parseElasticFileContent('{"events":[{"x":1},{"x":2}]}', "x.json"),
    ).toEqual(['{"x":1}', '{"x":2}']);
  });

  it("2b: a single .json object with no events[] becomes one event", () => {
    expect(parseElasticFileContent('{"only":true}', "x.json")).toEqual([
      '{"only":true}',
    ]);
  });

  it("3: true NDJSON (every line parses)", () => {
    expect(parseElasticFileContent('{"a":1}\n{"a":2}\n{"a":3}', "x.log")).toEqual([
      '{"a":1}',
      '{"a":2}',
      '{"a":3}',
    ]);
  });

  it("4: concatenated pretty-printed objects (split on \\n{)", () => {
    const content = '{\n  "a": 1\n}\n{\n  "a": 2\n}';
    expect(parseElasticFileContent(content, "x.log")).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("5: plain text (syslog/CEF/KV) one event per line", () => {
    const content = "<134>Jan  1 host app: first\n<134>Jan  1 host app: second";
    expect(parseElasticFileContent(content, "x.log")).toEqual([
      "<134>Jan  1 host app: first",
      "<134>Jan  1 host app: second",
    ]);
  });

  it("returns [] for empty content", () => {
    expect(parseElasticFileContent("   \n  ", "x.log")).toEqual([]);
  });
});

describe("extractInnerEvent + unwrapElasticEvents", () => {
  it("returns the field-richer inner object wrapper", () => {
    const inner = extractInnerEvent({
      event: { a: 1, b: 2, c: 3 },
      version: "v11",
    });
    expect(inner).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("preserves the raw Filebeat message line (message envelope)", () => {
    const events = unwrapElasticEvents([
      JSON.stringify({
        "@timestamp": "2024-01-01T00:00:00Z",
        message: "CEF:0|Vendor|Prod|1|100|evt|5|src=1.2.3.4",
        log: { offset: 1 },
      }),
    ]);
    expect(events).toEqual(["CEF:0|Vendor|Prod|1|100|evt|5|src=1.2.3.4"]);
  });

  it("removes ECS/Filebeat noise object fields, keeps the vendor fields", () => {
    const events = unwrapElasticEvents([
      JSON.stringify({
        action: "allow",
        src: "10.0.0.1",
        dst: "8.8.8.8",
        host: { name: "srv" },
        agent: { version: "1" },
      }),
    ]);
    expect(JSON.parse(events[0])).toEqual({
      action: "allow",
      src: "10.0.0.1",
      dst: "8.8.8.8",
    });
  });

  it("expands an events[] array wrapper into individual events", () => {
    const events = unwrapElasticEvents([
      JSON.stringify({ events: [{ a: 1 }, { b: 2 }] }),
    ]);
    expect(events).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("passes non-JSON lines through untouched", () => {
    expect(unwrapElasticEvents(["plain syslog line"])).toEqual([
      "plain syslog line",
    ]);
  });
});

describe("logTypeFromFilename", () => {
  it("strips test-/-sample and the package prefix", () => {
    expect(logTypeFromFilename("test-panw-panos-traffic-sample.log", "panw")).toBe(
      "panos-traffic",
    );
    expect(logTypeFromFilename("test-cisco_asa-log.log", "cisco_asa")).toBe("log");
  });

  it("defaults to 'default' when nothing remains", () => {
    expect(logTypeFromFilename("test-panw-sample.log", "panw")).toBe("default");
  });
});
