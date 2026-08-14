/**
 * Value-based route discriminators.
 *
 * Two failures pull in opposite directions and both are silent, which is why
 * the guards get more pins than the happy path:
 *
 *   TOO TIMID - no filter, so the log type keeps a match-all, and because
 *   routes are final only the first match-all runs. This is the defect
 *   measured on the Zscaler pack (7 of 10 routes dead).
 *
 *   TOO EAGER - a filter over-fitted to a handful of sample events. It matches
 *   the samples, passes every test, deploys clean, and then silently drops the
 *   live events that differ. Strictly worse than the first, because a dead
 *   route is at least reported.
 */

import { describe, expect, it } from "vitest";
import {
  deriveValueDiscriminator,
  fieldValuesFromRecords,
  type LogTypeFieldValues,
} from "./route-value-discriminator";

/** Build a log type from field -> values, inferring the event count. */
function lt(
  values: Record<string, string[]>,
  eventCount?: number,
): LogTypeFieldValues {
  const lengths = Object.values(values).map((v) => v.length);
  return {
    eventCount: eventCount ?? Math.max(1, ...lengths),
    values,
  };
}

/** The Zscaler shape: one schema, log types told apart by `action`. */
const allowed = lt({
  action: ["Allowed", "Allowed", "Allowed"],
  srcIP: ["10.0.0.1", "10.0.0.2", "10.0.0.3"],
  url: ["a.example", "b.example", "c.example"],
});
const blocked = lt({
  action: ["Blocked", "Blocked"],
  srcIP: ["10.0.0.4", "10.0.0.5"],
  url: ["d.example", "e.example"],
});
const cautioned = lt({
  action: ["Cautioned"],
  srcIP: ["10.0.0.6"],
  url: ["f.example"],
});

describe("deriveValueDiscriminator - the case field presence cannot handle", () => {
  it("separates log types that share a schema and differ by value", () => {
    const filter = deriveValueDiscriminator(allowed, [blocked, cautioned], "cef");
    expect(filter).not.toBeNull();
    expect(filter).toContain("action");
    expect(filter).toContain("Allowed");
  });

  it("gives each log type its OWN value, never a sibling's", () => {
    const a = deriveValueDiscriminator(allowed, [blocked, cautioned], "cef") ?? "";
    const b = deriveValueDiscriminator(blocked, [allowed, cautioned], "cef") ?? "";
    expect(a).toContain("Allowed");
    expect(a).not.toContain("Blocked");
    expect(b).toContain("Blocked");
    expect(b).not.toContain("Allowed");
  });

  it("emits a parsed test AND a raw fallback for key-value shapes", () => {
    // Events can reach a route before anything parsed them.
    const filter = deriveValueDiscriminator(allowed, [blocked], "cef") ?? "";
    expect(filter).toContain("action === 'Allowed'");
    expect(filter).toContain("_raw.indexOf('action=Allowed')");
  });
});

