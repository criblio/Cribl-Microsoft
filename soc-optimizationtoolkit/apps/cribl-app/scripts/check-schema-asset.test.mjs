/**
 * Pins for the schema-asset checker (DBT-69).
 *
 * This is the gate that exists because a generator crashed for seven weeks and
 * nothing reported it - and until now it was the one gate script with no test
 * of its own, so if it stopped detecting drift it would read green while
 * guarding nothing. It has already failed that way once: DBT-70, where it
 * compared raw bytes and so reported a mismatch on every Windows run while
 * listing ZERO differing tables. The first describe below is that defect,
 * stated as a fixture.
 *
 * The two halves are pinned separately on purpose. `compareAssets` is pure over
 * two strings, so the line-ending cases can be written down exactly rather than
 * depending on how git happened to check the repo out. `checkSchemaAsset` takes
 * its IO as arguments, so the restore-in-finally can be observed without
 * spawning the real generator or touching the committed asset - a test that
 * shelled out would be slow, and would have to trust the very filesystem
 * behaviour it is meant to be checking.
 */

import { describe, expect, it } from "vitest";
import {
  checkSchemaAsset,
  compareAssets,
  GENERATOR_FAILED_MESSAGE,
  MATCHES_MESSAGE,
} from "./check-schema-asset.mjs";

// Built from char codes rather than escapes: these fixtures are load-bearing,
// and a CR that an editor or a tool quietly normalised away would leave the
// DBT-70 pin below passing while testing nothing.
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

/** What a git checkout with core.autocrlf=true hands back. */
const asCrlf = (text) => text.split(LF).join(CR + LF);

/** The generator's exact output shape: 2-space JSON, trailing newline, LF. */
const asAsset = (tables) => JSON.stringify(tables, null, 2) + LF;

const TABLES = {
  ADAssessmentRecommendation: [{ name: "ActionArea", type: "string" }],
  SecurityEvent: [
    { name: "EventID", type: "int" },
    { name: "TimeGenerated", type: "datetime" },
  ],
};

/** ADR 0004's correction - the very edit the stale asset was hiding. */
const GUID_CORRECTED = {
  ...TABLES,
  SecurityEvent: [
    { name: "EventID", type: "int" },
    { name: "TimeGenerated", type: "datetime" },
    { name: "SubjectUserSid", type: "string" },
  ],
};

describe("the fixtures themselves", () => {
  it("really does produce CRLF on one side and LF on the other", () => {
    // Without this the DBT-70 pin is unfalsifiable: if asCrlf ever stopped
    // inserting CR, comparing two identical LF strings would still pass.
    expect(asCrlf(asAsset(TABLES))).toContain(CR);
    expect(asAsset(TABLES)).not.toContain(CR);
  });
});

describe("compareAssets", () => {
  it("does NOT call a CRLF checkout drift - this is DBT-70 exactly", () => {
    const result = compareAssets({
      committed: asCrlf(asAsset(TABLES)),
      regenerated: asAsset(TABLES),
    });

    expect(result.matches).toBe(true);
    expect(result.changed).toEqual([]);
    expect(result.message).toBe(MATCHES_MESSAGE);
  });

  it("REPORTS a real difference", () => {
    const result = compareAssets({
      committed: asAsset(TABLES),
      regenerated: asAsset(GUID_CORRECTED),
    });

    expect(result.matches).toBe(false);
    expect(result.changed).toEqual(["SecurityEvent"]);
  });

  it("names the differing tables in the message, and only those", () => {
    // The names are the operator's whole lead on what to regenerate and what
    // it changed. "0 table(s) differ" next to a mismatch is the DBT-70
    // fingerprint, so the count and the names both have to be real.
    const result = compareAssets({
      committed: asAsset(TABLES),
      regenerated: asAsset(GUID_CORRECTED),
    });

    expect(result.message).toContain("1 table(s) differ: SecurityEvent");
    expect(result.message).not.toContain("ADAssessmentRecommendation");
  });

  it("still finds real drift when the committed side is CRLF", () => {
    // The pair that matters: normalising must make the line endings invisible
    // WITHOUT making the data invisible. A "fix" that returned equal for every
    // CRLF input would pass the first pin in this file and fail this one.
    const result = compareAssets({
      committed: asCrlf(asAsset(TABLES)),
      regenerated: asAsset(GUID_CORRECTED),
    });

    expect(result.matches).toBe(false);
    expect(result.changed).toEqual(["SecurityEvent"]);
  });

  it("counts a table the templates added and a table they dropped", () => {
    const { ADAssessmentRecommendation: _dropped, ...withoutOne } = TABLES;
    const result = compareAssets({
      committed: asAsset(TABLES),
      regenerated: asAsset({ ...withoutOne, Syslog: [{ name: "Facility", type: "string" }] }),
    });

    expect(result.matches).toBe(false);
    expect(result.changed.sort()).toEqual(["ADAssessmentRecommendation", "Syslog"]);
  });

  it("elides past twelve names but still states the true count", () => {
    // The truncation is where a count and a list can quietly disagree, and a
    // message that said "12 table(s) differ" when 15 did would send someone
    // regenerating and then declaring three tables fine that were not.
    const committed = {};
    const regenerated = {};
    for (let i = 0; i < 15; i += 1) {
      const table = `Table${String(i).padStart(2, "0")}`;
      committed[table] = [{ name: "A", type: "string" }];
      regenerated[table] = [{ name: "A", type: "int" }];
    }

    const result = compareAssets({
      committed: asAsset(committed),
      regenerated: asAsset(regenerated),
    });

    expect(result.changed).toHaveLength(15);
    expect(result.message).toContain("15 table(s) differ");
    expect(result.message).toContain("Table11");
    expect(result.message).not.toContain("Table12");
    expect(result.message).toContain(", ...");
  });
});

