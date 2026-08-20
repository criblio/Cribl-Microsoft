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

/**
 * Evaluate against a STRUCTURED event - fields as variables, no `_raw`.
 *
 * This is what a Cribl filter sees for an Event Hub or Kafka JSON source, and
 * the shape the predicate used to return false for unconditionally.
 */
function matchesStructured(
  predicate: string,
  event: Record<string, unknown>,
): boolean {
  const names = Object.keys(event);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `return ${predicate};`)(
    ...names.map((n) => event[n]),
  ) as boolean;
}

describe("logTypePredicate - case", () => {
  it("is CASE-INSENSITIVE, because PAN-OS shouts", () => {
    // The failure this prevents: PAN-OS emits GLOBALPROTECT, not
    // GlobalProtect. A case-sensitive test returns zero events, which reads as
    // "this source does not carry that log type" - an answer, not an error.
    const p = logTypePredicate(["GlobalProtect"]);
    expect(matches(p, "1,2026/08/13,013201031064,GLOBALPROTECT,0,2817")).toBe(true);
    expect(matches(p, "1,2026/08/13,013201031064,globalprotect,0,2817")).toBe(true);
  });

  it("generates a REGEX test, not a lowercased copy of every event", () => {
    // toLowerCase().includes() would allocate a lowercased copy of every event
    // that passes the filter, on the worker, for the whole capture.
    const p = logTypePredicate(["TRAFFIC"]);
    expect(p).toContain(".test(_raw)");
    expect(p).not.toContain("toLowerCase");
  });
});

describe("logTypePredicate - anchoring", () => {
  const traffic = logTypePredicate(["TRAFFIC"]);

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

  it("survives a value containing a SLASH - it is inside a regex literal", () => {
    // 2026-08-20 audit. escapeRegExp was written for new RegExp(), where `/`
    // is ordinary; embedded in a literal it closes the pattern early and the
    // whole expression stops being valid JavaScript. Cribl answers 400, so the
    // operator sees a rejected filter with no obvious cause.
    const p = logTypePredicate(["app/web"]);
    // The pin is that it EVALUATES at all - a string assertion would have
    // passed happily while the generated JS was unparseable.
    expect(matches(p, "1,x,app/web,y")).toBe(true);
    expect(matches(p, "1,x,appXweb,y")).toBe(false);
  });

  it("escapes regex metacharacters in the value", () => {
    // PAN-OS ships HIP-MATCH; a vendor could ship one with a dot or plus.
    const p = logTypePredicate(["HIP-MATCH"]);
    expect(matches(p, "1,2026/08/13,001,HIP-MATCH,end")).toBe(true);
    const dotted = logTypePredicate(["a.b"]);
    expect(matches(dotted, "x,a.b,y")).toBe(true);
    expect(matches(dotted, "x,aXb,y")).toBe(false);
  });
});

describe("logTypePredicate - sources with no _raw (2026-08-20 bug-hunt)", () => {
  it("matches a STRUCTURED event whose discriminator field carries the value", () => {
    // The defect: the test looked at `_raw` alone. Against an Event Hub, HEC or
    // Kafka JSON source - all of which the source picker offers - `_raw` is
    // undefined, so the capture returned nothing and the operator was told
    // their filter matched no events. A fact about their data, invented.
    const p = logTypePredicate(["TRAFFIC"]);
    expect(matchesStructured(p, { _raw: undefined, type: "TRAFFIC" })).toBe(true);
  });

  it("does NOT throw against a source carrying none of the fields it names", () => {
    // The reason every access is typeof-guarded. A Cribl filter is JavaScript,
    // and a bare reference to a name the event does not carry is a
    // ReferenceError - which drops the event. So the predicate names eight
    // fields, and an event with none of them must still evaluate, to false.
    const p = logTypePredicate(["TRAFFIC"]);
    expect(() => matchesStructured(p, { _raw: "nothing relevant here" })).not.toThrow();
    expect(matchesStructured(p, { _raw: "nothing relevant here" })).toBe(false);
    expect(p).toContain("typeof");
  });

  it("matches a field whose value is a NUMBER, not a string", () => {
    // Log types arrive as numbers from some sources - Windows EventID, Zscaler
    // reason codes - and the operator picked the value off a list where it was
    // rendered as text. (The String() call in the generated predicate is not
    // what makes this hold: RegExp.test coerces its argument identically. It is
    // there so the coercion is visible to whoever edits the filter.)
    const p = logTypePredicate(["4625"]);
    expect(matchesStructured(p, { _raw: undefined, eventType: 4625 })).toBe(true);
  });

  it("anchors the FIELD test to the whole value, not a substring", () => {
    // A field IS the value - unlike _raw, where the token sits among others.
    // Substring matching here would put "TRAFFIC" onto "TRAFFIC_DENIED".
    const p = logTypePredicate(["TRAFFIC"]);
    expect(matchesStructured(p, { _raw: undefined, type: "TRAFFIC" })).toBe(true);
    expect(matchesStructured(p, { _raw: undefined, type: "TRAFFIC_DENIED" })).toBe(
      false,
    );
  });

  it("ORs the values into ONE alternation, not a clause per value", () => {
    // Six ticked log types across eight fields would otherwise be 48 clauses in
    // a box the operator is invited to read and edit.
    const one = logTypePredicate(["TRAFFIC"]);
    const six = logTypePredicate(["TRAFFIC", "THREAT", "SYSTEM", "CONFIG", "HIP-MATCH", "GLOBALPROTECT"]);
    expect(six.split("||").length).toBe(one.split("||").length);
    expect(matchesStructured(six, { _raw: undefined, type: "CONFIG" })).toBe(true);
    expect(matchesStructured(six, { _raw: undefined, type: "URL" })).toBe(false);
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
