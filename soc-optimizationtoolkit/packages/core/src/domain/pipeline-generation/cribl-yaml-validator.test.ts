/**
 * checkCriblYaml core validator - Unit 17.
 *
 * Pins the Cribl-safe YAML acceptance rules extracted from the legacy UAT
 * harness, including the added route-key (filter: not condition:) check.
 */

import { describe, it, expect } from "vitest";
import { generateBreakersYml } from "../pack-assembly/breakers";
import { checkCriblYaml, enclosingBlockPath } from "./cribl-yaml-validator";
import type { PipelineFieldMapping } from "./models";
import { generatePipelineConf } from "./pipeline-conf";
import { buildPipelinePlan } from "./plan";
import { generateRouteYml } from "./route-yml";

describe("checkCriblYaml acceptance rules", () => {
  it("accepts clean content", () => {
    const ok = [
      "output: default",
      "functions:",
      "  - id: eval",
      '    filter: "true"',
      "    description: Remove internal fields",
      "    groupId: cleanup",
    ].join("\n");
    expect(checkCriblYaml(ok, "conf.yml")).toEqual([]);
  });

  it("flags description: > multiline blocks", () => {
    const issues = checkCriblYaml("    description: >\n      wrapped", "conf.yml");
    expect(issues.some((i) => i.includes("multiline"))).toBe(true);
  });

  it("flags double-quoted descriptions", () => {
    const issues = checkCriblYaml('    description: "quoted thing"', "conf.yml");
    expect(issues.some((i) => i.includes("quoted"))).toBe(true);
  });

  it("flags colon+space (YAML mapping) inside an unquoted description", () => {
    const issues = checkCriblYaml("    description: key: value pair", "conf.yml");
    expect(issues.some((i) => i.includes("colon+space"))).toBe(true);
  });

  it("flags equals signs inside an unquoted description", () => {
    const issues = checkCriblYaml("    description: sets act=allow", "conf.yml");
    expect(issues.some((i) => i.includes("equals sign"))).toBe(true);
  });

  it("flags tab characters", () => {
    const issues = checkCriblYaml("\t- id: eval", "conf.yml");
    expect(issues.some((i) => i.includes("tab"))).toBe(true);
  });

  it("flags single-quoted field names in add/remove/rename", () => {
    expect(
      checkCriblYaml("        - name: 'Foo'", "conf.yml").some((i) =>
        i.includes("single-quoted name"),
      ),
    ).toBe(true);
    expect(
      checkCriblYaml("        - currentName: 'src'", "conf.yml").some((i) =>
        i.includes("currentName"),
      ),
    ).toBe(true);
    expect(
      checkCriblYaml("        - newName: 'SourceIP'", "conf.yml").some((i) =>
        i.includes("newName"),
      ),
    ).toBe(true);
  });
});

describe("route-key contract (filter: not condition:)", () => {
  it("flags condition: only in ROUTE files (content has a routes: key)", () => {
    const routeFile = [
      "id: default",
      "routes:",
      "  - id: r1",
      "    condition: \"true\"",
    ].join("\n");
    const issues = checkCriblYaml(routeFile, "route.yml");
    expect(issues.some((i) => i.includes("use filter:"))).toBe(true);
  });

  it("does NOT flag condition: in a non-route file (e.g. breakers.yml)", () => {
    const breakers = [
      "id: default",
      "rules:",
      "  - id: json_array",
      "    condition: /^\\[/",
    ].join("\n");
    expect(checkCriblYaml(breakers, "breakers.yml")).toEqual([]);
  });
});

