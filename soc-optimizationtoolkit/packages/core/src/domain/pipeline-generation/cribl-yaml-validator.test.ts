/**
 * checkCriblYaml core validator - Unit 17.
 *
 * Pins the Cribl-safe YAML acceptance rules extracted from the legacy UAT
 * harness, including the added route-key (filter: not condition:) check.
 */

import { describe, it, expect } from "vitest";
import { checkCriblYaml } from "./cribl-yaml-validator";

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

  it("FLAGS a leading digit and a space", () => {
    expect(checkCriblYaml(renameYaml("1field"), "conf.yml")).toHaveLength(1);
  });

  it("ACCEPTS a plain identifier, including underscores", () => {
    // The fix for a source that genuinely carries an unaddressable name is to
    // give the PARSER an addressable one - which is why the positional parser
    // emits account_id rather than AWS's account-id.
    expect(checkCriblYaml(renameYaml("account_id"), "conf.yml")).toEqual([]);
    expect(checkCriblYaml(renameYaml("_raw"), "conf.yml")).toEqual([]);
  });
});
