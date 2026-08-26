/**
 * Pins for guessTimestampField's EVIDENCE ORDER (2026-08-26).
 *
 * The legacy picker walked a hardcoded candidate-name list first and only fell
 * through to a datetime-typed field when no name matched, so the two things the
 * parser knows about a field - what it is called and what its values look like -
 * were never weighed against each other. Both failures below were observed in
 * the running app against real vendor data, and both are the same shape: a name
 * match beating evidence that contradicted it.
 *
 * WHY THIS MATTERS BEYOND A LABEL. The guessed field is what the pack's pipeline
 * and the DCR's transform key their time on. A field that cannot carry a full
 * instant (FortiGate's `time`), or that will not exist on live events at all
 * (Cribl Search's `_time`), produces a pack that previews perfectly against the
 * sample in hand and breaks the moment the real source sends anything.
 *
 * The legacy behaviour that was KEPT is pinned here too, deliberately beside the
 * behaviour that changed: sample-parsing.test.ts already owns the general
 * guessTimestampField vectors, and nothing there was weakened to make this pass.
 */

import { describe, expect, it } from "vitest";

import { collectFields, guessTimestampField } from "./parse-sample";

describe("guessTimestampField - FortiGate, live 2026-08-26", () => {
  /**
   * The shape FortiGate actually emits: a `date` and a `time` that are only a
   * timestamp TOGETHER, plus `eventtime`, a genuine epoch second. The picker
   * chose `time`.
   */
  const FORTIGATE = [
    {
      date: "2026-08-26",
      time: "21:15:15",
      eventtime: "1787702775",
      devname: "FGT60F",
      type: "event",
    },
  ];

  it("does NOT pick a bare time of day, however perfectly it is named", () => {
    const fields = collectFields(FORTIGATE);
    // The value is the evidence: "21:15:15" carries no date, so it cannot order
    // two events a day apart and cannot become a TimeGenerated. `time` is the
    // third entry in the candidate list and won on the name alone.
    expect(fields.find((f) => f.name === "time")?.type).toBe("string");
    expect(guessTimestampField(fields)).not.toBe("time");
  });

  it("picks `eventtime`, which the list only knew how to spell `eventTime`", () => {
    // FortiGate emits lowercase. The list carries camelCase. An exact-string
    // match made a real epoch second invisible, so the picker fell through to
    // the clock reading beside it.
    expect(guessTimestampField(collectFields(FORTIGATE))).toBe("eventtime");
  });

  it("falls to `date` when the epoch field is absent - never back to `time`", () => {
    // A date with no clock is a poorer answer than an epoch and a better one
    // than a clock with no date: it at least names the day the event happened.
    const fields = collectFields([
      { date: "2026-08-26", time: "21:15:15", devname: "FGT60F" },
    ]);
    expect(guessTimestampField(fields)).toBe("date");
  });

  it("keeps a `time` field that sometimes holds a full stamp", () => {
    // Disqualification is on the VALUES, and only when every collected example
    // is a bare clock reading. One full stamp is enough to keep the field.
    const fields = collectFields([
      { time: "21:15:15" },
      { time: "2026-08-26T21:15:15Z" },
    ]);
    expect(guessTimestampField(fields)).toBe("time");
  });

  it("guesses NOTHING rather than handing back an unusable field", () => {
    // With the clock reading disqualified and nothing else to offer, the honest
    // answer is no guess at all - the operator picks. Returning `time` here
    // would be a confident wrong answer, which is the more expensive failure:
    // it is silently accepted and ships in the pack.
    const fields = collectFields([{ time: "21:15:15", devname: "FGT60F" }]);
    expect(guessTimestampField(fields)).toBeUndefined();
  });
});