describe("field names Cribl cannot address (DBT-78)", () => {
  const renameYaml = (name: string): string =>
    [
      "  - id: rename",
      "    conf:",
      "      rename:",
      `        - currentName: ${name}`,
      "          newName: AccountId",
    ].join(String.fromCharCode(10));

  it("FLAGS the hyphenated name a user actually hit", () => {
    // AWS VPC Flow Logs document their fields with hyphens. Cribl parses
    // currentName as a property accessor path, so `account-id` reads as
    // `account` minus `id` and dies at RUNTIME with "Failed to build property
    // accessor" - after the pipeline has loaded and silently renamed nothing.
    const issues = checkCriblYaml(renameYaml("account-id"), "conf.yml");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("account-id");
    expect(issues[0]).toContain("property accessor");
  });

  it("FLAGS a DOTTED name, which is the dangerous one", () => {
    // `a.b` IS a valid accessor - for a NESTED field. A flat field named `a.b`
    // therefore does not error at all: it addresses something that does not
    // exist, renames nothing, and reports success. Hyphens fail loudly; dots
    // fail quietly, so this pin matters more than the one above.
    expect(checkCriblYaml(renameYaml("a.b"), "conf.yml")).toHaveLength(1);
  });

  it("FLAGS a leading digit", () => {
    // Named honestly. This test was called "FLAGS a leading digit and a space"
    // and asserted only the digit; the space case is the test below, and it
    // FAILED until GEN-4. Believing the old name is how the parse note in
    // accessor-names.ts came to claim a guarantee that did not exist.
    expect(checkCriblYaml(renameYaml("1field"), "conf.yml")).toHaveLength(1);
  });

  it("FLAGS a name containing a SPACE (GEN-4)", () => {
    // The defect this pins: `([^'"\s][^\s]*)\s*$` could not match a value with
    // an internal space, so a rename Cribl cannot address shipped with a green
    // build. A space-headed CSV mints exactly this name.
    const issues = checkCriblYaml(renameYaml("Source IP"), "conf.yml");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('"Source IP"');
    expect(issues[0]).toContain("property accessor");
  });

  it("FLAGS a QUOTED unaddressable name - the quotes are YAML's, not Cribl's", () => {
    // `currentName: "Source IP"` reaches Cribl as the accessor path `Source IP`
    // and fails exactly as the bare form does. The old first-character guard
    // (`[^'"\s]`) refused to look at a quoted value at all.
    const doubled = checkCriblYaml(renameYaml('"Source IP"'), "conf.yml");
    expect(doubled).toHaveLength(1);
    expect(doubled[0]).toContain("Source IP");

    // The single-quoted form is BOTH: a quoting Cribl's YAML loader rejects,
    // and a name Cribl cannot address. Two issues, both true.
    const singled = checkCriblYaml(renameYaml("'Source IP'"), "conf.yml");
    expect(singled).toHaveLength(2);
    expect(singled.filter((i) => i.includes("single-quoted"))).toHaveLength(1);
    expect(singled.filter((i) => i.includes("property accessor"))).toHaveLength(1);
  });

  it("ACCEPTS a quoted name whose INNER value is addressable", () => {
    // This, not the test above, is the pin that earns the unquoting step -
    // measured, not assumed. A quote character is not accessor-safe either, so
    // an unaddressable name is caught with or without unquoting; what unquoting
    // changes is `"SourceIP"`, which reaches Cribl as the perfectly good path
    // SourceIP. Reading the quotes as part of the name would refuse it, and a
    // validator that refuses a working conf is the failure this rule exists to
    // avoid pointing the other way.
    expect(checkCriblYaml(renameYaml('"SourceIP"'), "conf.yml")).toEqual([]);
    // The message quotes the name Cribl sees, not the YAML token.
    expect(checkCriblYaml(renameYaml('"a.b"'), "conf.yml")[0]).toContain(
      'field name "a.b"',
    );
  });

  it("ACCEPTS a plain identifier, including underscores", () => {
    // The fix for a source that genuinely carries an unaddressable name is to
    // give the PARSER an addressable one - which is why the positional parser
    // emits account_id rather than AWS's account-id.
    expect(checkCriblYaml(renameYaml("account_id"), "conf.yml")).toEqual([]);
    expect(checkCriblYaml(renameYaml("_raw"), "conf.yml")).toEqual([]);
  });
});

