/**
 * Pins for capture-filter composition (plan Phase 4, ADR 0003).
 *
 * Every one of these guards a SILENT failure. A capture filter that is wrong in
 * the ways below does not error - it returns zero events, or the wrong events,
 * and both read to the operator as an answer about their data.
 */

import { describe, expect, it } from "vitest";

import {
  buildCaptureFilter,
  captureFilterWarning,
  inputPredicate,
  logTypePredicate,
} from "./capture-filter";

/** Evaluate a generated predicate the way Cribl would - as JavaScript. */
function matches(predicate: string, raw: string): boolean {
  // eslint-disable-next-line no-new-func
  return new Function("_raw", `return ${predicate};`)(raw) as boolean;
}

describe("logTypePredicate - case", () => {
  it("is CASE-INSENSITIVE, because PAN-OS shouts", () => {
    // The failure this prevents: PAN-OS emits GLOBALPROTECT, not
    // GlobalProtect. A case-sensitive test returns zero events, which reads as
    // "this source does not carry that log type" - an answer, not an error.
    const p = logTypePredicate("GlobalProtect");
    expect(matches(p, "1,2026/08/13,013201031064,GLOBALPROTECT,0,2817")).toBe(true);
    expect(matches(p, "1,2026/08/13,013201031064,globalprotect,0,2817")).toBe(true);
  });

  it("generates a REGEX test, not a lowercased copy of every event", () => {
    // toLowerCase().includes() would allocate a lowercased copy of every event
    // that passes the filter, on the worker, for the whole capture.
    const p = logTypePredicate("TRAFFIC");
    expect(p).toContain(".test(_raw)");
    expect(p).not.toContain("toLowerCase");
  });
});

describe("logTypePredicate - anchoring", () => {
  const traffic = logTypePredicate("TRAFFIC");

  it("matches a COMMA-delimited PAN-OS field", () => {
    expect(
      matches(traffic, "1,2026/08/13 10:49:02,013201031064,TRAFFIC,end,2817"),
    ).toBe(true);
  });

  it("matches a PIPE-delimited CEF field - the comma anchor would not", () => {
    // The plan specifies /,TRAFFIC,/i, reasoning from PAN-OS. The operator
    // picks a SOURCE, not a format, so a comma anchor against a CEF vendor
    // matches nothing - the same zero-events failure wearing a different hat.
    expect(matches(traffic, "CEF:0|Palo Alto|PAN-OS|10.2|end|TRAFFIC|3|src=1.1.1.1")).toBe(
      true,
    );
  });

  it("matches a QUOTED JSON value and a KV pair", () => {
    expect(matches(traffic, '{"type":"TRAFFIC","src":"10.0.0.1"}')).toBe(true);
    expect(matches(traffic, "date=2026-08-13 type=TRAFFIC action=accept")).toBe(true);
  });

  it("matches at the very start and the very end of a line", () => {
    expect(matches(traffic, "TRAFFIC,end,2817")).toBe(true);
    expect(matches(traffic, "1,2026/08/13,end,TRAFFIC")).toBe(true);
  });

  it("does NOT match the word inside a URL PATH", () => {
    // The false positive route-value-discriminator.ts already warns about: a
    // bare /traffic/i matches a URL, a hostname, a user-agent. `/` is
    // deliberately excluded from the delimiter set to make this hold.
    expect(matches(traffic, 'GET https://example.com/api/traffic/list HTTP/1.1')).toBe(
      false,
    );
  });

  it("does NOT match the word inside a longer token", () => {
    expect(matches(traffic, "1,2026/08/13,001,TRAFFICKING,end")).toBe(false);
    expect(matches(traffic, "app=traffic-analyzer action=allow")).toBe(false);
  });

  it("escapes regex metacharacters in the value", () => {
    // PAN-OS ships HIP-MATCH; a vendor could ship one with a dot or plus.
    const p = logTypePredicate("HIP-MATCH");
    expect(matches(p, "1,2026/08/13,001,HIP-MATCH,end")).toBe(true);
    const dotted = logTypePredicate("a.b");
    expect(matches(dotted, "x,a.b,y")).toBe(true);
    expect(matches(dotted, "x,aXb,y")).toBe(false);
  });
});

