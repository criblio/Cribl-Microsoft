/**
 * File-selection persistence filter - porting-plan Unit 14 (verbatim
 * extension/dir sets from sentinel-repo.ts isIncluded).
 */
import { describe, expect, it } from "vitest";
import {
  BLOCKED_EXTENSIONS,
  INCLUDED_EXTENSIONS,
  extname,
  isContentPathIncluded,
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
