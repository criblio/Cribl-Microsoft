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
import { checkPlanFieldAccessors } from "../pipeline-generation/plan-accessor-check";
import type { TablePlan } from "../pipeline-generation/models";
import {
  generatePipelineConfForPlan,
  generateReductionConfForPlan,
} from "../pipeline-generation/pipeline-conf";

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

  it("promises no build-time refusal, because two of the three fates ship", () => {
    // THIS PIN HAS BEEN NARROWED TWICE AND IS NOW POINTED THE OTHER WAY, so
    // read the history before touching it. The note said "Pack generation
    // refuses these names rather than emitting them" until 2026-09-03; that was
    // measurably false for a name containing WHITESPACE, so the claim came out
    // and this pin held the wording to it. GEN-4 then taught checkCriblYaml
    // whitespace names, this pin's `toEqual([])` FIRED AS DESIGNED, and the
    // line below is what replaced it.
    //
    // What did NOT change is why the note still promises nothing. The reason
    // was never "the line matcher cannot see a space" - that was only the
    // mechanism of the day. It is that a refusal depends on the field's FATE:
    // the rule only ever reads a name a RENAME put on a `currentName:` line,
    // and an unmatched or kept name never reaches one, whatever it is spelled
    // with. That is measured end-to-end in "what a whole generated pack
    // actually refuses" below; this pin covers the line-level rule only.
    const note = unaddressableFieldNote(["Source IP"]) ?? "";
    expect(note).toContain("Source IP");
    // (a) the note claims no safety net...
    expect(note).not.toMatch(/refus|reject|block/i);
    // ...and does say the thing that is true of every case.
    expect(note).toContain("upstream");

    // (b) ...and on a rename line the rule now refuses all three unaddressable
    // shapes alike - the space no longer excepted. Asserted as an ASYMMETRY
    // with real counts, because "refuses a spaced name" is also satisfied by a
    // validator that refuses EVERYTHING: the two zero rows are what make the
    // three ones mean something.
    const renameYaml = (name: string): string =>
      [
        "  - id: rename",
        "    conf:",
        "      rename:",
        `        - currentName: ${name}`,
        "          newName: AccountId",
      ].join("\n");
    expect(checkCriblYaml(renameYaml("Source IP"), "conf.yml")).toHaveLength(1);
    expect(checkCriblYaml(renameYaml("src-ip"), "conf.yml")).toHaveLength(1);
    expect(checkCriblYaml(renameYaml("a.b"), "conf.yml")).toHaveLength(1);
    // An addressable name on the same line is untouched...
    expect(checkCriblYaml(renameYaml("SourceIP"), "conf.yml")).toEqual([]);
    // ...and so is a PROSE `name:` that is not a field name at all. This is the
    // group-header trap: "Field Extraction" is not an identifier either, every
    // generated conf carries three of them, and a rule that told them apart by
    // the SHAPE of the value rather than by the enclosing block would fail
    // every pack we build three times over.
    expect(
      checkCriblYaml(
        ["groups:", "  fx:", "    name: Field Extraction"].join("\n"),
        "conf.yml",
      ),
    ).toEqual([]);

    // TRIPWIRE FOR THE NEXT CHANGE, in the same style as the one that brought
    // you here. GEN-5 closed its KEPT leg on 2026-10-02 - a kept name reaches
    // no `name:` line, so checkPlanFieldAccessors refuses it from the plan
    // instead (the two "REFUSES ... kept" pins below were "SHIPS" pins until
    // then). The remaining hole is GEN-5's DROP leg: an unmatched name reaches
    // only a `remove:` bullet, and closing it waits on a live Cribl measurement
    // of what a glob list does with an unaddressable name. WHEN THE TWO
    // REMAINING "SHIPS" PINS BELOW FAIL, that is the good outcome: someone
    // closed the drop leg. Re-read the note's WHETHER paragraph in
    // accessor-names.ts at the same time, because at that point the note stops
    // being the only warning those fates ever get, and (a) above becomes the
    // claim to re-argue rather than to preserve.
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
    // WHICH DESTINATION TABLE, and it is not cosmetic: it decides whether the
    // plan has REDUCTION RULES, and therefore which of two very different confs
    // generateReductionConfForPlan emits. Defaulted so the cases that do not
    // care read as before.
    sentinelTable = "TestTable_CL",
  ): {
    actions: string[];
    issues: string[];
    reductionIssues: string[];
    planIssues: string[];
    conf: string;
    reductionConf: string;
    table: TablePlan;
  } {
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
          sentinelTable,
          matchResult: match,
          sourceFormat: parsed.format,
        },
      ],
    });
    const table = plan.tables[0];
    if (table === undefined) throw new Error("planner produced no table");
    const conf = generatePipelineConfForPlan(table, "Test Solution");
    // THE OTHER CONF THE SAME PLAN EMITS. A pack ships both, so a refusal that
    // held only on the transform path would be one a pack could walk around.
    const reductionConf = generateReductionConfForPlan(table, "Test Solution");
    return {
      actions: table.fields.map((f) => `${f.source}:${f.action}`),
      issues: checkCriblYaml(conf, "conf.yml"),
      reductionIssues: checkCriblYaml(reductionConf, "conf.yml"),
      // GEN-5: the plan-level half of the refusal - the names no conf line
      // presents. The preview adds these to the YAML issues, so a pin on
      // `issues` alone would read a refused build as a shipping one.
      planIssues: checkPlanFieldAccessors(table),
      conf,
      reductionConf,
      table,
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
    const { actions, issues, planIssues } = issuesForSample(
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
    // GEN-5: a renamed name is the YAML rule's to refuse; the plan check must
    // not report it a second time.
    expect(planIssues).toEqual([]);
    expect(issues.join("\n")).toContain('field name "account-id"');
  });

  it("SHIPS the same names when no destination column claims them", () => {
    // The ordinary fate of an awkward vendor name, and the reason the parse
    // note may not promise a safety net: the only trace of a dropped field in
    // the conf is a bullet under the cleanup eval's `remove:`, which is not a
    // name:/currentName:/newName: line, so the rule never runs on it.
    const { actions, issues, planIssues, conf } = issuesForSample(
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
    // GEN-5's DROP leg is deliberately still open (it waits on a live Cribl
    // measurement), so the kept-leg plan check must not reach a drop either.
    expect(planIssues).toEqual([]);
  });

  it("REFUSES a dotted name kept under its own spelling (GEN-5)", () => {
    // The silent half of DBT-78 at its worst: `a.b` matched to a column also
    // called `a.b` needs no rename, so the conf carries no line bearing the
    // name at all and there is nothing for the YAML rule to read. Until GEN-5
    // this pin was "SHIPS": the build was green and the accessor unbuildable.
    const { actions, issues, planIssues, conf } = issuesForSample(
      '[{"a.b":"x"}]',
      [{ name: "a.b", type: "string" }, TIME],
    );
    expect(actions).toEqual(["a.b:keep"]);
    expect(conf).not.toContain("a.b");
    // Same asymmetry as above: the YAML rule DID read a name here (`Type`), it
    // was addressable, and the dotted one was never presented to it - which is
    // still true, and is WHY the refusal has to come from the plan.
    expect(nameLinesFor(conf, "Type")).toHaveLength(1);
    expect(issues).toEqual([]);
    expect(planIssues).toHaveLength(1);
    expect(planIssues[0]).toContain('field name "a.b"');
    expect(planIssues[0]).toContain("(keep)");
    expect(planIssues[0]).toContain("TestTable_CL");
  });

  it("REFUSES a dotted name renamed to its own spelling (GEN-5)", () => {
    // NOT IN THE CARD, FOUND MEASURING IT: a type mismatch between the sample
    // and a column of the SAME name comes out of the matcher as `rename`, not
    // `keep` or `coerce` - and the emitter skips a rename whose source equals
    // its target (presetRenames in pipeline-conf.ts), so no conf line names
    // the field either. It is a kept field in every way the conf can see.
    const { actions, issues, planIssues, conf } = issuesForSample(
      '[{"a.b":5}]',
      [{ name: "a.b", type: "string" }, TIME],
    );
    expect(actions).toEqual(["a.b:rename"]);
    expect(conf).not.toContain("a.b");
    expect(issues).toEqual([]);
    expect(planIssues).toHaveLength(1);
    expect(planIssues[0]).toContain('field name "a.b"');
    expect(planIssues[0]).toContain("(rename)");
  });

  it("REFUSES a COERCED unaddressable name exactly once (GEN-5)", () => {
    // plan.ts maps keep+needsCoercion to `coerce`, and the field is still read
    // by its own spelling. The plan carries the action directly here rather
    // than through the matcher, which (measured) did not emit `coerce` for any
    // of int/string/guid/dynamic/datetime against a same-named column.
    const { table } = issuesForSample('[{"a.b":"x"}]', [
      { name: "a.b", type: "string" },
      TIME,
    ]);
    const coerced = (type: string): TablePlan => ({
      ...table,
      fields: [{ source: "a.b", target: "a.b", type, action: "coerce" }],
    });

    // A coercion the emitter CAN express writes `- name: a.b` under the enrich
    // eval's `add:`, so the YAML rule already refuses it - and the plan check
    // must NOT report it a second time.
    const int = coerced("int");
    expect(
      checkCriblYaml(generatePipelineConfForPlan(int, "Test Solution"), "conf.yml"),
    ).toHaveLength(1);
    expect(checkPlanFieldAccessors(int)).toEqual([]);

    // A coercion it CANNOT express (buildCoercionExpr returns null for guid)
    // writes no line at all, and that one is the plan check's to refuse.
    const guid = coerced("guid");
    const guidConf = generatePipelineConfForPlan(guid, "Test Solution");
    expect(guidConf).not.toContain("a.b");
    expect(checkCriblYaml(guidConf, "conf.yml")).toEqual([]);
    const guidIssues = checkPlanFieldAccessors(guid);
    expect(guidIssues).toHaveLength(1);
    expect(guidIssues[0]).toContain('field name "a.b"');
    expect(guidIssues[0]).toContain("(coerce)");
  });

  it("does not refuse an addressable name kept under its own spelling", () => {
    // The control: the plan check reads every kept field, and a bare
    // identifier must cost nothing.
    const { actions, issues, planIssues } = issuesForSample(
      '[{"SrcIpAddr":"1.1.1.1"}]',
      [{ name: "SrcIpAddr", type: "string" }, TIME],
    );
    expect(actions).toEqual(["SrcIpAddr:keep"]);
    expect(issues).toEqual([]);
    expect(planIssues).toEqual([]);
  });

  /**
   * THE SAME THREE FATES, SPELLED WITH SPACES (GEN-4). Until 2026-09-03 all
   * three of these shipped, because the validator's line matcher could not see
   * a value containing a space. GEN-4 closed the RENAMED one and could not
   * close the other two, and pinning all three together is what keeps that
   * distinction from being read as "whitespace is handled now".
   */
  it("REFUSES a whitespace name the schema has a home for", () => {
    // The ordinary shape of a space-headed export read against a Sentinel
    // schema: prose headers, and CamelCase columns that are those headers with
    // the spaces taken out, so the matcher pairs every one of them.
    //
    // NOTE THE FORMAT. detectSampleFormat does NOT call this csv - its CSV rule
    // requires every header to be a bare identifier (format-detection.ts), and
    // prose headers are not - so it falls to `unknown` and parseByFormat's
    // fallback list reaches parseCsv anyway. Asserted because "space-headed
    // CSV" is the obvious way to describe this case and is wrong about the
    // format value; the five field names arrive regardless, which is all this
    // pin needs.
    const parsed = parseSampleContent(
      "Device Action,Source IP,Destination IP,Source Port,Destination Port\nblock,1.1.1.1,2.2.2.2,443,80",
      { sourceName: "s" },
    );
    expect(parsed.format).toBe("unknown");

    const CSV =
      "Device Action,Source IP,Destination IP,Source Port,Destination Port\nblock,1.1.1.1,2.2.2.2,443,80";
    const COLUMNS = [
      { name: "DeviceAction", type: "string" },
      { name: "SourceIP", type: "string" },
      { name: "DestinationIP", type: "string" },
      { name: "SourcePort", type: "int" },
      { name: "DestinationPort", type: "int" },
      TIME,
    ];

    const { actions, issues, reductionIssues, planIssues, reductionConf } = issuesForSample(
      CSV,
      COLUMNS,
    );
    // Asserted so a matcher change cannot move these off the rename branch and
    // leave the counts passing for the wrong reason.
    expect(actions.sort()).toEqual([
      "Destination IP:rename",
      "Destination Port:rename",
      "Device Action:rename",
      "Source IP:rename",
      "Source Port:rename",
    ]);
    expect(issues).toHaveLength(5);
    expect(planIssues).toEqual([]);
    expect(issues.join("\n")).toContain('field name "Source IP"');

    // THE REDUCTION CONF READS 0 HERE, AND THAT IS NOT A HOLE - it is the
    // FALLBACK pipeline. TestTable_CL has no reduction rules, so
    // generateReductionConfForPlan emits the no-op conf, which renames nothing
    // at all; 0 issues is the honest count for a file with no rename in it.
    // Pinned on the MECHANISM rather than the number, because "0" alone would
    // read as the refusal being escapable.
    expect(reductionConf).not.toContain("currentName");
    expect(reductionIssues).toEqual([]);

    // WHERE THE REDUCTION CONF DOES CARRY THE RENAMES, it refuses them too. A
    // table with reduction rules gets the full transformation pipeline WITH the
    // reduce group inserted, so the same five `- currentName:` lines are in it
    // and the same five issues come back. This is the pairing that shows the
    // refusal is not a property of one emitter.
    const withRules = issuesForSample(CSV, COLUMNS, "CommonSecurityLog");
    expect(withRules.reductionConf).toContain("- currentName: Source IP");
    expect(withRules.issues).toHaveLength(5);
    expect(withRules.reductionIssues).toHaveLength(5);
  });

  it("SHIPS a whitespace name when no destination column claims it", () => {
    // GEN-5's hole, in the shape GEN-4 could not reach: same name, no column,
    // so the matcher drops it and no rename line is ever emitted. No character
    // class can close this one - there is nothing to read.
    const { actions, issues, reductionIssues, planIssues, conf } = issuesForSample(
      '[{"Source IP":"1.1.1.1","Bad Thing":"x"}]',
      [{ name: "SomethingElse", type: "string" }, TIME],
    );
    expect(actions.sort()).toEqual(["Bad Thing:drop", "Source IP:drop"]);
    // EVERY line mentioning the name: exactly one, a `remove:` bullet, which is
    // not a name:/currentName:/newName: line under a `conf:`. Asserting the
    // whole set is what stops this passing because the name vanished entirely.
    expect(
      conf
        .split("\n")
        .filter((l) => l.includes("Source IP"))
        .map((l) => l.trim()),
    ).toEqual(["- Source IP"]);
    // The rule is not idle here - it reads the enrich eval's `Type` - so 0
    // means "nothing unaddressable reached it", not "nothing reached it".
    expect(nameLinesFor(conf, "Type")).toHaveLength(1);
    expect(issues).toEqual([]);
    expect(planIssues).toEqual([]);
    expect(reductionIssues).toEqual([]);
    // ...on BOTH reduction paths. The line above is the no-op fallback, where 0
    // is cheap; this is the full pipeline a table WITH reduction rules gets,
    // where 0 costs something.
    expect(
      issuesForSample(
        '[{"Source IP":"1.1.1.1","Bad Thing":"x"}]',
        [{ name: "SomethingElse", type: "string" }, TIME],
        "CommonSecurityLog",
      ).reductionIssues,
    ).toEqual([]);
  });

  it("REFUSES a whitespace name kept under its own spelling (GEN-5)", () => {
    // The worst of the three: the destination column IS "Source IP", so the
    // match succeeds, no rename is needed, and the conf carries no line bearing
    // the name at all. Until GEN-5 the build was green and the accessor
    // unbuildable; the YAML counts below are still 0 because there is still
    // nothing for that rule to read - the refusal is the plan check's.
    const { actions, issues, reductionIssues, planIssues, conf } =
      issuesForSample('[{"Source IP":"1.1.1.1"}]', [
        { name: "Source IP", type: "string" },
        TIME,
      ]);
    expect(actions).toEqual(["Source IP:keep"]);
    expect(conf).not.toContain("Source IP");
    expect(nameLinesFor(conf, "Type")).toHaveLength(1);
    expect(issues).toEqual([]);
    expect(reductionIssues).toEqual([]);
    expect(planIssues).toHaveLength(1);
    expect(planIssues[0]).toContain('field name "Source IP"');
    // Same on the rules-carrying reduction path, for the same reason: there is
    // no line bearing the name on either.
    const withRules = issuesForSample(
      '[{"Source IP":"1.1.1.1"}]',
      [{ name: "Source IP", type: "string" }, TIME],
      "CommonSecurityLog",
    );
    expect(withRules.reductionConf).not.toContain("Source IP");
    expect(withRules.reductionIssues).toEqual([]);
  });

  it("still says it at parse time in every one of those cases", () => {
    // The asymmetry above is only tolerable because the note is unconditional -
    // it fires on all six, refused and shipping alike, and does not try to
    // predict the fate. The two SHIPPING (dropped) cases in this list have no other
    // warning anywhere in the product.
    for (const content of [
      "src-ip=1.1.1.1 dst-ip=2.2.2.2 account-id=999",
      '[{"src-ip":"1.1.1.1","vendor-thing":"x"}]',
      '[{"a.b":"x"}]',
      "Device Action,Source IP,Destination IP,Source Port,Destination Port\nblock,1.1.1.1,2.2.2.2,443,80",
      '[{"Source IP":"1.1.1.1","Bad Thing":"x"}]',
      '[{"Source IP":"1.1.1.1"}]',
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