describe("buildCaptureFilter", () => {
  it("ALWAYS conjoins the source clause - there is no source parameter", () => {
    // CaptureParamsReq carries no input field, so if __inputId is not in the
    // filter the capture runs against every source in the worker group.
    const filter = buildCaptureFilter({ inputId: "in_syslog", logTypes: ["TRAFFIC"] });
    expect(filter).toContain('__inputId === "in_syslog"');
    expect(filter.startsWith('__inputId === "in_syslog" && ')).toBe(true);
  });

  it("ORs several log types inside parentheses so the && binds correctly", () => {
    const filter = buildCaptureFilter({
      inputId: "in_syslog",
      logTypes: ["TRAFFIC", "THREAT"],
    });
    expect(filter).toMatch(/&& \(.*\|\|.*\)$/s);
    // And it really behaves: source-and-(either), not (source-and-one)-or-other.
    const run = (raw: string, id: string) =>
      // eslint-disable-next-line no-new-func
      new Function("_raw", "__inputId", `return ${filter};`)(raw, id) as boolean;
    expect(run("1,x,y,TRAFFIC,end", "in_syslog")).toBe(true);
    expect(run("1,x,y,THREAT,end", "in_syslog")).toBe(true);
    expect(run("1,x,y,SYSTEM,end", "in_syslog")).toBe(false);
    // The wrong source is excluded even when the log type matches.
    expect(run("1,x,y,TRAFFIC,end", "in_other")).toBe(false);
  });

  it("captures EVERYTHING from the source when no log type is chosen", () => {
    // A legitimate choice: not every vendor partitions its output, and an
    // operator who does not know yet should be able to look first.
    expect(buildCaptureFilter({ inputId: "in_syslog" })).toBe(
      '__inputId === "in_syslog"',
    );
    expect(buildCaptureFilter({ inputId: "in_syslog", logTypes: [] })).toBe(
      '__inputId === "in_syslog"',
    );
    expect(buildCaptureFilter({ inputId: "in_syslog", logTypes: ["", "  "] })).toBe(
      '__inputId === "in_syslog"',
    );
  });

  it("quotes the input id safely", () => {
    expect(inputPredicate('weird "id"')).toBe('__inputId === "weird \\"id\\""');
  });
});

describe("captureFilterWarning - the edit that costs you", () => {
  it("warns when an edited filter has dropped __inputId entirely", () => {
    // The plan lets the operator edit any suggested filter. THIS is the edit
    // that hurts: the capture then runs against every source in the group and
    // quietly returns a mixture the operator believes came from one place. A
    // wrong filter that errors is fine; this one succeeds and lies.
    const warning = captureFilterWarning("/,TRAFFIC,/i.test(_raw)", "in_syslog");
    expect(warning).toContain("EVERY source");
    expect(warning).toContain('__inputId === "in_syslog"');
  });

  it("warns when __inputId is present but names a DIFFERENT source", () => {
    const warning = captureFilterWarning('__inputId === "in_other"', "in_syslog");
    expect(warning).toContain("different source");
  });

  it("warns on an empty filter", () => {
    expect(captureFilterWarning("   ", "in_syslog")).toContain("every event");
  });

  it("is SILENT for a sound filter, including one the operator extended", () => {
    expect(captureFilterWarning(buildCaptureFilter({ inputId: "in_syslog" }), "in_syslog")).toBeNull();
    expect(
      captureFilterWarning(
        '__inputId === "in_syslog" && status >= 400',
        "in_syslog",
      ),
    ).toBeNull();
  });

  it("does NOT try to validate the JavaScript", () => {
    // Cribl evaluates the expression and this app has no business deciding what
    // is valid JS - a filter that fails to compile comes back as an HTTP error
    // carrying Cribl's own message, which is more accurate than a guess here.
    expect(
      captureFilterWarning('__inputId === "in_syslog" && ((((', "in_syslog"),
    ).toBeNull();
  });
});