describe("deriveValueDiscriminator - refuses to over-fit", () => {
  it("NEVER picks a per-event field, however cleanly it partitions", () => {
    // srcIP and url separate these samples perfectly - disjoint by luck of a
    // tiny corpus. Picking either would route live traffic by IP.
    const filter = deriveValueDiscriminator(allowed, [blocked, cautioned], "cef") ?? "";
    expect(filter).not.toContain("srcIP");
    expect(filter).not.toContain("url");
  });

  it("rejects a field missing from some of its own events", () => {
    // 3 events, `action` on only 2: a filter on it misses the third.
    const partial = lt({ action: ["Allowed", "Allowed"], srcIP: ["a", "b", "c"] }, 3);
    expect(deriveValueDiscriminator(partial, [blocked], "cef")).toBeNull();
  });

  it("rejects a field that varies within its own log type", () => {
    const mixed = lt({ action: ["Allowed", "Permitted"] });
    expect(deriveValueDiscriminator(mixed, [blocked], "cef")).toBeNull();
  });

  it("rejects a value a sibling also sends, case-insensitively", () => {
    // "ALLOWED" vs "Allowed" is the same log type to a vendor; a case-sensitive
    // filter would split one log type across two routes.
    const shouty = lt({ action: ["ALLOWED", "ALLOWED"] });
    expect(deriveValueDiscriminator(allowed, [shouty], "cef")).toBeNull();
  });

  it("rejects an id-like field that is constant only by small-sample accident", () => {
    // One event each, so every field is trivially "constant". sessionId is not
    // a category and must not become a route filter.
    const one = lt({ sessionId: ["s-1"], kind: ["web"] });
    const others = Array.from({ length: 8 }, (_, i) =>
      lt({ sessionId: [`s-${i + 2}`], kind: ["web"] }),
    );
    const filter = deriveValueDiscriminator(one, others, "cef");
    // kind is shared, sessionId is id-like: nothing survives.
    expect(filter).toBeNull();
  });

  it("rejects a repeated-but-high-cardinality field, e.g. a busy source IP", () => {
    // srcIP is constant across THIS log type's 3 events (one talkative host,
    // so repetition alone is satisfied) and never appears in a sibling. What
    // rejects it since 2026-08-13 is the COLUMN test: the siblings each carry
    // several distinct IPs, so the field is not single-valued for them and
    // therefore is not a discriminator column. (A corpus-cardinality budget
    // used to do this job; the column test made it unreachable and it is gone.)
    const oneHost = lt({ srcIP: ["10.0.0.9", "10.0.0.9", "10.0.0.9"] });
    const chatty = Array.from({ length: 3 }, (_, i) =>
      lt({ srcIP: [`10.1.${i}.1`, `10.1.${i}.2`, `10.1.${i}.3`, `10.1.${i}.4`] }),
    );
    expect(deriveValueDiscriminator(oneHost, chatty, "cef")).toBeNull();
  });

  it("returns null rather than guess when nothing separates the types", () => {
    const same = lt({ action: ["Allowed"] });
    expect(deriveValueDiscriminator(same, [lt({ action: ["Allowed"] })], "cef")).toBeNull();
  });
});

describe("deriveValueDiscriminator - format rules", () => {
  it("gives CSV nothing, because a route sees positional rows", () => {
    expect(deriveValueDiscriminator(allowed, [blocked], "csv")).toBeNull();
  });

  it("omits the raw fallback for JSON, where a bare value matches anywhere", () => {
    const filter = deriveValueDiscriminator(allowed, [blocked], "json") ?? "";
    expect(filter).toContain("action === 'Allowed'");
    expect(filter).not.toContain("_raw");
  });

  it("escapes quotes so the filter cannot break the expression", () => {
    const tricky = lt({ action: ["it's blocked"] });
    const filter = deriveValueDiscriminator(tricky, [blocked], "cef") ?? "";
    expect(filter).toContain("\\'");
  });

  it("is deterministic - same corpus, same filter", () => {
    const a = deriveValueDiscriminator(allowed, [blocked, cautioned], "cef");
    const b = deriveValueDiscriminator(allowed, [blocked, cautioned], "cef");
    expect(a).toBe(b);
  });
});

describe("fieldValuesFromRecords - evidence, not summary", () => {
  it("keeps one value per event, so counts survive", () => {
    // The guards run on repetition and presence; a distinct-value summary
    // (DiscoveredField.examples) would erase both.
    const v = fieldValuesFromRecords([
      { action: "Allowed", src: "10.0.0.1" },
      { action: "Allowed", src: "10.0.0.2" },
    ]);
    expect(v.eventCount).toBe(2);
    expect(v.values.action).toEqual(["Allowed", "Allowed"]);
    expect(v.values.src).toEqual(["10.0.0.1", "10.0.0.2"]);
  });

  it("records a short array for a field missing from some events", () => {
    // Fewer values than events is exactly how the present-in-every-event
    // guard detects a sometimes-absent field.
    const v = fieldValuesFromRecords([{ a: "1" }, {}, { a: "2" }]);
    expect(v.eventCount).toBe(3);
    expect(v.values.a).toHaveLength(2);
  });

  it("drops nested values rather than inventing a string for them", () => {
    const v = fieldValuesFromRecords([{ nested: { x: 1 }, list: [1, 2], ok: "y" }]);
    expect(v.values.nested).toBeUndefined();
    expect(v.values.list).toBeUndefined();
    expect(v.values.ok).toEqual(["y"]);
  });

  it("keeps numbers and booleans, which vendors use as discriminators", () => {
    const v = fieldValuesFromRecords([{ code: 200, ok: true }]);
    expect(v.values.code).toEqual(["200"]);
    expect(v.values.ok).toEqual(["true"]);
  });

  it("feeds a working discriminator straight from records", () => {
    const allow = fieldValuesFromRecords([
      { action: "Allowed", ip: "1.1.1.1" },
      { action: "Allowed", ip: "2.2.2.2" },
    ]);
    const block = fieldValuesFromRecords([
      { action: "Blocked", ip: "3.3.3.3" },
      { action: "Blocked", ip: "4.4.4.4" },
    ]);
    const filter = deriveValueDiscriminator(allow, [block], "cef") ?? "";
    expect(filter).toContain("action === 'Allowed'");
    expect(filter).not.toContain("ip");
  });
});