describe("a GROUP name: is not a field name: (GEN-4)", () => {
  const RENAME: PipelineFieldMapping[] = [
    { source: "src", target: "SourceIP", type: "string", action: "rename" },
  ];

  /** A conf carrying ALL FIVE group headers the emitter can write. */
  function confWithEveryGroupHeader(
    renames: PipelineFieldMapping[] = RENAME,
  ): string {
    return generatePipelineConf(
      "p",
      "Acme",
      "Acme_CL",
      [
        ...renames,
        { source: "extra1", target: "extra1", type: "string", action: "overflow" },
      ],
      undefined,
      "json",
      {
        enabled: true,
        fieldName: "AdditionalExtensions",
        fieldType: "dynamic",
        sourceFields: ["extra1"],
      },
      {
        keep: [],
        drop: [
          { id: "d1", description: "noise", filter: "true", reason: "noise" },
        ],
        suppress: [],
      },
    );
  }

  it("a real conf carrying all five group headers is CLEAN", () => {
    const conf = confWithEveryGroupHeader();
    // The pin would pass vacuously if the emitter stopped writing headers, so
    // assert they are actually present and actually prose before asserting
    // clean. Naive widening produced exactly these as false issues: three on a
    // plain conf, five here.
    const headers = [
      "    name: Field Extraction",
      "    name: Volume Reduction",
      "    name: Enrich & Classify",
      "    name: Overflow Collection",
      "    name: Sentinel Cleanup",
    ];
    for (const header of headers) {
      expect(conf.split("\n")).toContain(header);
    }
    // And the field names ARE present on the same conf, so "clean" is not
    // "nothing was read".
    expect(conf).toContain("        - currentName: src");
    expect(conf).toContain("          name: Type");

    expect(checkCriblYaml(conf, "conf.yml")).toEqual([]);

    // ASSERTED AS AN ASYMMETRY, so it cannot pass by the rule reading nothing
    // on this conf: the SAME five-group conf with one unaddressable rename
    // source yields exactly one issue, and it is that source. An empty result
    // above therefore means "five prose headers were seen and correctly
    // ignored", not "the matcher never fired here".
    const spaced = confWithEveryGroupHeader([
      { source: "Source IP", target: "SourceIP", type: "string", action: "rename" },
    ]);
    const spacedIssues = checkCriblYaml(spaced, "conf.yml");
    expect(spacedIssues).toHaveLength(1);
    expect(spacedIssues[0]).toContain('"Source IP"');
  });

  it("breaker rule names and route names are prose too", () => {
    const breakers = generateBreakersYml("Acme");
    expect(breakers.split("\n")).toContain("    name: JSON Array Breaker");
    expect(checkCriblYaml(breakers, "breakers.yml")).toEqual([]);

    const plan = buildPipelinePlan({
      solutionName: "Acme-Widget",
      packName: "acme-widget-sentinel",
      version: "1.0.0",
      tables: [
        {
          sentinelTable: "Acme_CL",
          logType: "TRAFFIC",
          sourceFormat: "json",
          presetFields: RENAME,
        },
      ],
    });
    const route = generateRouteYml(plan);
    expect(route).toContain('    name: "Transform: TRAFFIC"');
    expect(checkCriblYaml(route, "route.yml")).toEqual([]);
  });

  it("the PARENT is checked, so a group id spelled add: cannot masquerade", () => {
    // `add` and `rename` are accessor blocks only directly under a function's
    // `conf:`. A pipeline group whose id happened to be `add` sits under
    // `groups:` and its name is still prose.
    const yaml = [
      "groups:",
      "  add:",
      "    name: Field Extraction",
      "    disabled: false",
    ].join("\n");
    expect(checkCriblYaml(yaml, "conf.yml")).toEqual([]);
  });

  it("a whitespace name IS refused inside a real generated conf, end to end", () => {
    const plan = buildPipelinePlan({
      solutionName: "Acme-Widget",
      packName: "acme-widget-sentinel",
      version: "1.0.0",
      tables: [
        {
          sentinelTable: "Acme_CL",
          logType: "TRAFFIC",
          sourceFormat: "json",
          presetFields: [
            { source: "Source IP", target: "SrcIpAddr", type: "string", action: "rename" },
          ],
        },
      ],
    });
    const conf = generatePipelineConf(
      plan.tables[0].pipelineName,
      "Acme-Widget",
      plan.tables[0].sentinelTable,
      plan.tables[0].fields,
      undefined,
      "json",
    );
    expect(conf).toContain("        - currentName: Source IP");
    const issues = checkCriblYaml(conf, "conf.yml");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('"Source IP"');
  });
});

