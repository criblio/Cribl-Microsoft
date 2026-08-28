import { describe, expect, it } from "vitest";

import { buildPipelinePlan } from "../pipeline-generation";
import type { PipelinePlan } from "../pipeline-generation";
import {
  buildPackageJson,
  MIN_LOG_STREAM_VERSION,
  renderPackageJson,
  streamtagsFromPackage,
} from "./package-json";

function plan() {
  return buildPipelinePlan({
    solutionName: "Palo Alto PAN-OS",
    packName: "paloalto-sentinel",
    version: "1.2.3",
    tables: [
      { sentinelTable: "CommonSecurityLog", logType: "TRAFFIC" },
      { sentinelTable: "CommonSecurityLog", logType: "THREAT" },
    ],
  });
}

describe("buildPackageJson", () => {
  it("builds the manifest with deduplicated destination tables", () => {
    const pkg = buildPackageJson(plan());
    expect(pkg.name).toBe("paloalto-sentinel");
    expect(pkg.version).toBe("1.2.3");
    expect(pkg.author).toBe("Cribl SOC Toolkit");
    expect(pkg.description).toContain("CommonSecurityLog");
    // Deduped: CommonSecurityLog appears once even with two log types.
    expect(pkg.description.match(/CommonSecurityLog/g)).toHaveLength(1);
    expect(pkg.exports).toEqual(["*"]);
    expect(pkg.minLogStreamVersion).toBe(MIN_LOG_STREAM_VERSION);
    expect(pkg.tags.streamtags).toEqual(["palo-alto-pan-os", "sentinel"]);
  });

  it("renders as 2-space JSON with a trailing newline", () => {
    const out = renderPackageJson(buildPackageJson(plan()));
    expect(out.endsWith("}\n")).toBe(true);
    expect(out).toContain('\n  "name": "paloalto-sentinel"');
  });
});

describe("streamtagsFromPackage (the always-empty read fix)", () => {
  it("reads the correct nested tags.streamtags array", () => {
    const pkg = buildPackageJson(plan());
    expect(streamtagsFromPackage(pkg)).toEqual(["palo-alto-pan-os", "sentinel"]);
  });

  it("tolerates the legacy top-level array and comma-joined string", () => {
    expect(streamtagsFromPackage({ streamtags: ["a", "b"] })).toEqual(["a", "b"]);
    expect(streamtagsFromPackage({ streamtags: "a, b ,c" })).toEqual(["a", "b", "c"]);
  });

  it("returns [] for missing/unrecognized shapes", () => {
    expect(streamtagsFromPackage({})).toEqual([]);
    expect(streamtagsFromPackage(null)).toEqual([]);
    expect(streamtagsFromPackage({ tags: {} })).toEqual([]);
  });
});

describe("GEN-3 - a built pack says what built it", () => {
  const plan = {
    solutionName: "Zscaler",
    packName: "ms-sentinel-zscaler",
    version: "3",
    vendorPrefix: "zscaler",
    tables: [],
  } as unknown as PipelinePlan;

  it("stamps the toolkit version into author when the shell supplies one", () => {
    // The question the card records paying for: given a .crbl in a workspace,
    // is this the one just built? `version` cannot answer - it is
    // highest-installed-plus-one, so it counts rebuilds.
    const pkg = buildPackageJson({ ...plan, toolkitVersion: "1.12.3" });

    expect(pkg.author).toBe("Cribl SOC Toolkit 1.12.3");
  });

  it("stays the bare legacy author when nothing supplied one", () => {
    // Honestly silent, not "unknown". A missing stamp is checkable; a literal
    // "unknown" is a claim, and would also break byte-stability for every
    // existing pack rebuilt without the shell.
    expect(buildPackageJson(plan).author).toBe("Cribl SOC Toolkit");
    expect(buildPackageJson({ ...plan, toolkitVersion: "  " }).author).toBe(
      "Cribl SOC Toolkit",
    );
  });

  it("does NOT add a ninth manifest key", () => {
    // The manifest is the eight Cribl pack fields and this module's contract is
    // byte-stability with the legacy emitter. Provenance rides an existing
    // field precisely so a .crbl's shape does not change.
    const pkg = buildPackageJson({ ...plan, toolkitVersion: "1.12.3" });

    expect(Object.keys(pkg).sort()).toEqual([
      "author",
      "description",
      "displayName",
      "exports",
      "minLogStreamVersion",
      "name",
      "tags",
      "version",
    ]);
  });

  it("keeps the pack version and the toolkit version APART", () => {
    // Two different numbers that both look like versions - conflating them is
    // the whole reason the pack could not answer the question.
    const pkg = buildPackageJson({ ...plan, version: "3", toolkitVersion: "1.12.3" });

    expect(pkg.version).toBe("3");
    expect(pkg.author).toContain("1.12.3");
    expect(pkg.author).not.toContain('"3"');
  });
});
