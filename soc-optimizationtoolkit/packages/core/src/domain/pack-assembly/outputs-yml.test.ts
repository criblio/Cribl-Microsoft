import { describe, expect, it } from "vitest";

import { buildSentinelDestination } from "../sentinel-destination";
import { CRIBL_SECRET_REFERENCE, serializeSentinelOutputsYml } from "./outputs-yml";

function config() {
  return buildSentinelDestination({
    id: "MS-Sentinel-CommonSecurityLog-dest",
    dcrImmutableId: "dcr-abc123",
    ingestionEndpoint: "https://dce-xyz.eastus-1.ingest.monitor.azure.com",
    streamName: "Custom-CommonSecurityLog",
    tenantId: "tenant-1",
    ingestionClientId: "client-1",
  });
}

describe("serializeSentinelOutputsYml (section 3 contract 4)", () => {
  it("emits the destination under its id with the fixed tuning block", () => {
    const yml = serializeSentinelOutputsYml([config()]);
    expect(yml).toContain("outputs:");
    expect(yml).toContain("  MS-Sentinel-CommonSecurityLog-dest:");
    expect(yml).toContain("    keepAlive: true");
    expect(yml).toContain("    concurrency: 5");
    expect(yml).toContain("    maxPayloadSizeKB: 1000");
    expect(yml).toContain("    compress: true");
    expect(yml).toContain("    rejectUnauthorized: true");
    expect(yml).toContain("    timeoutSec: 30");
    expect(yml).toContain("    flushPeriodSec: 1");
    expect(yml).toContain("    onBackpressure: drop");
    expect(yml).toContain("    scope: https://monitor.azure.com/.default");
    expect(yml).toContain("    endpointURLConfiguration: ID");
    expect(yml).toContain("    type: sentinel");
  });

  it("single-quotes the client_id and uses the Cribl secret reference", () => {
    const yml = serializeSentinelOutputsYml([config()]);
    expect(yml).toContain("    client_id: 'client-1'");
    expect(yml).toContain(`    secret: "${CRIBL_SECRET_REFERENCE}"`);
    // Never emit a real secret placeholder into the pack outputs.
    expect(yml).not.toContain("<replace me>");
  });

  it("composes the ingestion url shape and quotes url/loginUrl", () => {
    const yml = serializeSentinelOutputsYml([config()]);
    expect(yml).toContain(
      '    url: "https://dce-xyz.eastus-1.ingest.monitor.azure.com/dataCollectionRules/dcr-abc123/streams/Custom-CommonSecurityLog?api-version=2021-11-01-preview"',
    );
    expect(yml).toContain('    loginUrl: "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token"');
  });

  it("renders empty arrays and the nested timeoutRetrySettings block", () => {
    const yml = serializeSentinelOutputsYml([config()]);
    expect(yml).toContain("    systemFields: []");
    expect(yml).toContain("    timeoutRetrySettings:");
    expect(yml).toContain("      timeoutRetry: false");
  });
});