/** An in-memory stand-in for the asset on disk. */
function assetFile(initial) {
  let content = initial;
  return {
    readAsset: () => content,
    writeAsset: (text) => {
      content = text;
    },
    get content() {
      return content;
    },
  };
}

describe("checkSchemaAsset", () => {
  it("puts the committed bytes back even though the comparison FAILED", () => {
    // The failing path is the one that matters: a checker that leaves the
    // regenerated file sitting in the working tree when it fails is a checker
    // people delete instead of obeying.
    const committed = asCrlf(asAsset(TABLES));
    const file = assetFile(committed);

    const result = checkSchemaAsset({
      readAsset: file.readAsset,
      writeAsset: file.writeAsset,
      runGenerator: () => file.writeAsset(asAsset(GUID_CORRECTED)),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("drift");
    expect(result.changed).toEqual(["SecurityEvent"]);
    // Byte-for-byte, CR included. Restoring the NORMALISED text would rewrite
    // a CRLF checkout as LF and dirty the tree on every Windows run - DBT-70
    // wearing the other hat.
    expect(file.content).toBe(committed);
  });

  it("puts them back when the generator THROWS mid-write", () => {
    // The seven-week failure was a crash, not a mismatch, and a crash can land
    // after the generator has already truncated the file.
    const committed = asAsset(TABLES);
    const file = assetFile(committed);

    const result = checkSchemaAsset({
      readAsset: file.readAsset,
      writeAsset: file.writeAsset,
      runGenerator: () => {
        file.writeAsset("{}");
        throw new Error("ENOENT: no such file or directory, scandir 'DCR-Templates'");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("generator-failed");
    expect(result.message).toBe(GENERATOR_FAILED_MESSAGE);
    expect(result.detail).toContain("ENOENT");
    expect(file.content).toBe(committed);
  });

  it("does not confuse a crashed generator with drift", () => {
    // These print different instructions - one says fix the generator, the
    // other says regenerate and commit - so a caller that could not tell them
    // apart would send someone to commit whatever the crash left behind.
    const file = assetFile(asAsset(TABLES));
    const crashed = checkSchemaAsset({
      readAsset: file.readAsset,
      writeAsset: file.writeAsset,
      runGenerator: () => {
        throw new Error("boom");
      },
    });

    expect(crashed.changed).toEqual([]);
    expect(crashed.message).not.toContain("table(s) differ");
    expect(crashed.message).toContain("FAILED TO RUN");
  });

  it("passes a CRLF checkout against an LF generator, asset untouched", () => {
    const committed = asCrlf(asAsset(TABLES));
    const file = assetFile(committed);

    const result = checkSchemaAsset({
      readAsset: file.readAsset,
      writeAsset: file.writeAsset,
      runGenerator: () => file.writeAsset(asAsset(TABLES)),
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("matches");
    expect(file.content).toBe(committed);
  });
});
