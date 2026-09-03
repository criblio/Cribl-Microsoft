/**
 * DBT-78 - a field name Cribl cannot address must be SAID, not smoothed over.
 *
 * The dangerous half is the dotted one and the pins reflect that: a hyphenated
 * name fails loudly in Cribl at runtime, while a flat field literally named
 * `a.b` is a VALID accessor for a nested field that does not exist - so the
 * rename addresses nothing, renames nothing, and the build reports success.
 * Every assertion about the dot is therefore about the dot specifically, not
 * about "an invalid name" in general.
 *
 * The predicate is also what pipeline-generation's checkCriblYaml now enforces,
 * so a pin here that lets a dot through would take the validator with it.
 */

import { describe, expect, it } from "vitest";
import { isCriblAccessorSafe, unaddressableFieldNote } from "./accessor-names";
import { parseSampleContent } from "./parse-sample";
import { checkCriblYaml } from "../pipeline-generation/cribl-yaml-validator";
import { matchSampleToSchema } from "../field-matcher/match-fields";
import { buildPipelinePlan } from "../pipeline-generation/plan";
import { generatePipelineConfForPlan } from "../pipeline-generation/pipeline-conf";

describe("isCriblAccessorSafe (DBT-78)", () => {
  it("accepts bare identifiers, including the underscore names we mint", () => {
    // `_time`, `_0` and `_extra_12` are this app's own field names (see
    // models.ts); if the predicate rejected them the validator would refuse
    // every headerless-CSV pack we build.
    for (const name of ["src_ip", "SourceIp", "a", "_time", "_0", "_extra_12", "f1"]) {
      expect(isCriblAccessorSafe(name), name).toBe(true);
    }
  });

  it("rejects the dot, which is the one that fails silently", () => {
    expect(isCriblAccessorSafe("a.b")).toBe(false);
    expect(isCriblAccessorSafe("aws.account")).toBe(false);
  });

  it("rejects hyphens, spaces, subscripts, sigils and a leading digit", () => {
    for (const name of [
      "src-ip",
      "Source IP",
      "a[0]",
      "@timestamp",
      "$id",
      "a:b",
      "a/b",
      "1field",
      "",
    ]) {
      expect(isCriblAccessorSafe(name), name).toBe(false);
    }
  });
});

