import { describe, expect, it } from "vitest";
import {
  parseUstarTar,
  ungzipStored,
  type ParsedTarEntry,
} from "../../domain/pack-assembly";
import { buildSentinelDestination } from "../../domain/sentinel-destination";
import type { CollectedArmRequest } from "../onboard-batch";
import { buildAirGapArchive } from "./air-gap-export";

const DECODER = new TextDecoder();

const ARM_REQUEST: CollectedArmRequest = {
  kind: "dcr",
  table: "CommonSecurityLog",
  artifactName: "dcr-CommonSecurityLog-eastus.json",
  method: "PUT",
  path: "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Insights/dataCollectionRules/dcr-CommonSecurityLog-eastus",
  apiVersion: "2023-03-11",
  body: { location: "eastus", properties: { dataFlows: [] } },
};

const DESTINATION = buildSentinelDestination({
  id: "MS-Sentinel-CommonSecurityLog-dest",
  dcrImmutableId: "dcr-abc123",
  ingestionEndpoint: "https://dce-x.eastus-1.ingest.monitor.azure.com",
  streamName: "Custom-CommonSecurityLog",
  tenantId: "11111111-2222-3333-4444-555555555555",
  ingestionClientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  // A REAL secret is supplied here to prove the exporter FORCES the placeholder.
  ingestionClientSecret: "real-transient-secret",
});

function fileByPath(entries: ParsedTarEntry[], path: string): ParsedTarEntry | undefined {
  return entries.find((entry) => entry.path === path && !entry.isDir);
}

describe("buildAirGapArchive", () => {
  const archive = buildAirGapArchive({
    solutionName: "Palo Alto Networks",
    packName: "paloalto-sentinel",
    crbl: new Uint8Array([0x1f, 0x8b, 1, 2, 3]),
    armRequests: [ARM_REQUEST],
    destinations: [DESTINATION],
    sourceId: "in_syslog",
    mtimeSec: 1_700_000_000,
  });

  it("assembles the full artifact set (crbl + ARM + destinations + README)", () => {
    expect(archive.fileNames).toEqual([
      "paloalto-sentinel.crbl",
      "arm-templates/dcr-CommonSecurityLog-eastus.json",
      "cribl-destinations/MS-Sentinel-CommonSecurityLog-dest.json",
      "README-deployment.md",
    ]);
  });

  it("round-trips through Unit 19's ustar parser (raw tar)", () => {
    const entries = parseUstarTar(archive.tar);
    const files = entries.filter((e) => !e.isDir).map((e) => e.path).sort();
    expect(files).toEqual(
      [
        "README-deployment.md",
        "arm-templates/dcr-CommonSecurityLog-eastus.json",
        "cribl-destinations/MS-Sentinel-CommonSecurityLog-dest.json",
        "paloalto-sentinel.crbl",
      ].sort(),
    );
  });

  it("round-trips through gunzip + Unit 19 parser (the delivered archive)", () => {
    const entries = parseUstarTar(ungzipStored(archive.archive));
    const arm = fileByPath(entries, "arm-templates/dcr-CommonSecurityLog-eastus.json");
    expect(arm).toBeDefined();
    expect(JSON.parse(DECODER.decode(arm!.content))).toEqual(ARM_REQUEST.body);
  });

  it("AIR-GAP secret path: destination JSON always ships `<replace me>`, never a real secret", () => {
    const entries = parseUstarTar(archive.tar);
    const dest = fileByPath(
      entries,
      "cribl-destinations/MS-Sentinel-CommonSecurityLog-dest.json",
    );
    const parsed = JSON.parse(DECODER.decode(dest!.content)) as { secret: string };
    expect(parsed.secret).toBe("<replace me>");
    // The transient secret must NEVER leak into an air-gap artifact.
    expect(DECODER.decode(dest!.content)).not.toContain("real-transient-secret");
    expect(DECODER.decode(dest!.content)).not.toContain("!{sentinel_client_secret}");
  });

  it("generates an ASCII README naming the pack, filter, and pipeline", () => {
    expect(archive.readme).toContain("# Palo Alto Networks - Deployment Artifacts");
    expect(archive.readme).toContain("Import `paloalto-sentinel.crbl`");
    expect(archive.readme).toContain("Filter: `__inputId=='in_syslog'`");
    expect(archive.readme).toContain("Pipeline: `pack:paloalto-sentinel`");
  });

  it("is byte-deterministic for the same input + mtime", () => {
    const again = buildAirGapArchive({
      solutionName: "Palo Alto Networks",
      packName: "paloalto-sentinel",
      crbl: new Uint8Array([0x1f, 0x8b, 1, 2, 3]),
      armRequests: [ARM_REQUEST],
      destinations: [DESTINATION],
      sourceId: "in_syslog",
      mtimeSec: 1_700_000_000,
    });
    expect(Array.from(again.archive)).toEqual(Array.from(archive.archive));
  });

  it("omits the crbl entry when no pack bytes are supplied", () => {
    const noCrbl = buildAirGapArchive({
      solutionName: "V",
      packName: "v-sentinel",
      armRequests: [],
      destinations: [],
      mtimeSec: 1,
    });
    expect(noCrbl.fileNames).toEqual(["README-deployment.md"]);
  });
});
