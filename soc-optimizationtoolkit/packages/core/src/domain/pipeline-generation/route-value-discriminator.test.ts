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
  valueDiscriminatorFor,
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

/**
 * The Zscaler shape: one schema, log types told apart by `action`.
 *
 * Every log type carries at least MIN_EVENTS_FOR_VALUE_FILTER events. These
 * fixtures exist to exercise filter CONSTRUCTION - selection, escaping, format
 * rules - so they are deliberately given enough evidence to get that far. The
 * threshold itself is pinned separately, on fixtures built to be too thin.
 */
const allowed = lt({
  action: ["Allowed", "Allowed", "Allowed"],
  srcIP: ["10.0.0.1", "10.0.0.2", "10.0.0.3"],
  url: ["a.example", "b.example", "c.example"],
});
const blocked = lt({
  action: ["Blocked", "Blocked", "Blocked"],
  srcIP: ["10.0.0.4", "10.0.0.5", "10.0.0.7"],
  url: ["d.example", "e.example", "g.example"],
});
const cautioned = lt({
  action: ["Cautioned", "Cautioned", "Cautioned"],
  srcIP: ["10.0.0.6", "10.0.0.8", "10.0.0.9"],
  url: ["f.example", "h.example", "i.example"],
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
    // Enough events to clear the threshold, so this pins the single-value
    // guard rather than the evidence one.
    const mixed = lt({ action: ["Allowed", "Permitted", "Allowed"] });
    expect(deriveValueDiscriminator(mixed, [blocked], "cef")).toBeNull();
  });

  it("rejects a value a sibling also sends, case-insensitively", () => {
    // "ALLOWED" vs "Allowed" is the same log type to a vendor; a case-sensitive
    // filter would split one log type across two routes.
    const shouty = lt({ action: ["ALLOWED", "ALLOWED", "ALLOWED"] });
    expect(deriveValueDiscriminator(allowed, [shouty], "cef")).toBeNull();
  });

  it("rejects an id-like field, which varies per event", () => {
    // Well-evidenced log types, so the threshold is not what rejects this: a
    // session id takes a new value every event, so it is never constant and
    // can never become a route filter. `kind` is shared, so nothing survives.
    const own = lt({ sessionId: ["s-1", "s-2", "s-3"], kind: ["web", "web", "web"] });
    const others = Array.from({ length: 3 }, (_, i) =>
      lt({
        sessionId: [`s-${i}0`, `s-${i}1`, `s-${i}2`],
        kind: ["web", "web", "web"],
      }),
    );
    expect(deriveValueDiscriminator(own, others, "cef")).toBeNull();
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
    const tricky = lt({ action: ["it's blocked", "it's blocked", "it's blocked"] });
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
      { action: "Allowed", ip: "5.5.5.5" },
    ]);
    const block = fieldValuesFromRecords([
      { action: "Blocked", ip: "3.3.3.3" },
      { action: "Blocked", ip: "4.4.4.4" },
      { action: "Blocked", ip: "6.6.6.6" },
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
    const a = lt({ tier: ["gold", "gold", "gold"], act: ["A", "A", "A"] });
    const b = lt({ tier: ["gold", "gold", "gold"], act: ["B", "B", "B"] });
    const filter = deriveValueDiscriminator(a, [b], "cef") ?? "";
    expect(filter).not.toContain("tier");
    expect(filter).toContain("act === 'A'");
  });

  it("ACCEPTS a field a sibling does not carry at all", () => {
    // Absence is not a clash: the sibling simply never matches the filter.
    const web = lt({ urlCategory: ["news", "news", "news"], shared: ["x", "x", "x"] });
    const fw = lt({ shared: ["x", "x", "x"] });
    const filter = deriveValueDiscriminator(web, [fw], "cef") ?? "";
    expect(filter).toContain("urlCategory === 'news'");
  });

  it("still separates a genuine action column across three log types", () => {
    // The case the whole feature exists for must survive the tightening.
    const A = lt({ act: ["Allowed", "Allowed", "Allowed"], ip: ["1", "2", "9"] });
    const B = lt({ act: ["Blocked", "Blocked", "Blocked"], ip: ["3", "4", "10"] });
    const C = lt({ act: ["Cautioned", "Cautioned", "Cautioned"], ip: ["5", "6", "11"] });
    expect(deriveValueDiscriminator(A, [B, C], "cef")).toContain("act === 'Allowed'");
    expect(deriveValueDiscriminator(B, [A, C], "cef")).toContain("act === 'Blocked'");
    expect(deriveValueDiscriminator(C, [A, B], "cef")).toContain("act === 'Cautioned'");
  });

  it("returns null when the only candidates are incidental", () => {
    // Nothing column-shaped: the caller placeholders the log type, which is
    // the honest outcome rather than a filter built on coincidence.
    const own = lt({ noise: ["7", "7", "7"], shared: ["s", "s", "s"] });
    const sib = lt({ noise: ["8", "9", "12"], shared: ["s", "s", "s"] });
    expect(deriveValueDiscriminator(own, [sib], "cef")).toBeNull();
  });
});

/**
 * EVIDENCE THRESHOLD (2026-08-14).
 *
 * The column test was added expecting it to reject the TLS field the Zscaler
 * corpus over-fitted on. Measured against the real corpus, it did not - and it
 * was right not to: across 43 events in 10 log types that field really is
 * single-valued per log type with distinct values. It satisfies every
 * structural property of a discriminator.
 *
 * The rule was never the problem. 1-3 events per log type cannot distinguish a
 * discriminator from an accident, because on that much data they are identical.
 * So the corpus must earn the inference, and a thin one yields a placeholder
 * instead of a confident guess.
 */