describe("a line ending cannot silence a rule", () => {
  /** The same five-line rename conf, joined with whichever line ending. */
  const renameYaml = (name: string, eol: string): string =>
    [
      "  - id: rename",
      "    conf:",
      "      rename:",
      `        - currentName: ${name}`,
      "          newName: AccountId",
    ].join(eol);

  it("a trailing line terminator the SPLIT cannot reach still cannot silence the rule", () => {
    // THE RESIDUAL THE FIRST FIX LEFT, and the reason both guards ship rather
    // than the elegant one alone. Normalising line endings closes CR, CRLF and
    // lone LF. It does NOT close U+2028 LINE SEPARATOR or U+2029 PARAGRAPH
    // SEPARATOR: those are JavaScript line terminators, so `.` does not match
    // them, but `split(/\r\n|\n|\r/)` does not break on them either, so the
    // normalisation never sees them and the matcher returned null.
    //
    // Measured on this exact conf before the tail was restored: LS and PS gave
    // 0 issues where a bare line gave 1. Reachability is low - no emitter writes
    // U+2028, and YAML 1.2 does not treat it as a break - so it would have to
    // arrive INSIDE a vendor field name. Pinned anyway because the direction is
    // the fail-open one, and because "it fixes the class" was the argument that
    // left it open.
    const LS = String.fromCharCode(0x2028);
    const PS = String.fromCharCode(0x2029);
    const plain = checkCriblYaml(renameYaml("account-id", "\n"), "conf.yml");
    // Not vacuous: the unmodified conf genuinely fires, so an equal count below
    // is a rule that ran rather than a rule that found nothing to say.
    expect(plain).toHaveLength(1);
    for (const terminator of [LS, PS]) {
      const withTail = checkCriblYaml(
        renameYaml("account-id", "\n").replace(
          "- currentName: account-id",
          `- currentName: account-id${terminator}`,
        ),
        "conf.yml",
      );
      expect(withTail).toHaveLength(1);
    }
  });

  it("a CRLF conf reports exactly what its LF twin reports", () => {
    // THE DEFECT THIS PINS, and it failed OPEN. GEN-4's matcher tail was
    // `(.+?) *$`; a carriage return is a JavaScript line terminator, so `.`
    // does not match one and a literal-space class does not consume one. On
    // CRLF content the matcher read null for every name line and the accessor
    // rule reported the file CLEAN - measured 0 issues where LF gave 1, for
    // account-id and a.b alike. The pre-GEN-4 regex caught both, its `\s*$`
    // tail having absorbed the carriage return by accident.
    //
    // Asserted as EQUALITY of the issue arrays, not of their lengths, so the
    // "Line N:" numbers and the echoed line have to agree too.
    for (const name of ["account-id", "a.b", "Source IP"]) {
      const lf = checkCriblYaml(renameYaml(name, "\n"), "conf.yml");
      // Not vacuous: the LF twin genuinely fires, so an equal CRLF result is
      // "the rule ran and agreed", never "neither of them read anything".
      expect(lf).toHaveLength(1);
      expect(checkCriblYaml(renameYaml(name, "\r\n"), "conf.yml")).toEqual(lf);
    }

    // ...and the rule stays quiet on an addressable name, on both endings, so
    // this is not pinned by making everything an issue.
    expect(checkCriblYaml(renameYaml("account_id", "\r\n"), "conf.yml")).toEqual([]);
  });

  it("a lone carriage return splits lines too, which the route rule needs", () => {
    // Measured per rule 2026-09-03: on `\r`-joined content the whole document
    // was ONE line, so `isRouteFile` never saw `^routes:` and the route-key
    // rule read 0 as well. Splitting on all three forms is what makes the
    // counts AND the line numbers identical.
    const routeFile = (eol: string): string =>
      ["id: default", "routes:", "  - id: r1", '    condition: "true"'].join(eol);
    const lf = checkCriblYaml(routeFile("\n"), "route.yml");
    expect(lf).toHaveLength(1);
    expect(lf[0]).toContain("Line 4:");
    expect(checkCriblYaml(routeFile("\r"), "route.yml")).toEqual(lf);
    expect(checkCriblYaml(routeFile("\r\n"), "route.yml")).toEqual(lf);

    expect(checkCriblYaml(renameYaml("account-id", "\r"), "conf.yml")).toEqual(
      checkCriblYaml(renameYaml("account-id", "\n"), "conf.yml"),
    );
  });

  it("a REAL generated conf keeps its verdict when the file is CRLF", () => {
    // The unit above pins the rule; this pins the thing an operator would hit -
    // a whole emitted conf whose file happens to carry Windows line endings.
    const plan = buildPipelinePlan({
      solutionName: "Acme-Widget",
      packName: "acme-widget-sentinel",
      version: "1.0.0",
      tables: [
        {
          sentinelTable: "Acme_CL",
          logType: "TRAFFIC",
          sourceFormat: "json",
          presetFields: [
            { source: "Source IP", target: "SrcIpAddr", type: "string", action: "rename" },
          ],
        },
      ],
    });
    const conf = generatePipelineConf(
      plan.tables[0].pipelineName,
      "Acme-Widget",
      plan.tables[0].sentinelTable,
      plan.tables[0].fields,
      undefined,
      "json",
    );
    const crlfConf = conf.replace(/\n/g, "\r\n");
    // The twin really is CRLF, and it really does carry the bad name.
    expect(crlfConf).toContain("\r\n");
    expect(crlfConf).toContain("        - currentName: Source IP\r\n");

    const lf = checkCriblYaml(conf, "conf.yml");
    expect(lf).toHaveLength(1);
    expect(lf[0]).toContain('"Source IP"');
    expect(checkCriblYaml(crlfConf, "conf.yml")).toEqual(lf);

    // And a CLEAN conf is still clean on CRLF - the fix widens what is read,
    // not what is refused. Paired with the assertion above so "0 issues" here
    // cannot be the rule going silent again.
    const cleanConf = generatePipelineConf(
      "p",
      "Acme",
      "Acme_CL",
      [{ source: "src", target: "SourceIP", type: "string", action: "rename" }],
      undefined,
      "json",
    );
    expect(cleanConf).toContain("        - currentName: src");
    expect(checkCriblYaml(cleanConf.replace(/\n/g, "\r\n"), "conf.yml")).toEqual([]);
  });
});

