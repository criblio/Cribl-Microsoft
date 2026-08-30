import { describe, expect, it } from "vitest";
import {
  parseUstarTar,
  ungzipStored,
  type ParsedTarEntry,
} from "../../domain/pack-assembly";
import { buildSentinelDestination } from "../../domain/sentinel-destination";
import type { CollectedArmRequest } from "../onboard-batch";
import { AIR_GAP_ARM_TEMPLATE_PATH, buildAirGapArchive } from "./air-gap-export";

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
      AIR_GAP_ARM_TEMPLATE_PATH,
      "cribl-destinations/MS-Sentinel-CommonSecurityLog-dest.json",
      "README-deployment.md",
    ]);
    // DBT-33: ONE template for the run, not one file per collected request.
    // Two ARM entries would mean the per-resource layout came back.
    expect(
      archive.fileNames.filter((name) => name.startsWith("arm-templates/")),
    ).toHaveLength(1);
  });

  it("round-trips through Unit 19's ustar parser (raw tar)", () => {
    const entries = parseUstarTar(archive.tar);
    const files = entries.filter((e) => !e.isDir).map((e) => e.path).sort();
    expect(files).toEqual(
      [
        "README-deployment.md",
        AIR_GAP_ARM_TEMPLATE_PATH,
        "cribl-destinations/MS-Sentinel-CommonSecurityLog-dest.json",
        "paloalto-sentinel.crbl",
      ].sort(),
    );
  });

  it("ships a REAL ARM deployment template, not the bare REST body (DBT-33)", () => {
    const entries = parseUstarTar(ungzipStored(archive.archive));
    const arm = fileByPath(entries, AIR_GAP_ARM_TEMPLATE_PATH);
    expect(arm).toBeDefined();
    const template = JSON.parse(DECODER.decode(arm!.content)) as {
      $schema: string;
      contentVersion: string;
      resources: Array<Record<string, unknown>>;
    };

    // The envelope Portal and `az deployment group create` require. The old
    // artifact was ARM_REQUEST.body itself, which has none of these - so
    // asserting they are present is exactly the regression guard.
    expect(template.$schema).toContain("deploymentTemplate.json#");
    expect(template.contentVersion).toBe("1.0.0.0");
    expect(template.resources).toHaveLength(1);

    // The resource carries the collected body plus the type/name/apiVersion
    // ARM needs, which the body alone never had.
    expect(template.resources[0]).toEqual({
      type: "Microsoft.Insights/dataCollectionRules",
      apiVersion: "2023-03-11",
      name: "dcr-CommonSecurityLog-eastus",
      location: "eastus",
      properties: { dataFlows: [] },
    });
  });

  it("reports the one scope the template must be deployed to", () => {
    expect(archive.arm).toEqual({
      subscriptionId: "s",
      resourceGroup: "rg",
      scopeConflicts: [],
      unparseable: [],
      resourceCount: 1,
    });
  });

  it("README names that scope in a runnable command, not a generic instruction", () => {
    expect(archive.readme).toContain("--subscription s");
    expect(archive.readme).toContain("--resource-group rg");
    expect(archive.readme).toContain(`--template-file ${AIR_GAP_ARM_TEMPLATE_PATH}`);
    // The defect DBT-33 filed: the old README pointed Portal and
    // `az deployment group create` at files that were not templates. The
    // commands may stay only because the artifact is now a template.
    expect(archive.readme).toContain("Deploy a custom template");
    expect(archive.readme).not.toContain("Deploy ARM templates from `arm-templates/`");
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
    // No collected requests means NO template file - an empty resources[]
    // would be a template the README told the operator to deploy for nothing.
    expect(noCrbl.arm.resourceCount).toBe(0);
    expect(noCrbl.readme).toContain("No Azure resources were collected");
    expect(noCrbl.readme).not.toContain("az deployment group create");
  });

  it("surfaces a cross-resource-group request instead of shipping it silently", () => {
    const elsewhere: CollectedArmRequest = {
      ...ARM_REQUEST,
      artifactName: "dcr-Other-westus.json",
      path: "/subscriptions/s/resourceGroups/other-rg/providers/Microsoft.Insights/dataCollectionRules/dcr-Other-westus",
    };
    const split = buildAirGapArchive({
      solutionName: "V",
      packName: "v-sentinel",
      armRequests: [ARM_REQUEST, elsewhere],
      destinations: [],
      mtimeSec: 1,
    });
    expect(split.arm.scopeConflicts).toEqual([elsewhere.path]);
    expect(split.arm.resourceCount).toBe(1);
  });
});