describe("deriveValueDiscriminator - the corpus must earn the inference", () => {
  it("refuses a filter when the log type has too few events", () => {
    // Two events, perfectly constant, cleanly distinct - and still not enough.
    const own = lt({ act: ["Allowed", "Allowed"] });
    const sib = lt({ act: ["Blocked", "Blocked", "Blocked"] });
    expect(deriveValueDiscriminator(own, [sib], "cef")).toBeNull();
  });

  it("refuses when a SIBLING is too thin to confirm the column", () => {
    // Own is well-evidenced; the sibling has one event, so its
    // single-valued-ness is unproven and it might carry our value in traffic
    // we never sampled - which would capture its events into our route.
    const own = lt({ act: ["Allowed", "Allowed", "Allowed"] });
    const thin = lt({ act: ["Blocked"] });
    expect(deriveValueDiscriminator(own, [thin], "cef")).toBeNull();
  });

  it("allows it once every carrier of the field clears the threshold", () => {
    const own = lt({ act: ["Allowed", "Allowed", "Allowed"] });
    const sib = lt({ act: ["Blocked", "Blocked", "Blocked"] });
    expect(deriveValueDiscriminator(own, [sib], "cef")).toContain("act === 'Allowed'");
  });

  it("ignores the threshold for a sibling that does not carry the field", () => {
    // Absence is not weak evidence - the sibling simply never matches.
    const own = lt({ urlCat: ["news", "news", "news"], shared: ["x", "x", "x"] });
    const other = lt({ shared: ["x"] });
    expect(deriveValueDiscriminator(own, [other], "cef")).toContain("urlCat === 'news'");
  });

  it("yields NOTHING on the real Zscaler corpus shape", () => {
    // 43 events across 10 log types, 1-3 each. Measured, not hypothetical:
    // this is the corpus that produced client_tls_sig_pqc_offers === '1'.
    // Every log type now gets a placeholder, which is the honest reading.
    const allowed3 = lt({ tls: ["1", "1", "1"], act: ["Allowed", "Allowed", "Allowed"] });
    const cautioned1 = lt({ tls: ["0"], act: ["Cautioned"] });
    const webBlocked2 = lt({ tls: ["2", "2"], act: ["Blocked", "Blocked"] });
    expect(deriveValueDiscriminator(allowed3, [cautioned1, webBlocked2], "cef")).toBeNull();
  });
});

/**
 * SUGGEST INSTEAD OF APPLY (user decision 2026-08-15).
 *
 * The evidence threshold is right to refuse thin corpora, but throwing the
 * derivation's work away is its own failure - the operator is left writing a
 * filter by hand that the generator had already worked out. So a candidate
 * rejected ONLY for thin evidence comes back as a suggestion: shown, never
 * applied, accepted by a human who knows the vendor the sample does not
 * describe.
 */
describe("valueDiscriminatorFor - offers what it will not apply", () => {
  it("returns a SUGGESTION, not a filter, when the corpus is thin", () => {
    const own = lt({ act: ["Allowed", "Allowed"] });
    const sib = lt({ act: ["Blocked", "Blocked"] });
    const r = valueDiscriminatorFor(own, [sib], "cef");
    expect(r.filter).toBeNull();
    expect(r.suggestion).toContain("act === 'Allowed'");
  });

  it("returns a FILTER and no suggestion once the evidence is there", () => {
    // Never both: they are the same expression, and offering it after
    // applying it would read as two different findings.
    const own = lt({ act: ["Allowed", "Allowed", "Allowed"] });
    const sib = lt({ act: ["Blocked", "Blocked", "Blocked"] });
    const r = valueDiscriminatorFor(own, [sib], "cef");
    expect(r.filter).toContain("act === 'Allowed'");
    expect(r.suggestion).toBeNull();
  });

  it("suggests nothing when the field is STRUCTURALLY wrong, not merely thin", () => {
    // A per-event field is not a discriminator at any sample size, so there is
    // nothing to offer. Suggesting it would train operators to accept garbage.
    const own = lt({ sessionId: ["a", "b"] });
    const sib = lt({ sessionId: ["c", "d"] });
    const r = valueDiscriminatorFor(own, [sib], "cef");
    expect(r.filter).toBeNull();
    expect(r.suggestion).toBeNull();
  });

  it("does not let a thin sibling poison a field it does not carry", () => {
    // The bug this pin was written for: evidence was tracked once per call, so
    // a sibling rejected on some unrelated field downgraded a well-evidenced
    // one to a suggestion. Evidence is per candidate field.
    const own = lt({ urlCat: ["news", "news", "news"], shared: ["x", "x", "x"] });
    const thinOnShared = lt({ shared: ["x"] });
    const r = valueDiscriminatorFor(own, [thinOnShared], "cef");
    expect(r.filter).toContain("urlCat === 'news'");
    expect(r.suggestion).toBeNull();
  });

  it("reports the evidence so the operator knows what would fix it", () => {
    // "Add more samples" is only actionable with the numbers attached.
    const r = valueDiscriminatorFor(lt({ act: ["A"] }), [lt({ act: ["B"] })], "cef");
    expect(r.eventCount).toBe(1);
    expect(r.minEvents).toBeGreaterThan(1);
  });

  it("suggests the SAME expression it would have applied", () => {
    // One selection pass feeds both answers; a second copy of the guards would
    // drift, which this module has already been audited for twice.
    const thin = valueDiscriminatorFor(
      lt({ act: ["A", "A"] }),
      [lt({ act: ["B", "B"] })],
      "cef",
    );
    const fat = valueDiscriminatorFor(
      lt({ act: ["A", "A", "A"] }),
      [lt({ act: ["B", "B", "B"] })],
      "cef",
    );
    expect(thin.suggestion).toBe(fat.filter);
  });
});
