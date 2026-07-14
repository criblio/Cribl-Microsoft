/**
 * Recursive connector-file discovery - porting-plan Unit 14. This RE-RECORDS
 * legacy IS-T/test-uat-crowdstrike.ts TEST 10 ("Recursive Connector File
 * Discovery") as a FIXTURE-BASED test over the SentinelContent port fake,
 * replacing its %APPDATA% sentinel-repo mirror dependency (the original
 * skipped when the repo was not cloned).
 *
 * The pin: CrowdStrikeCustomDCR.json sits TWO levels below the connector root
 * (Data Connectors/CrowdstrikeReplicatorCLv2/Data Collection Rules/...) and
 * must still be discovered.
 */
import { describe, expect, it } from "vitest";
import { FakeSentinelContent } from "../../testing/fake-sentinel-content";
import { decodeConnector } from "./connector-decoder";
import { CROWDSTRIKE_CUSTOM_DCR } from "../../assets/sentinel-connectors";

const CS = "CrowdStrike Falcon Endpoint Protection";
const CONN = `Solutions/${CS}/Data Connectors`;
const NESTED = `${CONN}/CrowdstrikeReplicatorCLv2/Data Collection Rules`;

// A tiny virtual repo mirroring the real nesting (paths are what matters).
const content = new FakeSentinelContent({
  commitSha: "0123456789ab",
  files: {
    // CrowdStrike: a top-level connector + two DCR files nested 2 levels deep,
    // plus a non-JSON file that must be ignored.
    [`${CONN}/CrowdstrikeReplicator.json`]: JSON.stringify({ title: "CrowdStrike" }),
    [`${NESTED}/CrowdStrikeCustomDCR.json`]: JSON.stringify(CROWDSTRIKE_CUSTOM_DCR),
    [`${NESTED}/CrowdStrikeNormalizationDCR.json`]: JSON.stringify({ resources: [] }),
    [`${NESTED}/readme.md`]: "not a connector json",
    [`Solutions/${CS}/Analytic Rules/rule.yaml`]: "id: x",
    // Another solution whose name matches PaloAlto-PAN-OS.
    ["Solutions/PaloAlto-PAN-OS/Data Connectors/PaloAlto.json"]: "{}",
    // A third solution so listSolutions is non-trivial.
    ["Solutions/1Password/Data Connectors/1Password_ccpv2/def.json"]: "{}",
  },
});

describe("TEST 10 re-record: recursive connector discovery (2 levels deep)", () => {
  it("finds every connector JSON including the nested DCR files", async () => {
    const files = await content.listConnectorFiles(CS);
    const names = files.map((f) => f.name);
    expect(names).toContain("CrowdstrikeReplicator.json");
    expect(names).toContain("CrowdStrikeCustomDCR.json");
    expect(names).toContain("CrowdStrikeNormalizationDCR.json");
    // The non-JSON file is filtered out.
    expect(names).not.toContain("readme.md");
    // At least the three DCR/connector JSONs (>=3, mirroring the legacy assert).
    expect(files.filter((f) => f.name.toLowerCase().endsWith(".json")).length).toBeGreaterThanOrEqual(3);
  });

  it("the custom DCR is discovered at its nested 'Data Collection Rules' path", async () => {
    const files = await content.listConnectorFiles(CS);
    const custom = files.find((f) => f.name === "CrowdStrikeCustomDCR.json");
    expect(custom).toBeDefined();
    expect(custom?.path).toContain("Data Collection Rules");
    expect(custom?.path).toBe(`${NESTED}/CrowdStrikeCustomDCR.json`);
  });

  it("the discovered custom DCR reads back and decodes to 8 CrowdStrike streams", async () => {
    const files = await content.listConnectorFiles(CS);
    const custom = files.find((f) => f.name === "CrowdStrikeCustomDCR.json");
    const raw = await content.readFile(custom!.path);
    expect(raw).not.toBeNull();
    const decoded = decodeConnector(JSON.parse(raw as string), custom!.name);
    expect(decoded.tables).toHaveLength(8);
    expect(decoded.tables.map((t) => t.tableName)).toContain("CrowdstrikeProcess");
  });

  it("listSolutions returns the CrowdStrike and PaloAlto-PAN-OS solutions", async () => {
    const solutions = await content.listSolutions();
    const names = solutions.map((s) => s.name);
    expect(names.some((n) => n.toLowerCase().includes("crowdstrike"))).toBe(true);
    expect(names).toContain("PaloAlto-PAN-OS");
    // None of these are deprecated (no markers seeded).
    expect(solutions.every((s) => !s.deprecated)).toBe(true);
  });
});
