import { describe, expect, it } from "vitest";

import { buildPipelinePlan } from "../pipeline-generation";
import {
  applyRetention,
  buildRecordId,
  crblFileName,
  makeBuildRecord,
  type PackBuildRecord,
} from "./build-record";

describe("build record identity + .crbl naming", () => {
  it("sanitizes disallowed characters in id and filename", () => {
    expect(buildRecordId("palo alto/sentinel", "1.0.0")).toBe("palo-alto-sentinel_1.0.0");
    expect(crblFileName("palo alto", "1.0.0")).toBe("palo-alto_1.0.0.crbl");
  });

  it("builds a record from a resolved plan", () => {
    const plan = buildPipelinePlan({
      solutionName: "Palo Alto",
      packName: "paloalto-sentinel",
      version: "2.0.0",
      tables: [
        { sentinelTable: "CommonSecurityLog", logType: "TRAFFIC" },
        { sentinelTable: "CommonSecurityLog", logType: "THREAT" },
      ],
    });
    const record = makeBuildRecord(plan, { builtAtMs: 42, crblSizeBytes: 1000, displayName: "Palo Sentinel" });
    expect(record.id).toBe("paloalto-sentinel_2.0.0");
    expect(record.tables).toEqual(["CommonSecurityLog"]);
    expect(record.builtAtMs).toBe(42);
    expect(record.crblFileName).toBe("paloalto-sentinel_2.0.0.crbl");
    expect(record.crblSizeBytes).toBe(1000);
  });
});

describe("applyRetention", () => {
  const rec = (packName: string, version: string, builtAtMs: number): PackBuildRecord => ({
    id: buildRecordId(packName, version),
    packName,
    displayName: packName,
    version,
    solutionName: "s",
    builtAtMs,
    tables: [],
    crblFileName: crblFileName(packName, version),
    crblSizeBytes: 0,
  });

  it("keeps the newest N per pack, evicting older builds", () => {
    const records = [
      rec("a", "1.0.0", 100),
      rec("a", "1.1.0", 300),
      rec("a", "1.0.5", 200),
      rec("b", "1.0.0", 50),
    ];
    const { kept, removed } = applyRetention(records, 2);
    const keptIds = kept.map((r) => r.id).sort();
    expect(keptIds).toEqual(["a_1.0.5", "a_1.1.0", "b_1.0.0"].sort());
    expect(removed.map((r) => r.id)).toEqual(["a_1.0.0"]);
  });

  it("removes everything when keepPerPack < 1", () => {
    const records = [rec("a", "1.0.0", 100)];
    expect(applyRetention(records, 0).kept).toEqual([]);
    expect(applyRetention(records, 0).removed).toHaveLength(1);
  });
});
