// Pins for HON-5: a COLUMN-ORDER vendor is told BEFORE the preview that their
// pack can never route automatically.
//
// The distinction these protect is the whole point. A placeholder filter has
// two very different causes, and the generic message is right for one of them
// and actively misleading for the other: told "no discriminator found", such an
// operator goes and collects more samples, which cannot possibly help, because
// both discriminators return null for these formats by construction.
//
// "CSV" WAS ONLY HALF THE SET UNTIL 2026-09-03. `formatCanDiscriminate` tested
// `format !== "csv"`, so `positional` - whitespace columns, AWS VPC Flow and
// friends, taught to the parser and the pipeline by GEN-6 - answered TRUE and
// got a filter over names that exist only after the pipeline extracts. The
// route ran first, so every disjunct was false; and because a filter had been
// produced the log type was neither a placeholder nor "unreachable", so the
// pack previewed clean and HON-5's own warning stayed silent, telling nobody.

import { describe, expect, it } from "vitest";
import {
  csvRoutingWarning,
  formatCanDiscriminate,
  isPlaceholderFilter,
  placeholderRouteFilter,
} from "./route-placeholder";
import { deriveRouteDiscriminator } from "./route-discriminator";
import { deriveValueDiscriminator } from "./route-value-discriminator";

describe("formatCanDiscriminate", () => {
  it("says the COLUMN-ORDER formats cannot, and the rest can", () => {
    expect(formatCanDiscriminate("csv")).toBe(false);
    expect(formatCanDiscriminate("CSV")).toBe(false);
    // The half that was missing. A positional event carries values in column
    // order exactly as a CSV row does; only the separator differs.
    expect(formatCanDiscriminate("positional")).toBe(false);
    expect(formatCanDiscriminate("POSITIONAL")).toBe(false);
    for (const f of ["cef", "json", "ndjson", "leef", "kv", "syslog"]) {
      expect(formatCanDiscriminate(f), f).toBe(true);
    }
  });

  /**
   * `syslog` IS STILL TRUE HERE AND THAT IS NOT AN OVERSIGHT.
   *
   * Measured the same way as positional on 2026-09-03: every name parseSyslog
   * produces is absent from the raw line (Timestamp, Hostname, Program, PID,
   * Message; RFC 5424 adds Priority, Version, AppName, ProcID, MsgID), so a
   * syslog route filter dead-ends the same way. It is left TRUE because its
   * cause is a regex capture rather than a column position, so it needs its own
   * operator wording, and because a defect found in committed code becomes a
   * card before it is fixed. This assertion records what the code does today,
   * not what is correct - when the card lands, this line moves to `false` and
   * the note goes with it.
   */
  it("does NOT yet cover syslog, whose names are minted just as thoroughly", () => {
    expect(formatCanDiscriminate("syslog")).toBe(true);
  });

  it("AGREES with the two discriminators it is describing", () => {
    // This predicate is a claim ABOUT other code. If either discriminator ever
    // learns to handle a column-order format, or another format starts
    // returning null, the warning becomes a lie - and nothing else would notice.
    //
    // THE VALUE FIXTURE HAS TO QUALIFY ON EVERY OTHER GUARD or this assertion
    // is theatre, and the one that stood here until 2026-09-03 did not.
    // It was `{ a: ["1"] }` for log type TRAFFIC against a sibling carrying
    // only `b`, and "1" does not NAME TRAFFIC - so it dies on guard 0, before
    // the format ever matters. Measured: that fixture returns null on "cef"
    // too, so the format gate cannot have been what produced its null and the
    // assertion would have survived deleting the gate outright.
    // `a: ["TRAFFIC"]` against a sibling `a: ["THREAT"]` names its log type, is
    // constant, and is column-shaped, so it yields a filter on "cef" (asserted
    // below) and the format gate is the only thing left that can null it.
    const own = { logType: "TRAFFIC", eventCount: 1, values: { a: ["TRAFFIC"] } };
    const sibs = [
      { logType: "THREAT", eventCount: 1, values: { a: ["THREAT"] } },
    ];
    for (const format of ["csv", "positional"]) {
      expect(
        deriveRouteDiscriminator(["a"], [new Set(["b"])], format),
        format,
      ).toBeNull();
      expect(deriveValueDiscriminator(own, sibs, format), format).toBeNull();
    }
    // And the controls, which are what make the assertions above mean
    // something: the SAME inputs on a routable format really do produce a
    // filter, so the nulls are about the format and not about the fixtures.
    expect(
      deriveRouteDiscriminator(["unique_field"], [new Set(["other"])], "cef"),
    ).not.toBeNull();
    expect(deriveValueDiscriminator(own, sibs, "cef")).toContain(
      "a === 'TRAFFIC'",
    );
  });
});

describe("csvRoutingWarning", () => {
  it("warns a CSV log type that has siblings", () => {
    const text = csvRoutingWarning("csv", 3);

    expect(text).toContain("cannot be routed automatically");
    // The actionable half: stop collecting samples, write the filter.
    expect(text).toContain("more samples will not change that");
    expect(text).toContain("placeholder filter");
  });

  it("warns a POSITIONAL log type too, and says so in words", () => {
    const text = csvRoutingWarning("positional", 3) ?? "";

    expect(text).toContain("cannot be routed automatically");
    expect(text).toContain("more samples will not change that");
    expect(text).toContain("placeholder filter");
    // HON-5's cause has to stay TRUE of the operator reading it. A VPC Flow
    // operator handed a warning that names CSV alone goes looking for a CSV
    // bug they do not have, which is the same wrong-cause failure HON-5 was
    // written to prevent - one step further down.
    expect(text).toContain("whitespace-positional");
  });

  it("gives both formats the SAME text, because it is one cause", () => {
    // A CSV row and a whitespace-positional line differ only in separator, so
    // two messages here would be two chances to get the reason wrong.
    expect(csvRoutingWarning("positional", 2)).toBe(csvRoutingWarning("csv", 2));
  });

  it("stays SILENT for a single-log-type positional pack, as for CSV", () => {
    // Same argument, same threshold: plan.ts runs the ladder only when
    // `tables.length > 1`, so a lone positional log type keeps a working
    // match-all and warning about it would be crying wolf.
    expect(csvRoutingWarning("positional", 0)).toBeNull();
  });

  it("stays SILENT for a single-log-type CSV pack", () => {
    // plan.ts only runs the discriminator ladder `if (tables.length > 1)`, so a
    // lone CSV log type keeps a working match-all. Warning there would be
    // crying wolf about a pack that routes correctly - the DBT-19 failure this
    // repo has already had twice.
    expect(csvRoutingWarning("csv", 0)).toBeNull();
  });

  it("stays silent for every format that CAN discriminate", () => {
    for (const f of ["cef", "json", "ndjson", "leef", "kv"]) {
      expect(csvRoutingWarning(f, 5), f).toBeNull();
    }
  });

  it("does not promise the route is missing - the pack still ships it", () => {
    // The placeholder keeps the route AND the pipeline; only the filter is
    // unfinished. An operator who reads this as "no route was generated" would
    // go looking for a bug that is not there.
    const text = csvRoutingWarning("csv", 2) ?? "";

    expect(text).toContain("Its route ships with");
    expect(text).not.toContain("dropped");
  });
});

describe("placeholderRouteFilter - unchanged by HON-5", () => {
  it("still never matches and still names its log type", () => {
    const filter = placeholderRouteFilter("TRAFFIC");

    expect(isPlaceholderFilter(filter)).toBe(true);
    expect(filter).toContain("TRAFFIC");
  });
});