/**
 * The COLUMN test (tightened 2026-08-13).
 *
 * A discriminator is a column: every log type carrying the field is
 * single-valued on it and the values are pairwise distinct. The looser
 * "no sibling sends my value" test admitted incidental fields, and on the real
 * Zscaler corpus it chose TLS/session details that partitioned three sample
 * events by luck. Those filters are precise on the samples and wrong on live
 * traffic - invisible, which is the failure this module exists to avoid.
 *
 * Rejecting is cheap now: the log type gets a placeholder and is reported as
 * needing a filter, instead of a dead route. That is what made the tightening
 * worth its cost, which is real - fewer log types get an automatic filter.
 */
describe("deriveValueDiscriminator - must look like a column", () => {
  it("REJECTS the field the real Zscaler corpus over-fitted on", () => {
    // ALLOWED carries client_tls_sig_pqc_offers='1' constantly; the sibling
    // carries it too but VARIES. Under the old disjointness test '1' was
    // unseen in the sibling, so it won. A column cannot vary inside a sibling.
    // NO competing field: if a real discriminator were present the tie-break
    // would pick it and this would pass without ever exercising the guard.
    const allowedTls = lt({ client_tls_sig_pqc_offers: ["1", "1", "1"] });
    const blockedTls = lt({ client_tls_sig_pqc_offers: ["0", "2", "3"] });
    expect(deriveValueDiscriminator(allowedTls, [blockedTls], "cef")).toBeNull();
  });

  it("picks the real discriminator when both are present", () => {
    const allowedTls = lt({
      client_tls_sig_pqc_offers: ["1", "1", "1"],
      act: ["Allowed", "Allowed", "Allowed"],
    });
    const blockedTls = lt({
      client_tls_sig_pqc_offers: ["0", "2", "3"],
      act: ["Blocked", "Blocked", "Blocked"],
    });
    const filter = deriveValueDiscriminator(allowedTls, [blockedTls], "cef") ?? "";
    expect(filter).toContain("act === 'Allowed'");
    expect(filter).not.toContain("client_tls_sig_pqc_offers");
  });

  it("REJECTS a field two log types happen to share a value on", () => {
    // Same value in a sibling is not a column, even though each is constant.
    const a = lt({ tier: ["gold", "gold"], act: ["A", "A"] });
    const b = lt({ tier: ["gold", "gold"], act: ["B", "B"] });
    const filter = deriveValueDiscriminator(a, [b], "cef") ?? "";
    expect(filter).not.toContain("tier");
    expect(filter).toContain("act === 'A'");
  });

  it("ACCEPTS a field a sibling does not carry at all", () => {
    // Absence is not a clash: the sibling simply never matches the filter.
    const web = lt({ urlCategory: ["news", "news"], shared: ["x", "x"] });
    const fw = lt({ shared: ["x", "x"] });
    const filter = deriveValueDiscriminator(web, [fw], "cef") ?? "";
    expect(filter).toContain("urlCategory === 'news'");
  });

  it("still separates a genuine action column across three log types", () => {
    // The case the whole feature exists for must survive the tightening.
    const A = lt({ act: ["Allowed", "Allowed"], ip: ["1", "2"] });
    const B = lt({ act: ["Blocked", "Blocked"], ip: ["3", "4"] });
    const C = lt({ act: ["Cautioned", "Cautioned"], ip: ["5", "6"] });
    expect(deriveValueDiscriminator(A, [B, C], "cef")).toContain("act === 'Allowed'");
    expect(deriveValueDiscriminator(B, [A, C], "cef")).toContain("act === 'Blocked'");
    expect(deriveValueDiscriminator(C, [A, B], "cef")).toContain("act === 'Cautioned'");
  });

  it("returns null when the only candidates are incidental", () => {
    // Nothing column-shaped: the caller placeholders the log type, which is
    // the honest outcome rather than a filter built on coincidence.
    const own = lt({ noise: ["7", "7"], shared: ["s", "s"] });
    const sib = lt({ noise: ["8", "9"], shared: ["s", "s"] });
    expect(deriveValueDiscriminator(own, [sib], "cef")).toBeNull();
  });
});
