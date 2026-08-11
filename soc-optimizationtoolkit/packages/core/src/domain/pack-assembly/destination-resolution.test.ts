/**
 * Contract tests for Sentinel destination resolution.
 *
 * THE FAILURE THESE GUARD IS SILENT AND SHIPPED. A pack whose destination
 * carries `dcr-00000000000000000000000000000000` installs cleanly, shows green,
 * and sends nothing anywhere. Nothing errors, because nothing is broken - the
 * config is simply pointed at a rule that does not exist. That is why the bug
 * survived: the only signal was data never arriving, days later.
 *
 * So the pins are about never producing a confident wrong answer:
 *   - a real value is used only when exactly one rule can serve the table;
 *   - ambiguity is REFUSED rather than resolved by picking;
 *   - every refusal carries a reason an operator can act on;
 *   - and the "some tables shipped placeholders" report can never be empty
 *     while placeholders were actually shipped.
 */
import { describe, expect, it } from "vitest";

import {
  placeholderWarning,
  resolveDestinationForTable,
  resolveDestinations,
  unresolvedDestinations,
} from "./destination-resolution";
import type { DcrDestinationSource, SessionDestination } from "./destination-resolution";

const dcr = (
  name: string,
  tables: string[],
  overrides: Partial<DcrDestinationSource> = {},
): DcrDestinationSource => ({
  name,
  immutableId: `dcr-${name}`,
  ingestionEndpoint: `https://${name}.ingest.monitor.azure.com`,
  tables,
  ...overrides,
});

describe("resolveDestinationForTable", () => {
  it("resolves the single rule that routes the table", () => {
    const found = resolveDestinationForTable("CommonSecurityLog", [
      dcr("a", ["Syslog"]),
      dcr("b", ["CommonSecurityLog"]),
    ]);
    expect(found.source).toBe("inventory");
    expect(found.dcrImmutableId).toBe("dcr-b");
    expect(found.ingestionEndpoint).toBe("https://b.ingest.monitor.azure.com");
    expect(found.dcrName).toBe("b");
  });

  it("matches on what the rule ROUTES, not on its name", () => {
    // Deliberately not name prediction: an operator who renamed a DCR, or
    // created it by hand, still gets resolved. Matching a predicted name would
    // silently miss both and fall back to placeholders.
    const found = resolveDestinationForTable("CommonSecurityLog", [
      dcr("something-nobody-would-predict", ["CommonSecurityLog"]),
    ]);
    expect(found.source).toBe("inventory");
    expect(found.dcrName).toBe("something-nobody-would-predict");
  });

  it("compares table names case-insensitively", () => {
    const found = resolveDestinationForTable("commonsecuritylog", [
      dcr("b", ["CommonSecurityLog"]),
    ]);
    expect(found.source).toBe("inventory");
  });

  it("REFUSES to pick when two rules route the same table", () => {
    // The load-bearing pin. Two rules for one table is a real situation (an old
    // rule and its replacement), and choosing either would bake the wrong
    // endpoint into a pack that installs without complaint. Both names go in
    // the reason so the operator can settle it.
    const found = resolveDestinationForTable("CommonSecurityLog", [
      dcr("old", ["CommonSecurityLog"]),
      dcr("new", ["CommonSecurityLog"]),
    ]);
    expect(found.source).toBe("unresolved");
    expect(found.dcrImmutableId).toBeUndefined();
    expect(found.reason).toContain("old");
    expect(found.reason).toContain("new");
  });

  it("says NO RULE ROUTES IT when nothing matches", () => {
    const found = resolveDestinationForTable("CommonSecurityLog", [
      dcr("a", ["Syslog"]),
    ]);
    expect(found.source).toBe("unresolved");
    expect(found.reason).toContain("no Data Collection Rule");
  });

  it("distinguishes a rule that CANNOT serve from no rule at all", () => {
    // Different problems, different fixes: one needs a DCR deployed, the other
    // needs a DIRECT one. A shared message would send the operator to deploy a
    // rule that already exists.
    const found = resolveDestinationForTable("CommonSecurityLog", [
      dcr("agent-kind", ["CommonSecurityLog"], { ingestionEndpoint: "" }),
    ]);
    expect(found.source).toBe("unresolved");
    expect(found.reason).toContain("logs-ingestion endpoint");
    expect(found.reason).toContain("agent-kind");
    expect(found.reason).not.toContain("no Data Collection Rule");
  });

  it("names the SYMPTOM, never a cause it has not established", () => {
    // Found walking a live lab 2026-08-11: a Kind "Windows" rule routes
    // WindowsEvent with no ingestion endpoint. The message used to blame
    // "DCE-based rules" - true for one cause of a blank endpoint, wrong for
    // this one, and it would send the operator hunting a DCE that never
    // existed. The inventory does not tell us WHY the endpoint is blank, so
    // the message must not claim to know.
    const found = resolveDestinationForTable("WindowsEvent", [
      dcr("dcr-WindowsEvent-paradigm-replica", ["WindowsEvent"], {
        ingestionEndpoint: "",
      }),
    ]);
    expect(found.reason).not.toContain("DCE");
    expect(found.reason).toContain("Direct DCR");
  });

  it("treats a rule missing its immutableId as unusable, not as a match", () => {
    // Half a value is worse than none - the composed URL would be malformed
    // and the failure would surface as an opaque ingestion error much later.
    const found = resolveDestinationForTable("CommonSecurityLog", [
      dcr("half", ["CommonSecurityLog"], { immutableId: "" }),
    ]);
    expect(found.source).toBe("unresolved");
  });

  it("NEVER returns values on an unresolved outcome", () => {
    for (const inventory of [
      [],
      [dcr("a", ["Syslog"])],
      [dcr("x", ["T"]), dcr("y", ["T"])],
      [dcr("d", ["T"], { ingestionEndpoint: "" })],
    ]) {
      const found = resolveDestinationForTable("T", inventory);
      if (found.source === "unresolved") {
        expect(found.dcrImmutableId).toBeUndefined();
        expect(found.ingestionEndpoint).toBeUndefined();
        expect(found.reason?.length ?? 0).toBeGreaterThan(20);
      }
    }
  });
});

