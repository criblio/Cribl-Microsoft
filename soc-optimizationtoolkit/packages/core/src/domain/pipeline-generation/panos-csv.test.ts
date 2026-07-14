/**
 * PAN-OS CSV positional map - Unit 17 (b).
 *
 * Pins that the CSV branch strips the syslog prefix, splits on comma, and assigns
 * named fields from Unit 12's CANONICAL PANOS_CSV_HEADERS dictionary (not a
 * legacy hard-coded subset), skipping future_use placeholders while preserving
 * their index positions.
 */

import { describe, it, expect } from "vitest";
import { generatePipelineConf } from "./pipeline-conf";
import { PANOS_CSV_HEADERS } from "../sample-parsing";
import { checkCriblYaml } from "./cribl-yaml-validator";

describe("PAN-OS CSV extraction", () => {
  const yaml = generatePipelineConf(
    "p",
    "Palo Alto Networks PAN-OS",
    "CommonSecurityLog",
    [],
    undefined,
    "csv",
    undefined,
    null,
    "TRAFFIC",
  );

  it("strips the syslog prefix then splits on comma", () => {
    expect(yaml).toContain("name: __csvRaw");
    expect(yaml).toContain("name: __csvParts");
    expect(yaml).toContain("Assign PAN-OS CSV columns to named fields");
  });

  it("assigns TRAFFIC columns at their canonical Unit-12 indices", () => {
    expect(yaml).toContain(
      '- name: receive_time\n          value: "(__csvParts && __csvParts.length > 1) ? __csvParts[1] : undefined"',
    );
    expect(yaml).toContain(
      '- name: src\n          value: "(__csvParts && __csvParts.length > 7) ? __csvParts[7] : undefined"',
    );
    expect(yaml).toContain(
      '- name: dst\n          value: "(__csvParts && __csvParts.length > 8) ? __csvParts[8] : undefined"',
    );
    expect(yaml).toContain(
      '- name: action\n          value: "(__csvParts && __csvParts.length > 30) ? __csvParts[30] : undefined"',
    );
  });

  it("skips future_use placeholder columns", () => {
    expect(yaml).not.toContain("name: future_use1");
    expect(yaml).not.toContain("name: future_use2");
  });

  it("reuses THREAT dictionary columns when logType is THREAT", () => {
    const threatYaml = generatePipelineConf(
      "p",
      "Palo Alto Networks PAN-OS",
      "CommonSecurityLog",
      [],
      undefined,
      "csv",
      undefined,
      null,
      "THREAT",
    );
    // threatid sits at index 32 in the canonical THREAT dictionary.
    expect(PANOS_CSV_HEADERS["THREAT"][32]).toBe("threatid");
    expect(threatYaml).toContain(
      '- name: threatid\n          value: "(__csvParts && __csvParts.length > 32) ? __csvParts[32] : undefined"',
    );
  });

  it("the generated PAN-OS CSV pipeline passes checkCriblYaml", () => {
    expect(checkCriblYaml(yaml, "conf.yml")).toEqual([]);
  });
});
