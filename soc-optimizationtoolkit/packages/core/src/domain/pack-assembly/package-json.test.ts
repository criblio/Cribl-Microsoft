import { describe, expect, it } from "vitest";

import { buildPipelinePlan } from "../pipeline-generation";
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
