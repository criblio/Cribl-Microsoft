// Pins for HON-5: a CSV vendor is told BEFORE the preview that their pack can
// never route automatically.
//
// The distinction these protect is the whole point. A placeholder filter has
// two very different causes, and the generic message is right for one of them
// and actively misleading for the other: told "no discriminator found", a CSV
// operator goes and collects more samples, which cannot possibly help, because
// both discriminators early-return on "csv" by construction.

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
  it("says CSV cannot, and everything else can", () => {
    expect(formatCanDiscriminate("csv")).toBe(false);
    expect(formatCanDiscriminate("CSV")).toBe(false);
    for (const f of ["cef", "json", "ndjson", "leef", "kv", "syslog"]) {
      expect(formatCanDiscriminate(f), f).toBe(true);
    }
  });

  it("AGREES with the two discriminators it is describing", () => {
    // This predicate is a claim ABOUT other code. If either discriminator ever
    // learns to handle CSV, or another format starts early-returning, the
    // warning becomes a lie - and nothing else here would notice.
    expect(deriveRouteDiscriminator(["a"], [new Set(["b"])], "csv")).toBeNull();
    expect(
      deriveValueDiscriminator(
        { logType: "TRAFFIC", eventCount: 1, values: { a: ["1"] } },
        [{ logType: "THREAT", eventCount: 1, values: { b: ["2"] } }],
        "csv",
      ),
    ).toBeNull();
    // And the control, which is what makes the two assertions above mean
    // something: the SAME call on a non-CSV format really does produce a
    // filter, so the nulls are about CSV and not about the inputs.
    expect(
      deriveRouteDiscriminator(["unique_field"], [new Set(["other"])], "cef"),
    ).not.toBeNull();
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