describe("enclosingBlockPath - the block structure the accessor rule selects on", () => {
  const conf = [
    "groups:",
    "  extract:",
    "    name: Field Extraction",
    "functions:",
    "  - id: eval",
    "    conf:",
    "      add:",
    "        - disabled: false",
    "          name: Type",
    "      remove:",
    "        - _raw",
    "    groupId: cleanup",
  ];

  it("reports the enclosing keys, not the line's own key", () => {
    const paths = enclosingBlockPath(conf);
    expect(paths[0]).toEqual([]); // groups:
    expect(paths[1]).toEqual(["groups"]); // extract:
    expect(paths[2]).toEqual(["groups", "extract"]); // group name (prose)
    expect(paths[3]).toEqual([]); // functions:
    expect(paths[6]).toEqual(["functions", "conf"]); // add:
    expect(paths[8]).toEqual(["functions", "conf", "add"]); // field name
    expect(paths[10]).toEqual(["functions", "conf", "remove"]); // GEN-5's bullets
    expect(paths[11]).toEqual(["functions"]); // groupId:, back out of conf:
  });

  it("a bullet nests by its CONTENT column, not by its indentation", () => {
    // `        - name: x` and `          name: x` are the same depth: the key
    // begins at column 10 either way.
    const paths = enclosingBlockPath(conf);
    expect(paths[7]).toEqual(["functions", "conf", "add"]); // "- disabled: false"
    expect(paths[8]).toEqual(paths[7]);

    // MEASURED, so the claim above is not decorative: the two readings only
    // DISAGREE when a sequence is indented level with its own key, which is
    // valid YAML for the same structure and which these emitters never write
    // (they indent bullets two columns deeper, where both readings agree - the
    // first pair above). Mutating the column to plain indentation therefore
    // breaks nothing in a generated conf, and breaks this:
    expect(enclosingBlockPath(["conf:", "  add:", "    - name: Foo"])[2]).toEqual([
      "conf",
      "add",
    ]);
    expect(enclosingBlockPath(["conf:", "  add:", "  - name: Foo"])[2]).toEqual([
      "conf",
      "add",
    ]);
  });

  it("blank and comment lines do not close the blocks above them", () => {
    const paths = enclosingBlockPath([
      "functions:",
      "  - id: eval",
      "    conf:",
      "      add:",
      "",
      "# a comment at column 0",
      "        - name: Type",
    ]);
    expect(paths[4]).toEqual(["functions", "conf", "add"]);
    expect(paths[5]).toEqual(["functions", "conf", "add"]);
    expect(paths[6]).toEqual(["functions", "conf", "add"]);
  });

  it("an INLINE value opens no block", () => {
    // `add: []`, `conf: {}` and route.yml's `groups: {}` are complete values.
    const paths = enclosingBlockPath([
      "groups: {}",
      "routes:",
      "  - id: r1",
      "    name: \"Transform: TRAFFIC\"",
    ]);
    expect(paths[3]).toEqual(["routes"]);
  });

  it("a folded scalar's continuation lines stay under their conf:", () => {
    const paths = enclosingBlockPath([
      "functions:",
      "  - id: comment",
      "    conf:",
      "      comment: >",
      "        No built-in reduction rules for this table.",
    ]);
    expect(paths[4]).toEqual(["functions", "conf"]);
  });
});
