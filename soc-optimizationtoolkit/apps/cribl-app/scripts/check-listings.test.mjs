/**
 * Pins for the listing escape-hatch checker (DBT-61).
 *
 * The load-bearing ones are the MUTATION pins: a checker that reports zero
 * findings is indistinguishable from a checker that cannot find anything, and
 * the previous attempt at this failed in exactly that way - calibrated green,
 * then missed all three real defects. So every "clean" pin here is paired with
 * a dirty one built by reintroducing the bug.
 */

import { describe, expect, it } from "vitest";
import { findViolations, scanRepo, stripCommentsAndStrings } from "./check-listings.mjs";

describe("findViolations", () => {
  it("CATCHES a counted unwrap - the bug this exists for", () => {
    const src = `const rows = listingRows(listed);\npush(\`Read \${listingRows(listed).length} DCR(s)\`);`;
    const found = findViolations(src, "f.ts");
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(2);
  });

  it("catches it when the count is not in a template either", () => {
    // The number does not have to reach a sentence to be wrong; a comparison
    // that MEANS "none installed" is how DBT-44 shipped with no string at all.
    expect(findViolations(`if (listingRows(x).length === 0) notInstalled = true;`, "f.ts")).toHaveLength(1);
  });

  it("allows the sanctioned unwrap - rendering rows, claiming nothing", () => {
    const src = `setTables([...listingRows(listed)]);\nconst names = listingRows(groups).map((g) => g.name);`;
    expect(findViolations(src, "f.ts")).toEqual([]);
  });

  it("allows listingCount, which makes the caller state what empty means", () => {
    expect(findViolations(`count: listingCount(listed, 0),`, "f.ts")).toEqual([]);
  });

  it("allows a count taken after NARROWING, which is the whole point", () => {
    // `listed.rows` only exists once `kind === "rows"` has been checked, so
    // this count provably came from at least one measured row.
    const src = `if (listed.kind === "rows") log(\`\${listed.rows.length} found\`);`;
    expect(findViolations(src, "f.ts")).toEqual([]);
  });

  it("does not fire on prose - this repo documents the pattern it forbids", () => {
    // Not cosmetic: the module header of inventory-listing.ts spells the bad
    // pattern out on purpose, and a checker that flagged its own explanation
    // would be turned off within a day.
    const src = `// NEVER write listingRows(x).length in a message.\n/* listingRows(x).length is the defect. */\nsetRows([...listingRows(x)]);`;
    expect(findViolations(src, "f.ts")).toEqual([]);
  });

  it("reports file and line so the message is actionable", () => {
    const found = findViolations(`a();\nb();\nconst n = listingRows(z).length;`, "src/x.ts");
    expect(found).toEqual([{ file: "src/x.ts", line: 3, text: "const n = listingRows(z).length;" }]);
  });
});

describe("stripCommentsAndStrings", () => {
  it("removes block and line comments, keeps code", () => {
    expect(stripCommentsAndStrings("/* x */\n// y\nconst a = 1;")).toContain("const a = 1;");
    expect(stripCommentsAndStrings("/* x */\n// y\nconst a = 1;")).not.toContain("// y");
  });
});

describe("the repository itself", () => {
  it("is clean, and this pin is only meaningful next to the ones above", () => {
    // On its own this asserts nothing - a broken checker passes it too. It is
    // the mutation pins that establish the checker can fail, which is what
    // makes this green worth reading.
    expect(scanRepo()).toEqual([]);
  });
});