describe("resolveDestinations", () => {
  const session: SessionDestination[] = [
    {
      table: "Syslog",
      dcrImmutableId: "dcr-session",
      ingestionEndpoint: "https://session.ingest.monitor.azure.com",
      destinationId: "renamed-by-deploy",
      streamName: "Custom-Syslog",
    },
  ];

  it("prefers this run's deploy outcome over the inventory", () => {
    // The session outcome names the rule just deployed FOR that table, with no
    // matching to get wrong. The inventory is the fallback, not the override.
    const [found] = resolveDestinations(
      ["Syslog"],
      session,
      [dcr("someone-else", ["Syslog"])],
    );
    expect(found?.source).toBe("session");
    expect(found?.dcrImmutableId).toBe("dcr-session");
  });

  it("carries the names the DEPLOY actually used, not the predicted ones", () => {
    // The deploy renames a destination that exists and points elsewhere. If the
    // pack kept the prediction it would define a destination under a name
    // nothing routes to - a second silent no-op.
    const [found] = resolveDestinations(["Syslog"], session, []);
    expect(found?.destinationId).toBe("renamed-by-deploy");
    expect(found?.streamName).toBe("Custom-Syslog");
  });

  it("falls back to the inventory for tables this session did not deploy", () => {
    // THE REPORTED BUG. Session state is cleared on reload; the DCRs are not.
    const found = resolveDestinations(
      ["Syslog", "CommonSecurityLog"],
      session,
      [dcr("csl", ["CommonSecurityLog"])],
    );
    expect(found.map((f) => f.source)).toEqual(["session", "inventory"]);
    expect(found[1]?.dcrImmutableId).toBe("dcr-csl");
  });

  it("resolves EVERY table from an empty session when Azure knows them", () => {
    // The exact reload case: nothing in memory, everything in Azure.
    const found = resolveDestinations(
      ["Syslog", "CommonSecurityLog"],
      [],
      [dcr("a", ["Syslog"]), dcr("b", ["CommonSecurityLog"])],
    );
    expect(found.every((f) => f.source === "inventory")).toBe(true);
  });

  it("returns one result per table, in input order, always", () => {
    const found = resolveDestinations(["A", "B", "C"], [], []);
    expect(found.map((f) => f.table)).toEqual(["A", "B", "C"]);
  });
});

describe("placeholderWarning - the fallback can never be silent", () => {
  // RE-PINNED 2026-08-11 by the architecture audit. This took the resolutions
  // and derived its own list of unresolved tables, while the deploy summary read
  // assemblePack's placeholderTables - two independent answers to "which tables
  // shipped placeholders", BOTH shown to the operator, agreeing only because one
  // caller happened to supply a destination exactly when a table resolved. It
  // now takes the artifact's list, so the two surfaces cannot diverge.
  const tablesOf = (resolved: ReturnType<typeof resolveDestinations>) =>
    unresolvedDestinations(resolved).map((r) => r.table);

  it("is null when the pack shipped no placeholders", () => {
    const resolved = resolveDestinations(["Syslog"], [], [dcr("a", ["Syslog"])]);
    expect(placeholderWarning(tablesOf(resolved), resolved)).toBeNull();
    expect(unresolvedDestinations(resolved)).toHaveLength(0);
  });

  it("names every placeholder table AND why", () => {
    const resolved = resolveDestinations(["Syslog", "WindowsEvent"], [], []);
    const warning = placeholderWarning(tablesOf(resolved), resolved);
    expect(warning).toContain("Syslog");
    expect(warning).toContain("WindowsEvent");
    expect(warning).toContain("2 table(s)");
    // The consequence, stated - not just a count. An operator who reads only
    // this line must still know the pack does not work yet.
    expect(warning).toContain("point nowhere");
  });

  it("warns whenever ANY table shipped placeholders, even if others are fine", () => {
    // A partial success is the dangerous shape: the summary looks green because
    // most tables worked.
    const resolved = resolveDestinations(
      ["Syslog", "WindowsEvent"],
      [],
      [dcr("a", ["Syslog"])],
    );
    const warning = placeholderWarning(tablesOf(resolved), resolved);
    expect(warning).not.toBeNull();
    expect(warning).toContain("WindowsEvent");
    expect(warning).toContain("1 table(s)");
  });

  it("WARNS ABOUT A TABLE IT CANNOT EXPLAIN", () => {
    // The whole reason the artifact decides which. If the pack emitted
    // placeholders for a table the resolutions say nothing about, staying quiet
    // would be the original bug - unexplained is bad, unmentioned is worse.
    const warning = placeholderWarning(["Syslog"], []);
    expect(warning).toContain("Syslog");
    expect(warning).toContain("no destination values were supplied");
  });

  it("is driven by the ARTIFACT, not by the resolutions", () => {
    // A table that resolved cleanly but shipped placeholders anyway (a caller
    // that built its inputs some other way) must still be reported.
    const resolved = resolveDestinations(["Syslog"], [], [dcr("a", ["Syslog"])]);
    expect(resolved[0]?.source).toBe("inventory");
    expect(placeholderWarning(["Syslog"], resolved)).toContain("Syslog");
    // And the converse: nothing shipped, nothing warned about.
    expect(placeholderWarning([], resolveDestinations(["Syslog"], [], []))).toBeNull();
  });
});
