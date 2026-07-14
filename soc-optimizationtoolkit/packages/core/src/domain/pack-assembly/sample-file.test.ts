import { describe, expect, it } from "vitest";

import {
  generateSampleFile,
  generateSamplesYml,
  reconstructCefLine,
  renderSampleRegistryEntry,
  SAMPLE_TIME_BASE_SEC,
  type PackVendorSample,
} from "./sample-file";

const ENVELOPE = new Set(["_raw", "_time", "source", "sourcetype", "host", "index"]);

describe("reconstructCefLine", () => {
  it("rebuilds a raw CEF line with header + extension kv pairs", () => {
    const line = reconstructCefLine({
      CEFVersion: 0,
      DeviceVendor: "Palo Alto",
      DeviceProduct: "PAN-OS",
      DeviceVersion: "10.1",
      DeviceEventClassID: "end",
      Name: "traffic",
      Severity: "5",
      cs1: "label",
      spt: "443",
    });
    expect(line).toBe("CEF:0|Palo Alto|PAN-OS|10.1|end|traffic|5|cs1=label spt=443");
  });

  it("skips the CEF header + syslog-header fields from the extension", () => {
    const line = reconstructCefLine({
      CEFVersion: 0,
      DeviceVendor: "V",
      Name: "n",
      Severity: "1",
      _syslogHeader: "should-not-appear",
      keep: "yes",
    })!;
    expect(line).not.toContain("_syslogHeader");
    expect(line).toContain("keep=yes");
  });

  it("returns null for a non-CEF object", () => {
    expect(reconstructCefLine({ foo: "bar" })).toBeNull();
  });
});

describe("generateSampleFile - real uploaded samples", () => {
  const sample: PackVendorSample = {
    tableName: "CommonSecurityLog",
    source: "PaloAlto:TRAFFIC",
    logType: "TRAFFIC",
    rawEvents: [
      JSON.stringify({ CEFVersion: 0, DeviceVendor: "PA", Name: "t", Severity: "5", spt: "1" }),
      "plain syslog line",
    ],
  };

  it("wraps each raw event with ONLY the envelope keys", () => {
    const { events } = generateSampleFile("PaloAlto", "CommonSecurityLog", [], [sample], 5, "TRAFFIC");
    expect(events).toHaveLength(2);
    for (const evt of events) {
      expect(Object.keys(evt).every((k) => ENVELOPE.has(k))).toBe(true);
    }
  });

  it("reconstructs CEF from a tag-roundtripped object into _raw", () => {
    const { events } = generateSampleFile("PaloAlto", "CommonSecurityLog", [], [sample], 5, "TRAFFIC");
    expect(events[0]._raw).toContain("CEF:");
    expect(events[1]._raw).toBe("plain syslog line");
  });

  it("advances _time by 60s per event from the fixed base", () => {
    const { events } = generateSampleFile("PaloAlto", "CommonSecurityLog", [], [sample], 5, "TRAFFIC");
    expect(events[0]._time).toBe(SAMPLE_TIME_BASE_SEC);
    expect(events[1]._time).toBe(SAMPLE_TIME_BASE_SEC + 60);
  });

  it("event-breaks a JSON array raw event into one event per element", () => {
    const arraySample: PackVendorSample = {
      tableName: "X_CL",
      source: "vendor:x",
      rawEvents: [JSON.stringify([{ a: 1 }, { a: 2 }, { a: 3 }])],
    };
    const { events, rawCount } = generateSampleFile("V", "X_CL", [], [arraySample], 5);
    expect(rawCount).toBe(3);
    expect(events).toHaveLength(3);
  });
});

describe("generateSampleFile - synthetic fallback", () => {
  it("generates eventCount deterministic events when no samples match", () => {
    const fields = [{ source: "SourcePort", type: "int" }, { source: "SourceIP", type: "string" }];
    const a = generateSampleFile("V", "X_CL", fields, [], 5);
    const b = generateSampleFile("V", "X_CL", fields, [], 5);
    expect(a.events).toHaveLength(5);
    expect(a.events[0]._raw).toBe(b.events[0]._raw); // deterministic
    for (const evt of a.events) {
      expect(Object.keys(evt).every((k) => ENVELOPE.has(k))).toBe(true);
      expect(() => JSON.parse(evt._raw)).not.toThrow();
    }
  });
});

describe("samples.yml registry", () => {
  it("renders a registry entry with the fixed field set", () => {
    const block = renderSampleRegistryEntry({
      sampleId: "AbC123",
      sampleName: "PaloAlto_TRAFFIC.json",
      createdMs: 1_700_000_000_000,
      size: 42,
      numEvents: 3,
    });
    expect(block).toContain("AbC123:");
    expect(block).toContain('sampleName: "PaloAlto_TRAFFIC.json"');
    expect(block).toContain("ttl: 0");
    expect(block).toContain("created: 1700000000000");
    expect(block).toContain("size: 42");
    expect(block).toContain("numEvents: 3");
  });

  it("emits a placeholder comment when there are no samples", () => {
    expect(generateSamplesYml([])).toBe("# No sample data generated\n");
  });
});
