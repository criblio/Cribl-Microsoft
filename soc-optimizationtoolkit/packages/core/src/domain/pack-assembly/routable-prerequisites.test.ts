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

  describe("the two id conventions (GEN-18) - EITHER satisfies the check", () => {
    // defaultSentinelDestinationId maps non-alphanumerics to "_"; the pack's
    // destinationId does not. For "My-App_CL" that is MS-Sentinel-My_App-dest
    // against MS-Sentinel-My-App-dest. Whichever the group holds, the table IS
    // covered, and reporting it missing would send the operator to create a
    // duplicate of a destination they already have.

    it("accepts the id DEPLOY creates for a divergent table name", () => {
      const r = checkRoutablePrerequisites(
        ["My-App_CL"],
        ["MS-Sentinel-My_App-dest"],
      );
      expect(r.missing).toHaveLength(0);
      expect(r.entries[0]?.foundId).toBe("MS-Sentinel-My_App-dest");
    });

    it("accepts the id the PACK would use for a divergent table name", () => {
      const r = checkRoutablePrerequisites(
        ["My-App_CL"],
        ["MS-Sentinel-My-App-dest"],
      );
      expect(r.missing).toHaveLength(0);
      expect(r.entries[0]?.foundId).toBe("MS-Sentinel-My-App-dest");
    });

    it("carries BOTH ids on the entry, and they really do differ here", () => {
      // Guards the pins above against passing vacuously: if the two functions
      // were ever unified, the two cases above would become one case tested
      // twice and would stop covering what they claim to. This fails loudly at
      // that moment, and the fix is to collapse this describe block - see
      // GEN-18, whose resolution is exactly that.
      const [entry] = checkRoutablePrerequisites(["My-App_CL"], []).entries;
      expect(entry?.expectedId).toBe("MS-Sentinel-My_App-dest");
      expect(entry?.packId).toBe("MS-Sentinel-My-App-dest");
      expect(entry?.expectedId).not.toBe(entry?.packId);
    });

    it("leaves the two identical for an ordinary table name", () => {
      const [entry] = checkRoutablePrerequisites(["AWSVPCFlow"], []).entries;
      expect(entry?.expectedId).toBe(entry?.packId);
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
