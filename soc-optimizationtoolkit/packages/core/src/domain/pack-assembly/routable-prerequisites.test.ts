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
    // GEN-18 made the sanitizing rule the only one, so the pack now targets
    // exactly the id Deploy creates and the check matches that id alone.

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
