import { describe, expect, it } from "vitest";

import {
  extractKqlFieldsAndLiterals,
  serializeEvent,
  synthesizeEvents,
  DEFAULT_SYNTH_COUNT,
  type SynthesisField,
} from "./index";

describe("extractKqlFieldsAndLiterals", () => {
  it("extracts ==, in(), and has_any() literals", () => {
    const { fields, literals } = extractKqlFieldsAndLiterals([
      'T | where DeviceAction == "Deny" | where Protocol in ("TCP","UDP")',
      'T | where EventID has_any ("4624","4625")',
    ]);
    expect([...fields].sort()).toEqual(["DeviceAction", "EventID", "Protocol"]);
    expect(literals.get("DeviceAction")).toEqual(["Deny"]);
    expect(literals.get("Protocol")).toEqual(["TCP", "UDP"]);
    expect(literals.get("EventID")).toEqual(["4624", "4625"]);
  });

  it("adds extraFields without literals", () => {
    const { fields, literals } = extractKqlFieldsAndLiterals([], ["SourceIP"]);
    expect(fields.has("SourceIP")).toBe(true);
    expect(literals.has("SourceIP")).toBe(false);
  });
});

describe("synthesizeEvents - KQL where-clause satisfaction", () => {
  const fields: SynthesisField[] = [
    { name: "DeviceAction", type: "string" },
    { name: "Protocol", type: "string" },
    { name: "Bytes", type: "int" },
  ];

  it("places KQL literals so the synthetic events satisfy the rule's where-clauses", () => {
    const { literals } = extractKqlFieldsAndLiterals([
      'T | where DeviceAction == "Deny" | where Protocol in ("TCP","UDP")',
    ]);
    // Empty reverse-alias keeps the Sentinel field names, so the where-clauses
    // can be evaluated directly against the synthesized event.
    const events = synthesizeEvents({
      fields,
      format: "json",
      literals,
      count: 2,
      reverseAlias: new Map(),
    });
    expect(events).toHaveLength(2);

    const e0 = JSON.parse(events[0]) as Record<string, string>;
    const e1 = JSON.parse(events[1]) as Record<string, string>;
    // where DeviceAction == "Deny"
    expect(e0.DeviceAction).toBe("Deny");
    expect(e1.DeviceAction).toBe("Deny");
    // where Protocol in ("TCP","UDP") - round-robins the literal set
    expect(["TCP", "UDP"]).toContain(e0.Protocol);
    expect(e0.Protocol).toBe("TCP");
    expect(e1.Protocol).toBe("UDP");
  });

  it("reverse-maps Sentinel columns to vendor field names but keeps the literal value", () => {
    const { literals } = extractKqlFieldsAndLiterals(['T | where DeviceAction == "Deny"']);
    const [event] = synthesizeEvents({
      fields: [{ name: "DeviceAction", type: "string" }],
      format: "json",
      literals,
      count: 1,
    });
    // The gating literal is present regardless of the vendor field name chosen.
    expect(Object.values(JSON.parse(event) as Record<string, string>)).toContain("Deny");
  });

  it("is DETERMINISTIC - identical inputs yield identical events (seeded PRNG, no Date/random)", () => {
    const a = synthesizeEvents({ fields, format: "json", count: 3, reverseAlias: new Map() });
    const b = synthesizeEvents({ fields, format: "json", count: 3, reverseAlias: new Map() });
    expect(a).toEqual(b);
  });

  it("defaults to DEFAULT_SYNTH_COUNT events", () => {
    const events = synthesizeEvents({ fields, format: "json", reverseAlias: new Map() });
    expect(events).toHaveLength(DEFAULT_SYNTH_COUNT);
  });
});

describe("serializeEvent (per format, deterministic)", () => {
  const fields = { a: "1", b: "hello world" };

  it("json", () => {
    expect(serializeEvent({ a: "1", b: "2" }, "json")).toBe('{"a":"1","b":"2"}');
  });

  it("cef with the fixed synthetic header", () => {
    const line = serializeEvent({ src: "1.2.3.4" }, "cef");
    expect(line.startsWith("CEF:0|Synthetic|Product|1.0|100|Synthetic Event|5|")).toBe(true);
    expect(line).toContain("src=1.2.3.4");
  });

  it("kv quotes values containing spaces", () => {
    expect(serializeEvent(fields, "kv")).toBe('a=1 b="hello world"');
  });

  it("csv joins values", () => {
    expect(serializeEvent({ a: "1", b: "2", c: "3" }, "csv")).toBe("1,2,3");
  });

  it("syslog uses a DETERMINISTIC timestamp (no Date)", () => {
    const first = serializeEvent({ a: "1" }, "syslog", 0);
    const second = serializeEvent({ a: "1" }, "syslog", 0);
    expect(first).toBe(second);
    expect(first.startsWith("<134>1 ")).toBe(true);
  });
});
