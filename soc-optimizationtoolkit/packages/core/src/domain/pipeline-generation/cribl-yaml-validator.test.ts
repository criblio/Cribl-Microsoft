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
