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

/**
 * Evaluate with ONLY the named fields in scope, so `_raw` is genuinely an
 * UNDECLARED name rather than a parameter that happens to be undefined.
 *
 * The distinction is the whole point, and it is why the pins below this one
 * missed a real defect for a day: `matches` takes `_raw` as a parameter and
 * `matchesStructured` was only ever called with `_raw` as an explicit key, so
 * in every existing test `_raw` was a declared binding. A bare reference to it
 * therefore could not throw, and the one arm of the predicate that was NOT
 * typeof-guarded looked fine.
 */
function matchesUndeclaredRaw(
  predicate: string,
  event: Record<string, unknown>,
): boolean {
  const names = Object.keys(event);
  if (names.includes("_raw")) {
    throw new Error("this helper exists to leave _raw undeclared");
  }
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
    expect(p).toContain("_raw");
    expect(p).toContain("RegExp");
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

  it("does not THROW when `_raw` is not a field on the event AT ALL", () => {
    // 2026-08-20 audit, and this one is sharp: `_raw` was the single bare
    // reference left in the predicate while all eight structured fields were
    // typeof-guarded. That contradicted rule 4 in the worst possible place,
    // because rule 4 exists BECAUSE `_raw` is absent on Event Hub, HEC and
    // Kafka JSON sources - so on exactly the sources the structured arms were
    // added to rescue, the expression threw a ReferenceError before it ever
    // reached them. Every event dropped, and a capture that returns nothing
    // reads to the operator as an idle source.
    //
    // The existing pins could not see it: both other helpers declare `_raw`,
    // so a bare reference to it could not throw in any of them.
    const p = logTypePredicate(["TRAFFIC"]);
    expect(() => matchesUndeclaredRaw(p, { type: "TRAFFIC" })).not.toThrow();
    expect(matchesUndeclaredRaw(p, { type: "TRAFFIC" })).toBe(true);
    // And it still answers NO rather than throwing when nothing matches.
    expect(matchesUndeclaredRaw(p, { type: "SYSTEM" })).toBe(false);
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

describe("inputPredicate - __inputId is type-qualified (2026-08-20 bug-hunt)", () => {
  /** Evaluate a source clause against a given __inputId value. */
  const selects = (predicate: string, inputId: unknown): boolean =>
    // eslint-disable-next-line no-new-func
    new Function("__inputId", `return ${predicate};`)(inputId) as boolean;

  it("matches every __inputId shape Cribl's OWN capture dialog offers", () => {
    // Verified against the product 2026-08-21. Cribl generates an "Input
    // Filters" list from the configured inputs; these are its exact strings.
    // Two segments for most source types, THREE for syslog and http - and for
    // those Cribl itself writes startsWith('syslog:pfsense:'), which is the
    // tell that a trailing segment exists.
    expect(selects(inputPredicate("in_cribl_tcp"), "cribl_tcp:in_cribl_tcp")).toBe(true);
    expect(selects(inputPredicate("Cisco350_SNMP"), "snmp:Cisco350_SNMP")).toBe(true);
    expect(selects(inputPredicate("replay_pfsense"), "collection:replay_pfsense")).toBe(true);
    expect(
      selects(inputPredicate("LogSourceJob_AzureMangedWorkers"), "cribl_http:LogSourceJob_AzureMangedWorkers"),
    ).toBe(true);
  });

  it("matches a THREE-segment id, which a suffix match could not", () => {
    // The defect this replaced: "syslog:pfsense:10.0.0.1".endsWith(":pfsense")
    // is FALSE, so a capture from any syslog source matched nothing - and
    // syslog is the transport for most vendors this toolkit onboards. It
    // survived a spec read and a full round of pins because every example in
    // the spec happens to be two-segment.
    expect(selects(inputPredicate("pfsense"), "syslog:pfsense:10.0.0.1")).toBe(true);
    expect(selects(inputPredicate("Corelight"), "syslog:Corelight:zeek01")).toBe(true);
    expect(selects(inputPredicate("http"), "http:http:8088")).toBe(true);
  });

  it("still matches a BARE id, in case a deployment sends one", () => {
    expect(selects(inputPredicate("in_syslog"), "in_syslog")).toBe(true);
  });

  it("matches whichever TRANSPORT prefix a dual-protocol source sends", () => {
    // Why the id is taken as a SEGMENT rather than rebuilt as `type:id` from
    // the /system/inputs `type` field: the prefix is the transport, and a
    // source listening on both protocols emits tcp: on one event and udp: on
    // the next. A rebuilt string would match one and silently drop the other.
    const p = inputPredicate("in_syslog");
    expect(selects(p, "tcp:in_syslog")).toBe(true);
    expect(selects(p, "udp:in_syslog")).toBe(true);
  });

  it("does NOT select a DIFFERENT source with a similar name", () => {
    // Comparing a whole segment is what makes this safe rather than sloppy: a
    // substring or suffix test would accept both of these.
    const p = inputPredicate("in_syslog");
    expect(selects(p, "syslog:other_in_syslog")).toBe(false);
    expect(selects(p, "syslog:in_syslog_prod")).toBe(false);
    expect(selects(p, "syslog:other_in_syslog:host1")).toBe(false);
  });

  it("does not THROW when __inputId is absent", () => {
    // Calling .endsWith on an absent field is a TypeError, which drops every
    // event - a capture that returns nothing for a reason nobody can see.
    const p = inputPredicate("in_syslog");
    expect(() => selects(p, undefined)).not.toThrow();
    expect(selects(p, undefined)).toBe(false);
  });
});

describe("buildCaptureFilter", () => {
  it("ALWAYS conjoins the source clause - there is no source parameter", () => {
    // CaptureParamsReq carries no input field, so if __inputId is not in the
    // filter the capture runs against every source in the worker group.
    const filter = buildCaptureFilter({ inputId: "in_syslog", logTypes: ["TRAFFIC"] });
    expect(filter).toContain("__inputId");
    expect(filter).toContain('"in_syslog"');
    expect(filter.startsWith(`${inputPredicate("in_syslog")} && `)).toBe(true);
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
    const sourceOnly = inputPredicate("in_syslog");
    expect(buildCaptureFilter({ inputId: "in_syslog" })).toBe(sourceOnly);
    expect(buildCaptureFilter({ inputId: "in_syslog", logTypes: [] })).toBe(sourceOnly);
    expect(buildCaptureFilter({ inputId: "in_syslog", logTypes: ["", "  "] })).toBe(
      sourceOnly,
    );
  });

  it("quotes the input id safely", () => {
    // An id carrying a quote must not break out of the string literal and turn
    // the filter into JavaScript Cribl rejects.
    const p = inputPredicate('weird "id"');
    expect(p).toContain('"weird \\"id\\""');
    expect(() =>
      // eslint-disable-next-line no-new-func
      new Function("__inputId", `return ${p};`)('weird "id"'),
    ).not.toThrow();
    // eslint-disable-next-line no-new-func
    expect(new Function("__inputId", `return ${p};`)('weird "id"')).toBe(true);
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
