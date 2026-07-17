import { describe, expect, it } from "vitest";
import {
  FLOWLOG_JOB_ID,
  FLOWLOG_PACK_NAME,
  FLOWLOG_ROUTE_YML,
  FLOWLOG_SECRET_NAME,
  assembleFlowLogPack,
  renderFlowLogJobsYml,
} from "./lab-flowlog-pack";
import {
  FLOWLOG_BREAKERS_YML,
  FLOWLOG_PACKAGE_JSON,
  FLOWLOG_PREPROCESSING_CONF_YML,
} from "./flowlog-pack-assets";
import { parseUstarTar, ungzipStored } from "../pack-assembly";

const PARAMS = {
  storageAccountName: "sacribllabcribl",
  tenantId: "tenant-1",
  clientId: "client-1",
};

describe("verbatim pack assets", () => {
  it("carries the legacy breaker ruleset (json_array on records)", () => {
    expect(FLOWLOG_BREAKERS_YML).toContain("Azure_vNet_FlowLogs:");
    expect(FLOWLOG_BREAKERS_YML).toContain("type: json_array");
    expect(FLOWLOG_BREAKERS_YML).toContain("jsonArrayField: records");
    expect(FLOWLOG_BREAKERS_YML).toContain("maxEventBytes: 512000");
  });

  it("carries the triple-unroll preprocessing pipeline", () => {
    expect(FLOWLOG_PREPROCESSING_CONF_YML).toContain("srcExpr: flowRecords.flows");
    expect(FLOWLOG_PREPROCESSING_CONF_YML).toContain("srcExpr: flow.flowGroups");
    expect(FLOWLOG_PREPROCESSING_CONF_YML).toContain("srcExpr: flowGroup.flowTuples");
    expect(FLOWLOG_PREPROCESSING_CONF_YML).toContain("dstField: _raw");
  });

  it("carries the v0.0.3 manifest verbatim", () => {
    const manifest = JSON.parse(FLOWLOG_PACKAGE_JSON);
    expect(manifest.name).toBe("AzureFlowLogs");
    expect(manifest.version).toBe("0.0.3");
    expect(manifest.minLogStreamVersion).toBe("4.14.0");
  });

  it("keeps only the default route (the Redis dedup entry is omitted)", () => {
    expect(FLOWLOG_ROUTE_YML).toContain("id: default");
    expect(FLOWLOG_ROUTE_YML).not.toContain("Dedup_Redis");
  });
});

describe("renderFlowLogJobsYml", () => {
  it("injects the real values where the legacy shipped placeholders", () => {
    const yml = renderFlowLogJobsYml(PARAMS);
    expect(yml).toContain(`${FLOWLOG_JOB_ID}:`);
    expect(yml).toContain("storageAccountName: sacribllabcribl");
    expect(yml).toContain("tenantId: tenant-1");
    expect(yml).toContain("clientId: client-1");
    expect(yml).not.toContain("<replace me>");
    expect(yml).toContain(`clientTextSecret: ${FLOWLOG_SECRET_NAME}`);
  });

  it("keeps the legacy schedule shape and enables it by default", () => {
    const yml = renderFlowLogJobsYml(PARAMS);
    expect(yml).toContain("cronSchedule: 15 * * * *");
    expect(yml).toContain("earliest: -75m");
    expect(yml).toContain("latest: -15m");
    expect(yml).toContain("enabled: true");
    expect(yml).toContain(
      "path: flowLogResourceID=/${*}/${*}/${_time:y=%Y}/${_time:m=%m}/${_time:d=%d}/${_time:h=%H}",
    );
    expect(renderFlowLogJobsYml({ ...PARAMS, scheduleEnabled: false })).toContain(
      "enabled: false",
    );
  });

  it("references the pack's breaker and pipeline by their legacy names", () => {
    const yml = renderFlowLogJobsYml(PARAMS);
    expect(yml).toContain("- Azure_vNet_FlowLogs");
    expect(yml).toContain("pipeline: Azure_vNet_FlowLogs_PreProcessing");
  });
});

describe("assembleFlowLogPack", () => {
  it("builds a deterministic .crbl with the legacy layout", () => {
    const first = assembleFlowLogPack(PARAMS, 1_760_000_000_000);
    const second = assembleFlowLogPack(PARAMS, 1_760_000_000_000);
    expect(first.crblFileName).toBe("AzureFlowLogs_0.0.3.crbl");
    expect(first.packName).toBe(FLOWLOG_PACK_NAME);
    expect(Buffer.from(first.crbl).equals(Buffer.from(second.crbl))).toBe(true);

    const entries = parseUstarTar(ungzipStored(first.crbl));
    const names = entries
      .filter((e) => !e.isDir)
      .map((e) => e.path)
      .sort();
    expect(names).toEqual([
      "default/breakers.yml",
      "default/jobs.yml",
      "default/pack.yml",
      "default/pipelines/Azure_vNet_FlowLogs_PreProcessing/conf.yml",
      "default/pipelines/route.yml",
      "package.json",
    ]);
  });
});