describe("unaddressableFieldNote (DBT-78)", () => {
  it("is null when every name is addressable", () => {
    // The vacuity guard. Without this, a note builder that returned a string
    // unconditionally would still satisfy every other pin in this file.
    expect(unaddressableFieldNote(["src_ip", "action", "_time"])).toBeNull();
    expect(unaddressableFieldNote([])).toBeNull();
  });

  it("counts the offenders and names them", () => {
    const note = unaddressableFieldNote(["ok", "src-ip", "a.b"]);
    expect(note).not.toBeNull();
    expect(note).toContain("2 field names");
    expect(note).toContain("src-ip");
    expect(note).toContain("a.b");
    // The addressable field is not accused.
    expect(note).not.toContain("ok,");
    // The dot's failure mode is spelled out, because it is the one an operator
    // will not otherwise observe.
    expect(note).toContain("nested field that does not exist");
  });

  it("uses singular wording for one offender", () => {
    expect(unaddressableFieldNote(["a-b"])).toContain("1 field name is");
  });

  it("promises no build-time refusal, because the build does not deliver one", () => {
    // THE NOTE SAID "Pack generation refuses these names rather than emitting
    // them" UNTIL 2026-09-03, and that was measurably false for any name
    // containing WHITESPACE - one of the note's most common triggers, since a
    // space-headed CSV produces exactly that. The two halves are pinned
    // together, because the wording is only wrong RELATIVE to what the
    // validator does:
    const note = unaddressableFieldNote(["Source IP"]) ?? "";
    expect(note).toContain("Source IP");
    // (a) the note claims no safety net...
    expect(note).not.toMatch(/refus|reject|block/i);
    // ...and does say the thing that is true of every case.
    expect(note).toContain("upstream");

    // (b) ...because there is not one. `checkCriblYaml` reads a field name with
    // `([^'"\s][^\s]*)\s*$`, which cannot match a value containing a space, so
    // the rule never sees a spaced name. Asserted as an ASYMMETRY with real
    // counts, so it cannot pass by the validator refusing everything or
    // nothing.
    const renameYaml = (name: string): string =>
      [
        "  - id: rename",
        "    conf:",
        "      rename:",
        `        - currentName: ${name}`,
        "          newName: AccountId",
      ].join("\n");
    expect(checkCriblYaml(renameYaml("Source IP"), "conf.yml")).toEqual([]);
    expect(checkCriblYaml(renameYaml("src-ip"), "conf.yml")).toHaveLength(1);
    expect(checkCriblYaml(renameYaml("a.b"), "conf.yml")).toHaveLength(1);

    // WHEN THIS PIN FAILS ON THE FIRST LINE OF (b), that is the good outcome:
    // someone taught the validator whitespace names. Re-read the note's last
    // sentence at the same time - it was narrowed only because of this gap, and
    // it can widen again once the gap closes. Read the group-header trap in
    // cribl-yaml-validator.ts first: a widened class also matches `name: Field
    // Extraction` and its siblings. There is NO CARD for that trap (board.json,
    // checked 2026-09-03), so that comment is the only record of it.
  });

  it("is not early-because-clearer: the build message already names the field", () => {
    // THE NOTE'S DOC COMMENT ARGUED UNTIL 2026-09-03 that checkCriblYaml reports
    // "a YAML line number rather than the source field at fault". Measured, that
    // is false in both halves: the message quotes the offending NAME within the
    // first line-prefix-plus-a-dozen characters AND echoes the source line back.
    // Pinned because a comment reasoning from a false premise is the defect, not
    // the wording - the note's real justification is WHEN it fires and WHETHER
    // any build message exists at all (see the describe below).
    const renameYaml = (name: string): string =>
      [
        "  - id: rename",
        "    conf:",
        "      rename:",
        `        - currentName: ${name}`,
        "          newName: AccountId",
      ].join("\n");
    for (const name of ["account-id", "a.b", "@ts", "$id", "1field", "a[0]"]) {
      const issues = checkCriblYaml(renameYaml(name), "conf.yml");
      expect(issues, name).toHaveLength(1);
      const message = issues[0] ?? "";
      // Named, not merely located...
      expect(message, name).toContain(`field name "${name}"`);
      // ...named UP FRONT, right after the `Line N: ` prefix rather than buried
      // at the end (a message that only echoed the line would still contain the
      // name, so position is what separates the two readings)...
      expect(message.indexOf(`"${name}"`), name).toBeLessThan(40);
      // ...and the offending source line is quoted back.
      expect(message, name).toContain(`- currentName: ${name}`);
    }
  });

  it("lists five and summarises the rest", () => {
    const names = ["a-1", "a-2", "a-3", "a-4", "a-5", "a-6", "a-7"];
    const note = unaddressableFieldNote(names) ?? "";
    expect(note).toContain("7 field names");
    expect(note).toContain("a-5");
    expect(note).toContain("and 2 more");
    // The sixth and seventh are counted, not listed.
    expect(note).not.toContain("a-6");
  });
});

