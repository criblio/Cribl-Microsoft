/**
 * File-selection persistence filter - porting-plan Unit 14 (verbatim
 * extension/dir sets from sentinel-repo.ts isIncluded).
 */
import { describe, expect, it } from "vitest";
import {
  ANALYTIC_RULE_DIR_VARIANTS,
  BLOCKED_EXTENSIONS,
  INCLUDED_EXTENSIONS,
  RULE_FILE_CAP,
  extname,
  isContentPathIncluded,
  isRuleYamlFileName,
} from "./file-selection";

describe("extname", () => {
  it("returns the lowercased final extension", () => {
    expect(extname("Solutions/Foo/Data Connectors/c.JSON")).toBe(".json");
    expect(extname("a/b/archive.tar.gz")).toBe(".gz");
    expect(extname("Solutions/Foo/Parsers/asim.yaml")).toBe(".yaml");
  });
  it("returns '' for no-extension and dotfile segments", () => {
    expect(extname("Solutions/Foo/README")).toBe("");
    expect(extname("Solutions/Foo/.gitignore")).toBe("");
    expect(extname("Solutions/Foo/Data Connectors/")).toBe("");
  });
});

describe("isContentPathIncluded", () => {
  it("includes text content under Solutions/ and repo-root Sample Data/", () => {
    expect(isContentPathIncluded("Solutions/Foo/Analytic Rules/rule.yaml")).toBe(true);
    expect(isContentPathIncluded("Solutions/Foo/Data Connectors/conn.json")).toBe(true);
    expect(isContentPathIncluded("Solutions/Foo/Parsers/p.yml")).toBe(true);
    expect(isContentPathIncluded("Solutions/Foo/README.md")).toBe(true);
    expect(isContentPathIncluded("Solutions/Foo/Sample Data/log.csv")).toBe(true);
    expect(isContentPathIncluded("Solutions/Foo/Sample Data/raw.log")).toBe(true);
    expect(isContentPathIncluded("Sample Data/vendor/x.txt")).toBe(true);
    expect(isContentPathIncluded("Solutions/Foo/query.kql")).toBe(true);
  });

  it("excludes paths outside Solutions/ and Sample Data/", () => {
    expect(isContentPathIncluded("Playbooks/deploy.json")).toBe(false);
    expect(isContentPathIncluded("Logos/vendor.svg")).toBe(false);
    expect(isContentPathIncluded("README.md")).toBe(false);
  });

  it("hard-blocks EDR-triggering script/binary/archive extensions", () => {
    expect(isContentPathIncluded("Solutions/Foo/Playbooks/run.ps1")).toBe(false);
    expect(isContentPathIncluded("Solutions/Foo/Playbooks/run.py")).toBe(false);
    expect(isContentPathIncluded("Solutions/Foo/Data/func.zip")).toBe(false);
    expect(isContentPathIncluded("Solutions/Foo/bin/tool.exe")).toBe(false);
    expect(isContentPathIncluded("Solutions/Foo/lib/x.dll")).toBe(false);
  });

  it("skips media/binary extensions", () => {
    expect(isContentPathIncluded("Solutions/Foo/Data/logo.png")).toBe(false);
    expect(isContentPathIncluded("Solutions/Foo/Data/doc.pdf")).toBe(false);
    expect(isContentPathIncluded("Solutions/Foo/Data/db.bacpac")).toBe(false);
  });

  it("skips useless/risky directory segments even for included extensions", () => {
    expect(isContentPathIncluded("Solutions/Foo/images/diagram.yaml")).toBe(false);
    expect(isContentPathIncluded("Solutions/Foo/.github/workflow.yml")).toBe(false);
    expect(isContentPathIncluded("Solutions/Foo/node_modules/pkg.json")).toBe(false);
    expect(isContentPathIncluded("Solutions/Foo/media/clip.yaml")).toBe(false);
  });

  it("excludes unknown extensions under an allowed root", () => {
    expect(isContentPathIncluded("Solutions/Foo/Data/notes.xyz")).toBe(false);
    expect(isContentPathIncluded("Solutions/Foo/Data/noext")).toBe(false);
  });

  it("the set memberships are the exact legacy sets", () => {
    expect(INCLUDED_EXTENSIONS.has(".yaml")).toBe(true);
    expect(INCLUDED_EXTENSIONS.has(".json")).toBe(true);
    expect(INCLUDED_EXTENSIONS.has(".kql")).toBe(true);
    expect(BLOCKED_EXTENSIONS.has(".ps1")).toBe(true);
    expect(BLOCKED_EXTENSIONS.has(".zip")).toBe(true);
    // .json is content, never blocked.
    expect(BLOCKED_EXTENSIONS.has(".json")).toBe(false);
  });
});

/**
 * The analytic-rule location rules, shared by rule-coverage and SIEM migration.
 *
 * These were duplicated until the 2026-08-17 audit - each consumer had its own
 * copy of the dir variants and the predicate, and its own rule cap (150 vs 40).
 * Only one copy was pinned, so a change to the other was invisible: adding a
 * fourth dir variant here would have kept that pin green while the other
 * consumer probed three, and the cap split meant a solution over 40 rules was
 * analysed in full by one screen and truncated by the other.
 *
 * Pinned in CORE now, which is what makes it one decision instead of two.
 */
describe("analytic-rule location - one definition for both consumers", () => {
  it("probes the three dir-name variants in the legacy order", () => {
    expect(ANALYTIC_RULE_DIR_VARIANTS).toEqual([
      "Analytic Rules",
      "Analytics Rules",
      "AnalyticRules",
    ]);
  });

  it("accepts both YAML extensions, case-insensitively, and nothing else", () => {
    expect(isRuleYamlFileName("Rule.yaml")).toBe(true);
    expect(isRuleYamlFileName("rule.YML")).toBe(true);
    expect(isRuleYamlFileName("rule.json")).toBe(false);
    expect(isRuleYamlFileName("yaml")).toBe(false);
  });

  it("caps rule reads at 150 - the value BOTH consumers now use", () => {
    // The number itself is the decision (2026-08-17): the larger of the two
    // that were in force, so the migration analysis stops silently ignoring
    // three quarters of a large solution's rules. Changing it is a product
    // decision about read budget, so it should break this pin and be re-pinned.
    expect(RULE_FILE_CAP).toBe(150);
  });
});
