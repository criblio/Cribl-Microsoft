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
  logType: string,
  values: Record<string, string[]>,
  eventCount?: number,
): LogTypeFieldValues {
  const lengths = Object.values(values).map((v) => v.length);
  return {
    logType,
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
const allowed = lt("allowed", {
  action: ["Allowed", "Allowed", "Allowed"],
  srcIP: ["10.0.0.1", "10.0.0.2", "10.0.0.3"],
  url: ["a.example", "b.example", "c.example"],
});
const blocked = lt("blocked", {
  action: ["Blocked", "Blocked", "Blocked"],
  srcIP: ["10.0.0.4", "10.0.0.5", "10.0.0.7"],
  url: ["d.example", "e.example", "g.example"],
});
const cautioned = lt("cautioned", {
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
    const partial = lt("partial", { action: ["Allowed", "Allowed"], srcIP: ["a", "b", "c"] }, 3);
    expect(deriveValueDiscriminator(partial, [blocked], "cef")).toBeNull();
  });

  it("rejects a field that varies within its own log type", () => {
    // Enough events to clear the threshold, so this pins the single-value
    // guard rather than the evidence one.
    const mixed = lt("mixed", { action: ["Allowed", "Permitted", "Allowed"] });
    expect(deriveValueDiscriminator(mixed, [blocked], "cef")).toBeNull();
  });

  it("rejects a value a sibling also sends, case-insensitively", () => {
    // "ALLOWED" vs "Allowed" is the same log type to a vendor; a case-sensitive
    // filter would split one log type across two routes.
    const shouty = lt("shouty", { action: ["ALLOWED", "ALLOWED", "ALLOWED"] });
    expect(deriveValueDiscriminator(allowed, [shouty], "cef")).toBeNull();
  });

  it("rejects an id-like field, which varies per event", () => {
    // Well-evidenced log types, so the threshold is not what rejects this: a
    // session id takes a new value every event, so it is never constant and
    // can never become a route filter. `kind` is shared, so nothing survives.
    const own = lt("own", { sessionId: ["s-1", "s-2", "s-3"], kind: ["web", "web", "web"] });
    const others = Array.from({ length: 3 }, (_, i) =>
      lt(`sibling-${i}`, {
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
    const oneHost = lt("oneHost", { srcIP: ["10.0.0.9", "10.0.0.9", "10.0.0.9"] });
    const chatty = Array.from({ length: 3 }, (_, i) =>
      lt(`sibling-${i}`, {
        srcIP: [`10.1.${i}.1`, `10.1.${i}.2`, `10.1.${i}.3`, `10.1.${i}.4`],
      }),
    );
    expect(deriveValueDiscriminator(oneHost, chatty, "cef")).toBeNull();
  });

  it("returns null rather than guess when nothing separates the types", () => {
    const same = lt("same", { action: ["Allowed"] });
    expect(
      deriveValueDiscriminator(same, [lt("other", { action: ["Allowed"] })], "cef"),
    ).toBeNull();
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
    // The log type is TAGGED with the apostrophe value, so the name-match rule
    // is satisfied and escaping is what is under test.
    const tricky = lt("it's blocked", {
      action: ["it's blocked", "it's blocked", "it's blocked"],
    });
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
    const v = fieldValuesFromRecords("Allowed", [
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
    const v = fieldValuesFromRecords("a", [{ a: "1" }, {}, { a: "2" }]);
    expect(v.eventCount).toBe(3);
    expect(v.values.a).toHaveLength(2);
  });

  it("drops nested values rather than inventing a string for them", () => {
    const v = fieldValuesFromRecords("y", [{ nested: { x: 1 }, list: [1, 2], ok: "y" }]);
    expect(v.values.nested).toBeUndefined();
    expect(v.values.list).toBeUndefined();
    expect(v.values.ok).toEqual(["y"]);
  });

  it("keeps numbers and booleans, which vendors use as discriminators", () => {
    const v = fieldValuesFromRecords("200", [{ code: 200, ok: true }]);
    expect(v.values.code).toEqual(["200"]);
    expect(v.values.ok).toEqual(["true"]);
  });

  it("feeds a working discriminator straight from records", () => {
    const allow = fieldValuesFromRecords("Allowed", [
      { action: "Allowed", ip: "1.1.1.1" },
      { action: "Allowed", ip: "2.2.2.2" },
      { action: "Allowed", ip: "5.5.5.5" },
    ]);
    const block = fieldValuesFromRecords("Blocked", [
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
    const allowedTls = lt("allowedTls", { client_tls_sig_pqc_offers: ["1", "1", "1"] });
    const blockedTls = lt("blockedTls", { client_tls_sig_pqc_offers: ["0", "2", "3"] });
    expect(deriveValueDiscriminator(allowedTls, [blockedTls], "cef")).toBeNull();
  });

  it("picks the real discriminator when both are present", () => {
    const allowedTls = lt("allowedTls", {
      client_tls_sig_pqc_offers: ["1", "1", "1"],
      act: ["Allowed", "Allowed", "Allowed"],
    });
    const blockedTls = lt("blockedTls", {
      client_tls_sig_pqc_offers: ["0", "2", "3"],
      act: ["Blocked", "Blocked", "Blocked"],
    });
    const filter = deriveValueDiscriminator(allowedTls, [blockedTls], "cef") ?? "";
    expect(filter).toContain("act === 'Allowed'");
    expect(filter).not.toContain("client_tls_sig_pqc_offers");
  });

  it("REJECTS a field two log types happen to share a value on", () => {
    // Same value in a sibling is not a column, even though each is constant.
    const a = lt("a", { tier: ["gold", "gold", "gold"], act: ["A", "A", "A"] });
    const b = lt("b", { tier: ["gold", "gold", "gold"], act: ["B", "B", "B"] });
    const filter = deriveValueDiscriminator(a, [b], "cef") ?? "";
    expect(filter).not.toContain("tier");
    expect(filter).toContain("act === 'A'");
  });

  it("ACCEPTS a field a sibling does not carry at all", () => {
    // Absence is not a clash: the sibling simply never matches the filter.
    const web = lt("news", {
      urlCategory: ["news", "news", "news"],
      shared: ["x", "x", "x"],
    });
    const fw = lt("fw", { shared: ["x", "x", "x"] });
    const filter = deriveValueDiscriminator(web, [fw], "cef") ?? "";
    expect(filter).toContain("urlCategory === 'news'");
  });

  it("still separates a genuine action column across three log types", () => {
    // The case the whole feature exists for must survive the tightening.
    const A = lt("A", { act: ["Allowed", "Allowed", "Allowed"], ip: ["1", "2", "9"] });
    const B = lt("B", { act: ["Blocked", "Blocked", "Blocked"], ip: ["3", "4", "10"] });
    const C = lt("C", { act: ["Cautioned", "Cautioned", "Cautioned"], ip: ["5", "6", "11"] });
    expect(deriveValueDiscriminator(A, [B, C], "cef")).toContain("act === 'Allowed'");
    expect(deriveValueDiscriminator(B, [A, C], "cef")).toContain("act === 'Blocked'");
    expect(deriveValueDiscriminator(C, [A, B], "cef")).toContain("act === 'Cautioned'");
  });

  it("returns null when the only candidates are incidental", () => {
    // Nothing column-shaped: the caller placeholders the log type, which is
    // the honest outcome rather than a filter built on coincidence.
    const own = lt("own", { noise: ["7", "7", "7"], shared: ["s", "s", "s"] });
    const sib = lt("sib", { noise: ["8", "9", "12"], shared: ["s", "s", "s"] });
    expect(deriveValueDiscriminator(own, [sib], "cef")).toBeNull();
  });
});
/**
 * THE VALUE MUST NAME THE LOG TYPE (user decision 2026-08-17).
 *
 * This replaced an evidence threshold that judged candidates by how many
 * events backed them, and the suggestion tier that threshold produced. The
 * governing principle now: "each vendor log type can be defined with the
 * contents of the log itself" - so the field that defines a log type carries a
 * value that NAMES it. Where the samples do not show such a field, the log type
 * gets a placeholder for the operator rather than the generator's best guess.
 *
 * Measured on the live Zscaler pack, the old ranking offered
 * client_tls_sig_pqc_offers === '1' for ALLOWED and
 * client_tls_keyex_hybrid_offers === '0' for web-BLOCKED - TLS capability
 * flags that are structurally perfect discriminator columns and mean nothing.
 * Three of four offers were wrong and one click from being applied.
 */
describe("deriveValueDiscriminator - the value must name the log type", () => {
  it("picks the naming field even when an incidental one scores better", () => {
    // Both fields are perfect columns. The TLS flag is carried by one MORE log
    // type than `action`, so every purely statistical ranking - fewest distinct
    // values or most - prefers it over the real discriminator. Only the
    // name-match rule rejects it, which is what this pins: remove that guard
    // and this test must fail, not coast on the sort order.
    const allowed = lt("ALLOWED", {
      action: ["Allowed", "Allowed", "Allowed"],
      client_tls_sig_pqc_offers: ["1", "1", "1"],
    });
    const blocked = lt("BLOCKED", {
      action: ["Blocked", "Blocked", "Blocked"],
      client_tls_sig_pqc_offers: ["2", "2", "2"],
    });
    const cautioned = lt("CAUTIONED", {
      action: ["Cautioned", "Cautioned", "Cautioned"],
      client_tls_sig_pqc_offers: ["3", "3", "3"],
    });
    // Carries the TLS flag but no `action` at all, so tls spans 4 log types
    // and action only 3.
    const tunnel = lt("tunnel", { client_tls_sig_pqc_offers: ["4", "4", "4"] });

    const filter =
      deriveValueDiscriminator(allowed, [blocked, cautioned, tunnel], "cef") ?? "";
    expect(filter).toContain("action === 'Allowed'");
    expect(filter).not.toContain("client_tls_sig_pqc_offers");
  });

  it("rejects a perfect column that names nothing, rather than guessing", () => {
    // The exact live defect: the only column-shaped field is incidental. The
    // answer is a placeholder, not the field that happens to partition.
    const allowed = lt("ALLOWED", { client_tls_sig_pqc_offers: ["1", "1", "1"] });
    const blocked = lt("BLOCKED", { client_tls_sig_pqc_offers: ["0", "0", "0"] });
    expect(deriveValueDiscriminator(allowed, [blocked], "cef")).toBeNull();
  });

  it("applies on a SINGLE event when the value names the log type", () => {
    // The threshold is gone. One event of action="Cautioned" in CAUTIONED is
    // the vendor labelling its own log, not a small-sample coincidence - and
    // this is the case that used to yield a suggestion nobody could apply
    // without a click.
    const cautioned = lt("CAUTIONED", { action: ["Cautioned"] });
    const allowed = lt("ALLOWED", { action: ["Allowed"] });
    expect(deriveValueDiscriminator(cautioned, [allowed], "cef")).toContain(
      "action === 'Cautioned'",
    );
  });

  it("matches when the log type name CONTAINS the value", () => {
    // Tagged names carry a qualifier the vendor value does not: "Blocked"
    // defines web-BLOCKED. Exact matching would placeholder it.
    const webBlocked = lt("web-BLOCKED", { action: ["Blocked", "Blocked"] });
    const allowed = lt("ALLOWED", { action: ["Allowed", "Allowed"] });
    expect(deriveValueDiscriminator(webBlocked, [allowed], "cef")).toContain(
      "action === 'Blocked'",
    );
  });

  it("matches when the VALUE contains the log type name", () => {
    // The other direction: tagged "dns", vendor sends "dns-request".
    const dns = lt("dns", { event_type: ["dns-request", "dns-request"] });
    const other = lt("tunnel", { event_type: ["tunnel-open", "tunnel-open"] });
    expect(deriveValueDiscriminator(dns, [other], "json")).toContain(
      "event_type === 'dns-request'",
    );
  });

  it("is case-insensitive, because tag case is not vendor case", () => {
    const allowed = lt("allowed", { action: ["ALLOWED", "ALLOWED"] });
    const blocked = lt("blocked", { action: ["BLOCKED", "BLOCKED"] });
    expect(deriveValueDiscriminator(allowed, [blocked], "cef")).toContain(
      "action === 'ALLOWED'",
    );
  });

  it("still requires the column shape, name match or not", () => {
    // Two log types tagged from the same vendor value cannot be separated by
    // it - web-BLOCKED and firewall-BLOCKED both send action="Blocked". The
    // name matches for both; the column test is what refuses, and a
    // placeholder is the honest answer since one field cannot tell them apart.
    const webBlocked = lt("web-BLOCKED", { action: ["Blocked", "Blocked"] });
    const fwBlocked = lt("firewall-BLOCKED", { action: ["Blocked", "Blocked"] });
    expect(deriveValueDiscriminator(webBlocked, [fwBlocked], "cef")).toBeNull();
  });

  it("still requires the value to be constant within the log type", () => {
    // A field that only sometimes names the log type yields a filter that
    // misses the other events.
    const dns = lt("dns", { event_type: ["dns", "dns-tcp"] });
    const other = lt("tunnel", { event_type: ["tunnel", "tunnel"] });
    expect(deriveValueDiscriminator(dns, [other], "json")).toBeNull();
  });
});