describe("what a whole generated pack actually refuses (DBT-78)", () => {
  /**
   * THE REAL CHAIN, not a hand-written rename snippet: parseSampleContent ->
   * matchSampleToSchema -> buildPipelinePlan -> generatePipelineConfForPlan ->
   * checkCriblYaml. The snippet pins above prove what the RULE does when a name
   * reaches it; this proves WHICH names reach it, and the answer is much
   * narrower than the rule's own message implies.
   */
  function issuesForSample(
    content: string,
    schemaColumns: Array<{ name: string; type: string }>,
  ): { actions: string[]; issues: string[]; conf: string } {
    const parsed = parseSampleContent(content, { sourceName: "s" });
    const match = matchSampleToSchema(
      parsed.fields.map((f) => ({
        name: f.name,
        type: f.type,
        // THE TWO TYPES SPELL THE SAME THING DIFFERENTLY: a parsed field
        // carries `DiscoveredField.examples` (models.ts, "legacy:
        // sampleValues"), and the matcher's input carries
        // `SampleFieldInput.sampleValues`, of which it reads only [0] as a
        // tie-break (match-fields.ts). Forwarded rather than dropped so this
        // helper hands the matcher what the product hands it -
        // parsedSampleToSourceFields makes the identical hop via examples[0].
        //
        // It changes nothing HERE, and saying so is the point: measured both
        // ways on all three cases below, the actions and issue counts are
        // identical, so no pin in this file rests on the tie-break. Forwarding
        // is for fidelity to the real path, not for the result.
        sampleValues: f.examples,
      })),
      schemaColumns,
    );
    const plan = buildPipelinePlan({
      solutionName: "Test Solution",
      packName: "cribl-test",
      tables: [
        {
          sentinelTable: "TestTable_CL",
          matchResult: match,
          sourceFormat: parsed.format,
        },
      ],
    });
    const table = plan.tables[0];
    if (table === undefined) throw new Error("planner produced no table");
    const conf = generatePipelineConfForPlan(table, "Test Solution");
    return {
      actions: table.fields.map((f) => `${f.source}:${f.action}`),
      issues: checkCriblYaml(conf, "conf.yml"),
      conf,
    };
  }

  /**
   * The conf lines that present `name` to the DBT-78 rule as a field name -
   * matched WHOLE, so `Type` cannot be satisfied by a line reading `TypeX`.
   *
   * Deliberately not a copy of the validator's own line matcher: re-spelling
   * that regex here would be the second copy of a rule this codebase already
   * pays for (see the header of accessor-names.ts). This only asks whether a
   * given name occupies such a line; whether the rule then accepts it is
   * checkCriblYaml's answer, asserted separately as `issues`.
   */
  function nameLinesFor(conf: string, name: string): string[] {
    return conf
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l === `name: ${name}` || l === `- name: ${name}`);
  }

  const TIME = { name: "TimeGenerated", type: "datetime" };

  it("REFUSES an unaddressable name that the schema has a home for", () => {
    // The case the rule was written for, driven all the way from bytes.
    const { actions, issues } = issuesForSample(
      "src-ip=1.1.1.1 dst-ip=2.2.2.2 account-id=999",
      [
        { name: "SrcIpAddr", type: "string" },
        { name: "DstIpAddr", type: "string" },
        { name: "AccountId", type: "string" },
        TIME,
      ],
    );
    // The actions are asserted so a matcher change cannot move this case off
    // the rename branch and leave the count passing for the wrong reason.
    expect(actions.sort()).toEqual([
      "account-id:rename",
      "dst-ip:rename",
      "src-ip:rename",
    ]);
    expect(issues).toHaveLength(3);
    expect(issues.join("\n")).toContain('field name "account-id"');
  });

  it("SHIPS the same names when no destination column claims them", () => {
    // The ordinary fate of an awkward vendor name, and the reason the parse
    // note may not promise a safety net: the only trace of a dropped field in
    // the conf is a bullet under the cleanup eval's `remove:`, which is not a
    // name:/currentName:/newName: line, so the rule never runs on it.
    const { actions, issues, conf } = issuesForSample(
      '[{"src-ip":"1.1.1.1","vendor-thing":"x"}]',
      [{ name: "SomethingElse", type: "string" }, TIME],
    );
    expect(actions.sort()).toEqual(["src-ip:drop", "vendor-thing:drop"]);
    // EVERY line of the conf that mentions the name, not just "it appears
    // somewhere": there is exactly one, it is a `remove:` bullet, and it is
    // not a name:/currentName:/newName: line. That is the whole reason the
    // rule never runs on it, and asserting the full set is what stops this
    // passing because the name vanished from the file altogether.
    expect(
      conf.split("\n").filter((l) => l.includes("src-ip")).map((l) => l.trim()),
    ).toEqual(["- src-ip"]);
    expect(
      conf
        .split("\n")
        .filter((l) => l.includes("vendor-thing"))
        .map((l) => l.trim()),
    ).toEqual(["- vendor-thing"]);
    // AND THE RULE IS NOT IDLE ON THIS CONF. A `name:` line is present and is
    // read - the enrich eval that sets `Type` - so 0 issues means "nothing
    // unaddressable reached the rule", not "nothing reached it". Names this
    // app mints are identifiers by construction, which is why reading them
    // costs nothing. Measured, not assumed: with isCriblAccessorSafe mutated
    // to reject every name, this conf and the kept one below each yield
    // exactly 1 issue and the REFUSES case above goes 3 -> 7.
    //
    // WHOLE-LINE, not `toContain`: `toContain("name: Type")` is satisfied by
    // `name: TypeX`, so it survived the mutation that renames the added field
    // and pinned nothing. Matching the trimmed line exactly is what makes it
    // fail.
    expect(nameLinesFor(conf, "Type")).toHaveLength(1);
    expect(issues).toEqual([]);
  });

  it("SHIPS a dotted name kept under its own spelling", () => {
    // The silent half of DBT-78 at its worst: `a.b` matched to a column also
    // called `a.b` needs no rename, so the conf carries no line bearing the
    // name at all and there is nothing for the rule to read.
    const { actions, issues, conf } = issuesForSample('[{"a.b":"x"}]', [
      { name: "a.b", type: "string" },
      TIME,
    ]);
    expect(actions).toEqual(["a.b:keep"]);
    expect(conf).not.toContain("a.b");
    // Same asymmetry as above: the rule DID read a name here (`Type`), it was
    // addressable, and the dotted one was never presented to it.
    expect(nameLinesFor(conf, "Type")).toHaveLength(1);
    expect(issues).toEqual([]);
  });

  it("still says it at parse time in every one of those cases", () => {
    // The asymmetry above is only tolerable because the note is unconditional.
    // If this ever drops to fewer than three, the two shipping cases lose their
    // only warning.
    for (const content of [
      "src-ip=1.1.1.1 dst-ip=2.2.2.2 account-id=999",
      '[{"src-ip":"1.1.1.1","vendor-thing":"x"}]',
      '[{"a.b":"x"}]',
    ]) {
      const parsed = parseSampleContent(content, { sourceName: "s" });
      expect(parsed.errors, content).toHaveLength(1);
      expect(parsed.errors[0], content).toContain("not a Cribl property accessor");
    }
  });
});

