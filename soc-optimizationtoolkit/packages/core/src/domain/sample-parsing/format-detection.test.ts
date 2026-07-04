import { describe, expect, it } from "vitest";

import { detectSampleFormat } from "./index";

// The two legacy detectors (sample-parser detectFormat and sample-resolver
// detectSampleFormat) are now ONE function with an explicit strict/lenient
// mode. These tests CHARACTERIZE the four places the modes deliberately
// disagree - the pinned contract that documents why the merge is safe.

describe("detectSampleFormat shared classifications", () => {
  it("agrees on unambiguous formats", () => {
    for (const mode of ["lenient", "strict"] as const) {
      expect(detectSampleFormat("CEF:0|V|P|1|1|n|5|a=b", { mode })).toBe("cef");
      expect(detectSampleFormat("LEEF:1.0|V|P|1|E", { mode })).toBe("leef");
      expect(detectSampleFormat('[{"a":1}]', { mode })).toBe("json");
    }
  });

  it("defaults to lenient (content-aware) mode", () => {
    expect(detectSampleFormat("name,age,city,country")).toBe("csv");
  });
});

describe("strict vs lenient divergence (characterized)", () => {
  it("syslog-wrapped CEF: lenient sees CEF (includes), strict sees syslog (prefix)", () => {
    const input = "<134>Jan  1 00:00:00 host CEF:0|V|P|1|1|n|5|a=b";
    expect(detectSampleFormat(input, { mode: "lenient" })).toBe("cef");
    expect(detectSampleFormat(input, { mode: "strict" })).toBe("syslog");
  });

  it("object stream: lenient distinguishes ndjson, strict always says json", () => {
    const input = '{"a":1}\n{"a":2}';
    expect(detectSampleFormat(input, { mode: "lenient" })).toBe("ndjson");
    expect(detectSampleFormat(input, { mode: "strict" })).toBe("json");
  });

  it("CSV header line: lenient detects csv, strict cannot (no CSV heuristic)", () => {
    const input = "name,age,city,country";
    expect(detectSampleFormat(input, { mode: "lenient" })).toBe("csv");
    expect(detectSampleFormat(input, { mode: "strict" })).toBe("unknown");
  });

  it("single key=value: strict is eager (kv), lenient needs >2 pairs", () => {
    const input = "key=value";
    expect(detectSampleFormat(input, { mode: "lenient" })).toBe("unknown");
    expect(detectSampleFormat(input, { mode: "strict" })).toBe("kv");
  });
});
