import { describe, expect, it } from "vitest";

import {
  detectLogType,
  isHeaderlessCsv,
  recordOriginalFormats,
  resolveOriginalFormat,
} from "./index";

// These heuristics were inline in the legacy React component; ported here as
// pure functions with the same behavior.

describe("detectLogType", () => {
  it("recognizes a keyword in the filename", () => {
    expect(detectLogType({ sourceName: "panw-traffic-sample.log" })).toBe(
      "Traffic",
    );
  });

  it("derives from a sourcetype example when the filename is opaque", () => {
    expect(
      detectLogType({
        sourceName: "export.json",
        fields: [{ name: "sourcetype", examples: ["pan:threat"] }],
      }),
    ).toBe("Threat");
  });

  it("falls back to a sanitized filename", () => {
    expect(detectLogType({ sourceName: "my report.bin" })).toBe("my_report");
  });
});

describe("isHeaderlessCsv", () => {
  it("is true when most fields are positional _N names", () => {
    expect(
      isHeaderlessCsv([
        { name: "_0" },
        { name: "_1" },
        { name: "_2" },
        { name: "app" },
      ]),
    ).toBe(true);
  });

  it("is false when few fields are positional, or too few fields", () => {
    expect(
      isHeaderlessCsv([{ name: "_0" }, { name: "app" }, { name: "user" }]),
    ).toBe(false);
    expect(isHeaderlessCsv([{ name: "_0" }, { name: "_1" }])).toBe(false);
  });
});

describe("original-format preservation", () => {
  it("records only non-JSON formats, keyed by lowercase log type", () => {
    const formats = recordOriginalFormats([
      { logType: "Traffic", format: "cef" },
      { logType: "Dns", format: "json" }, // json -> not recorded
      { logType: "Web", format: "ndjson" }, // ndjson -> not recorded
      { logType: "Auth", format: "kv" },
    ]);
    expect(formats).toEqual({ traffic: "cef", auth: "kv" });
  });

  it("merges over a base map without dropping prior entries", () => {
    const formats = recordOriginalFormats(
      [{ logType: "New", format: "leef" }],
      { existing: "syslog" },
    );
    expect(formats).toEqual({ existing: "syslog", new: "leef" });
  });

  it("resolves original format, then fallback, then json", () => {
    expect(resolveOriginalFormat("Traffic", { traffic: "cef" })).toBe("cef");
    expect(resolveOriginalFormat("Missing", {}, "csv")).toBe("csv");
    expect(resolveOriginalFormat("Missing", {})).toBe("json");
  });
});