describe("parseSampleContent surfaces unaddressable names (DBT-78)", () => {
  // BOTH JSON PARSERS, and the pair is not padding. The first draft of this pin
  // used a single `{...}` object, which `detectSampleFormat` classifies as
  // NDJSON - so the mutation that proves the pin (sanitising keys in parseJson)
  // never reached the code under test and the pin passed with the defect in
  // place. A JSON ARRAY is what routes through parseJson. The two parsers are
  // separate functions and each needs its own reachable case.
  const jsonSources: ReadonlyArray<readonly [string, string]> = [
    ["ndjson", '{"src-ip":"1.1.1.1","a.b":"x","ok":1}'],
    ["json", '[{"src-ip":"1.1.1.1","a.b":"x","ok":1}]'],
  ];

  for (const [expectedFormat, content] of jsonSources) {
    it(`keeps a ${expectedFormat} source's own spelling and reports it`, () => {
      // NOT SANITISED, and that is the decision under test. The generated
      // pipeline extracts JSON with Cribl's own serde over `_raw`, so the
      // runtime field name comes from the vendor's bytes - rewriting `src-ip`
      // to `src_ip` here would make the build pass and then emit a rename
      // addressing a field no event carries. See accessor-names.ts.
      const parsed = parseSampleContent(content, { sourceName: "flow" });

      // Asserted so a future detection change cannot quietly move this case
      // onto the other parser and leave the mutation unreachable again.
      expect(parsed.format).toBe(expectedFormat);
      expect(parsed.fields.map((f) => f.name)).toEqual(["src-ip", "a.b", "ok"]);
      expect(parsed.errors).toHaveLength(1);
      expect(parsed.errors[0]).toContain("src-ip");
      expect(parsed.errors[0]).toContain("a.b");
    });
  }

  it("says nothing about a sample whose names are all addressable", () => {
    // Noise guard: the note must not appear on ordinary input, or operators will
    // learn to ignore the "Parse notes" line that carries it.
    const parsed = parseSampleContent(
      '{"src_ip":"1.1.1.1","ok":1}\n{"src_ip":"2.2.2.2","ok":2}',
      { sourceName: "clean.ndjson" },
    );
    expect(parsed.fields.map((f) => f.name)).toEqual(["src_ip", "ok"]);
    expect(parsed.errors).toEqual([]);
  });

  it("reports a dotted key on its own, where nothing else would", () => {
    // The isolated silent case. A hyphen would eventually announce itself in
    // Cribl's log; a dot never does, so this parse note is the only place an
    // operator can find out before the data is wrong in Sentinel.
    const parsed = parseSampleContent('{"a.b":"x","ok":1}', {
      sourceName: "dotted.json",
    });
    expect(parsed.fields.map((f) => f.name)).toEqual(["a.b", "ok"]);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toContain("1 field name is");
    expect(parsed.errors[0]).toContain("a.b");
  });
});
