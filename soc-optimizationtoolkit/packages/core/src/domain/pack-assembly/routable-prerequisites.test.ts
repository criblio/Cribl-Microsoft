/**
 * Pins for the routable-pack prerequisite check (GEN-16).
 *
 * The check exists because a routable pack ships no destination and hands its
 * events back to the worker group, so a group with nothing to send to swallows
 * them. What it may NEVER do is claim a destination is missing when it is
 * sitting there under a name this code failed to match - that turns a helpful
 * warning into one the operator learns to ignore. Most of these pins are aimed
 * at that failure rather than at the happy path.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_CRIBL_OPTIONS, destinationIdFromOptions } from "../option-forms";
import { checkRoutablePrerequisites } from "./routable-prerequisites";

describe("checkRoutablePrerequisites", () => {
  it("reports a table whose destination the group already has", () => {
    const r = checkRoutablePrerequisites(
      ["CommonSecurityLog"],
      ["MS-Sentinel-CommonSecurityLog-dest", "some-other-output"],
    );
    expect(r.missing).toHaveLength(0);
    // The FOUND id, not a boolean: the operator is told which output covers the
    // table, and a pin on a boolean would pass with the wrong one matched.
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]?.foundId).toBe("MS-Sentinel-CommonSecurityLog-dest");
  });

  it("reports a table the group has nothing for, naming DEPLOY's id", () => {
    const r = checkRoutablePrerequisites(["Syslog"], ["MS-Sentinel-Other-dest"]);
    expect(r.missing).toHaveLength(1);
    expect(r.missing[0]?.sentinelTable).toBe("Syslog");
    expect(r.missing[0]?.foundId).toBeNull();
    // Deploy's id is what the operator will actually end up with, so it is the
    // one worth printing. Asserting the exact string, because guidance naming
    // an id that never appears is worse than naming none.
    expect(r.missing[0]?.expectedId).toBe("MS-Sentinel-Syslog-dest");
  });

  it("matches case-insensitively, agreeing with onboard-table's reuse scan", () => {
    // The two must agree about whether an id is taken. If this were
    // case-sensitive, the check would report missing and Deploy would then find
    // the id taken and create a SECOND destination with a -N suffix.
    const r = checkRoutablePrerequisites(
      ["CommonSecurityLog"],
      ["ms-sentinel-commonsecuritylog-DEST"],
    );
    expect(r.missing).toHaveLength(0);
    expect(r.entries[0]?.foundId).toBe("ms-sentinel-commonsecuritylog-DEST");
  });

  describe("ONE id per table (GEN-18)", () => {
    // This block used to accept EITHER of two ids, because the pack generator
    // and Deploy sanitized table names differently: for "My-App_CL" the pack
    // said MS-Sentinel-My-App-dest and Deploy created MS-Sentinel-My_App-dest.
    // GEN-18 made the sanitizing rule the only one, so under the default
    // naming the pack targets exactly the id Deploy creates and the check
    // matches that id alone. Non-default naming is the block below.

    it("accepts the id DEPLOY creates for a table name with a hyphen", () => {
      const r = checkRoutablePrerequisites(
        ["My-App_CL"],
        ["MS-Sentinel-My_App-dest"],
      );
      expect(r.missing).toHaveLength(0);
      expect(r.entries[0]?.foundId).toBe("MS-Sentinel-My_App-dest");
    });

    it("reports MISSING when the group holds only the unsanitized id", () => {
      // The pack routes to MS-Sentinel-My_App-dest. An output under the old,
      // unsanitized spelling is not what the pack sends to, so counting it as
      // coverage would hide a destination the routes cannot reach.
      const r = checkRoutablePrerequisites(
        ["My-App_CL"],
        ["MS-Sentinel-My-App-dest"],
      );
      expect(r.missing).toHaveLength(1);
      expect(r.missing[0]?.expectedId).toBe("MS-Sentinel-My_App-dest");
      expect(r.missing[0]?.foundId).toBeNull();
    });

    it("carries exactly the keys of one id, with no second pack id", () => {
      const [entry] = checkRoutablePrerequisites(["My-App_CL"], []).entries;
      expect(Object.keys(entry ?? {}).sort()).toEqual([
        "expectedId",
        "foundId",
        "sentinelTable",
      ]);
      expect(entry?.expectedId).toBe("MS-Sentinel-My_App-dest");
    });
  });

  describe("the operator's destination prefix/suffix (GEN-18 follow-through)", () => {
    // Deploy names the destination from the stored CriblOptions prefix/suffix
    // (destinationIdFromOptions). This check used the fixed default, so an
    // operator with prefix "Sentinel-" deployed Sentinel-SecurityEvent-dest and
    // was then told MS-Sentinel-SecurityEvent-dest was missing - a warning
    // about an id nothing would ever create.
    const NAMING = { destinationPrefix: "Sentinel-", destinationSuffix: "-out" };

    it("matches the id Deploy creates under a non-default prefix/suffix", () => {
      const r = checkRoutablePrerequisites(
        ["SecurityEvent", "My-App_CL"],
        ["Sentinel-SecurityEvent-out", "Sentinel-My_App-out"],
        NAMING,
      );
      expect(r.missing).toHaveLength(0);
      expect(r.entries.map((e) => e.foundId)).toEqual([
        "Sentinel-SecurityEvent-out",
        "Sentinel-My_App-out",
      ]);
    });

    it("names the OPTIONS id as missing, not the default one", () => {
      // A group holding only the default-named output is not covered: the pack
      // and Deploy both use the operator's naming, so the default id is a
      // destination nothing routes to.
      const r = checkRoutablePrerequisites(
        ["SecurityEvent"],
        ["MS-Sentinel-SecurityEvent-dest"],
        NAMING,
      );
      expect(r.missing).toHaveLength(1);
      expect(r.missing[0]?.expectedId).toBe("Sentinel-SecurityEvent-out");
      expect(r.missing[0]?.foundId).toBeNull();
    });

    it("expects exactly destinationIdFromOptions - the id Deploy is handed", () => {
      const tables = ["SecurityEvent", "My-App_CL", "Zscaler Web_CL"];
      const expected = checkRoutablePrerequisites(tables, [], NAMING).entries.map(
        (e) => e.expectedId,
      );
      expect(expected).toEqual(
        tables.map((t) => destinationIdFromOptions(t, NAMING)),
      );
      expect(expected).toEqual([
        "Sentinel-SecurityEvent-out",
        "Sentinel-My_App-out",
        "Sentinel-Zscaler_Web-out",
      ]);
    });

    it("omitted naming is the default options, id for id", () => {
      const tables = ["SecurityEvent", "My-App_CL"];
      expect(
        checkRoutablePrerequisites(tables, []).entries.map((e) => e.expectedId),
      ).toEqual(
        tables.map((t) => destinationIdFromOptions(t, DEFAULT_CRIBL_OPTIONS)),
      );
    });
  });

  it("collapses repeated tables to ONE entry, not one per route", () => {
    // A pack emits a reduction route and a transform route per log type, and
    // several log types can share a destination table. Three entries for one
    // destination reads as three problems and would have the operator hunting
    // for two things that do not exist.
    const r = checkRoutablePrerequisites(
      ["CloudflareV2_CL", "CloudflareV2_CL", "CloudflareV2_CL"],
      [],
    );
    expect(r.entries).toHaveLength(1);
    expect(r.missing).toHaveLength(1);
  });

  it("separates an EMPTY listing from a set of missing destinations", () => {
    // The inventory standard: an empty list is an unknown, not a zero. A failed
    // or unparseable listing arrives here as [] exactly like a genuinely empty
    // group, so the flag is what lets the caller word the two differently
    // instead of asserting the operator has nothing.
    const empty = checkRoutablePrerequisites(["Syslog"], []);
    expect(empty.listingWasEmpty).toBe(true);
    expect(empty.missing).toHaveLength(1);

    const populated = checkRoutablePrerequisites(["Syslog"], ["MS-Sentinel-Other-dest"]);
    expect(populated.listingWasEmpty).toBe(false);
    expect(populated.missing).toHaveLength(1);
  });

  it("reports nothing for a pack with no tables", () => {
    const r = checkRoutablePrerequisites([], []);
    expect(r.entries).toHaveLength(0);
    expect(r.missing).toHaveLength(0);
  });
});
