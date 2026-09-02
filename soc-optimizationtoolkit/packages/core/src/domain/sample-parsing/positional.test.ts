/**
 * Pins for whitespace-positional parsing (DBT-77).
 *
 * The load-bearing ones are about NAMING, not splitting. Splitting is trivial;
 * the risk this module carries is naming somebody else's column `srcaddr` and
 * carrying that lie into a DCR, which fails silently rather than loudly. So the
 * pins are weighted toward the cases where it must DECLINE to name.
 */

import { describe, expect, it } from "vitest";
import {
  VPC_FLOW_V2_FIELDS,
  isVpcFlowV2,
  looksPositional,
  parsePositional,
  positionalNote,
  splitPositional,
} from "./positional";

/** A real v2 line, in AWS's default field order. */
const ACCEPT =
  "2 123456789012 eni-0abc123def4567890 10.0.1.25 10.0.2.18 49832 443 6 12 6840 1725265200 1725265260 ACCEPT OK";
const REJECT =
  "2 123456789012 eni-0abc123def4567890 10.0.1.25 203.0.113.77 49120 22 6 3 180 1725265380 1725265440 REJECT OK";
/** The row from the reported file that broke the first draft. */
const NODATA =
  "2 123456789012 eni-0ddd444eee555fff6 - - - - - - - 1725265200 1725265260 NODATA SKIPDATA";

describe("splitPositional", () => {
  it("splits on runs of whitespace, so tabs and double spaces do not shift columns", () => {
    // A hand-edited sample is the likely source of these, and an empty column
    // would push every field one place right - naming srcaddr as dstaddr.
    expect(splitPositional("a  b\tc   d")).toEqual(["a", "b", "c", "d"]);
  });
});

describe("isVpcFlowV2 - the naming decision", () => {
  it("recognises the canonical v2 shape", () => {
    expect(isVpcFlowV2([ACCEPT, REJECT])).toBe(true);
  });

  it("ACCEPTS AWS's `-` placeholder rows, which the first draft rejected", () => {
    // THE PIN THE REPORTED FILE EARNED. AWS writes a bare `-` for every field
    // unavailable on a record, so a NODATA row is mostly dashes. The first
    // draft required the numerics to be digits and `action` to be ACCEPT or
    // REJECT, and this single legitimate row made a whole 22-line file decline
    // to be named - it parsed, but as field1..field14.
    expect(isVpcFlowV2([NODATA])).toBe(true);
    expect(isVpcFlowV2([ACCEPT, REJECT, NODATA])).toBe(true);
  });

  it("DECLINES when the column count is not 14 - v3+ and custom formats", () => {
    // The count is the strongest guard against mis-naming: a v3 or reordered
    // custom format has a different width, so this rejects it rather than
    // confidently applying the v2 names to the wrong columns.
    expect(isVpcFlowV2([ACCEPT + " extra-column"])).toBe(false);
    expect(isVpcFlowV2([splitPositional(ACCEPT).slice(0, 13).join(" ")])).toBe(false);
  });

  it("DECLINES when the version field is not 2", () => {
    expect(isVpcFlowV2([ACCEPT.replace(/^2 /, "3 ")])).toBe(false);
  });

  it("DECLINES on an unknown log-status", () => {
    expect(isVpcFlowV2([ACCEPT.replace(/ OK$/, " MAYBE")])).toBe(false);
  });

  it("requires EVERY row to qualify, not a majority", () => {
    // A file where one row disagrees is not a v2 file with a typo - it is a
    // file we have not understood. Declining is recoverable; mis-naming is not.
    expect(isVpcFlowV2([ACCEPT, "1 2 3 4"])).toBe(false);
  });

  it("declines an empty input rather than vacuously accepting it", () => {
    // `Array.every` is true for an empty array, so without the guard this
    // would name the columns of a file with no rows.
    expect(isVpcFlowV2([])).toBe(false);
  });
});

describe("looksPositional - detection of last resort", () => {
  it("accepts a consistent column count of at least four", () => {
    expect(looksPositional([ACCEPT, REJECT])).toBe(true);
  });

  it("REJECTS varying column counts, which is what separates it from prose", () => {
    expect(looksPositional(["a b c d e", "a b c"])).toBe(false);
  });

  it("REJECTS fewer than four columns - too much ordinary text qualifies", () => {
    expect(looksPositional(["a b c", "d e f"])).toBe(false);
  });

  it("REJECTS a SINGLE line, because one row is consistent with itself", () => {
    // The greedy case two existing characterization pins caught: `{not json at
    // all` and `this is just some text` are four and five tokens, and a
    // one-row rule claimed both as positional logs when they had always been
    // `unknown`. Consistency is the only evidence here, and it does not exist
    // until there are two rows to compare.
    expect(looksPositional(["this is just some text"])).toBe(false);
    expect(looksPositional(["{not json at all"])).toBe(false);
    // Two rows of the same width is where the evidence begins.
    expect(looksPositional(["a b c d", "e f g h"])).toBe(true);
  });

  it("ignores blank lines rather than counting them as a width mismatch", () => {
    expect(looksPositional([ACCEPT, "", REJECT])).toBe(true);
  });
});

describe("parsePositional", () => {
  it("NAMES the columns for a recognised v2 file", () => {
    const [first] = parsePositional([ACCEPT, REJECT].join("\n"));
    expect(Object.keys(first ?? {})).toEqual([...VPC_FLOW_V2_FIELDS]);
    expect(first?.srcaddr).toBe("10.0.1.25");
    expect(first?.dstport).toBe("443");
    expect(first?.action).toBe("ACCEPT");
  });

  it("NUMBERS the columns when the shape is not recognised", () => {
    // Not a failure mode. A positional format keeps its schema outside the
    // file, so field1..fieldN is the honest answer: the events are read, and
    // the names genuinely are not available to read.
    const [first] = parsePositional("alpha beta gamma delta epsilon");
    expect(Object.keys(first ?? {})).toEqual([
      "field1",
      "field2",
      "field3",
      "field4",
      "field5",
    ]);
  });

  it("parses every row, including the dash-filled NODATA one", () => {
    expect(parsePositional([ACCEPT, REJECT, NODATA].join("\n"))).toHaveLength(3);
  });
});

describe("positionalNote", () => {
  it("says NOTHING when the columns were named - a note on a working parse is noise", () => {
    expect(positionalNote([ACCEPT, REJECT].join("\n"))).toBeNull();
  });

  it("explains the unnamed case without blaming the file", () => {
    // The message this replaces was "Could not parse any events from the
    // provided content", which read like a corrupt upload. All three of these
    // assertions are about not repeating that.
    const note = positionalNote("alpha beta gamma delta") ?? "";
    expect(note).toContain("Read as a positional log");
    expect(note).toContain("4");
    expect(note).not.toMatch(/could not|error|invalid|fail/i);
  });
});