describe("guessTimestampField - Okta, live 2026-08-26", () => {
  /**
   * An Okta System Log event as it arrives from a Lake-sourced sample: the
   * vendor's own `published`, plus `_time`, which Cribl Search adds. The picker
   * chose `_time` - LAST in the candidate list, and still ahead of a field that
   * was not in the list at all.
   */
  const OKTA = [
    {
      published: "2026-08-26T13:19:47.000Z",
      _time: 1787743187,
      eventType: "user.session.start",
      severity: "INFO",
      displayMessage: "User login to Okta",
    },
  ];

  it("prefers the vendor's datetime field over Cribl Search's synthetic `_time`", () => {
    const fields = collectFields(OKTA);
    expect(fields.find((f) => f.name === "published")?.type).toBe("datetime");
    // `_time` exists in this sample and will NOT exist on events arriving from
    // the real Okta source. A pipeline or DCR generated from it looks right in
    // the preview and breaks in production, which is why a `_`-prefixed field
    // loses every tie to a real one.
    expect(guessTimestampField(fields)).toBe("published");
  });

  it("still returns `_time` when it is genuinely all there is", () => {
    // Demoted, never excluded: a sample carrying nothing else is better served
    // by a guess it can override than by silence.
    const fields = collectFields([{ _time: "2026-08-26T13:19:47.000Z", msg: "x" }]);
    expect(guessTimestampField(fields)).toBe("_time");
  });

  it("loses to a real field with ANY evidence, not just a stronger tier", () => {
    // Synthetic is the OUTERMOST key rather than a tiebreak inside one, and this
    // is why: `_time` is IN the candidate list, so a name-versus-name contest
    // hands it the win over a vendor field the list has never heard of. Here the
    // only competition is a name that merely contains "time" - the weakest tier
    // there is - and it still wins, because a field that will not exist on live
    // events is worth less than a weak guess at one that will.
    const fields = collectFields([{ _time: "2026-08-26T13:19:47.000Z", uptime: "37" }]);
    expect(guessTimestampField(fields)).toBe("uptime");
  });

  it("lets a datetime-typed field beat a differently-named NON-datetime one", () => {
    // The general rule the Okta case is one instance of. `eventType` is not a
    // timestamp at all; `published` is typed one. Before this, neither was
    // named in the candidate list and the DATETIME evidence was only consulted
    // after every name had been tried.
    const fields = collectFields([
      { logSourceLabel: "okta", published: "2026-08-26T13:19:47.000Z" },
    ]);
    expect(guessTimestampField(fields)).toBe("published");
  });
});

describe("guessTimestampField - the ranking, stated directly", () => {
  it("keeps a NAMED epoch field ahead of a stranger's datetime (legacy, unchanged)", () => {
    // The behaviour sample-parsing.test.ts has always pinned, restated here so
    // a future change to the tiers has to face it: `timestamp` holding an
    // epoch-ms string IS the event time, and an unrelated field that happens to
    // be ISO-shaped is not. Type evidence outranks a name guess only where the
    // name has no type evidence of its own to stand on.
    const fields = collectFields([
      { timestamp: "1700000000000", other: "2024-01-01T00:00:00Z" },
    ]);
    expect(guessTimestampField(fields)).toBe("timestamp");
  });

  it("puts AGREEMENT first - a named datetime beats a named epoch", () => {
    const fields = collectFields([
      { timestamp: "1700000000000", event_time: "2024-01-01T00:00:00Z" },
    ]);
    // `timestamp` outranks `event_time` in the candidate list, but the tier is
    // read before the rank: two kinds of evidence agreeing beats one.
    expect(guessTimestampField(fields)).toBe("event_time");
  });

  it("breaks a tier tie on the candidate list's own order", () => {
    const fields = collectFields([
      { receive_time: "2024-01-01T00:00:00Z", TimeGenerated: "2024-01-01T00:00:00Z" },
    ]);
    // Both named, both datetime. `TimeGenerated` sits earlier in the list, and
    // that list order is still what settles it.
    expect(guessTimestampField(fields)).toBe("TimeGenerated");
  });

  it("matches a candidate name regardless of case and separators", () => {
    for (const name of ["EVENTTIME", "event_time", "Event-Time", "eventTime"]) {
      const fields = collectFields([{ [name]: "1787702775", host: "a" }]);
      expect(guessTimestampField(fields)).toBe(name);
    }
  });

  it("never returns a boolean or an object field", () => {
    // Both are named like timestamps and neither can be one.
    const withBool = collectFields([{ timestamp: true, other: "x" }]);
    expect(guessTimestampField(withBool)).toBeUndefined();
    const withObject = collectFields([{ eventTime: { $date: 1 }, other: "x" }]);
    expect(guessTimestampField(withObject)).toBeUndefined();
  });

  it("is stable for one input - first seen wins an outright tie", () => {
    const fields = collectFields([
      { alpha_time: "hello", beta_time: "hello" },
    ]);
    expect(guessTimestampField(fields)).toBe("alpha_time");
  });
});
