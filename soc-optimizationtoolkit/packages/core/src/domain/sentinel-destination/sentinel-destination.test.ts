import { describe, expect, it } from "vitest";
import {
  buildSentinelDestination,
  defaultSentinelDestinationId,
  SentinelDestinationError,
  SENTINEL_SECRET_PLACEHOLDER,
} from "./sentinel-destination";

const INPUT = {
  id: "MS-Sentinel-SecurityEvent-dest",
  dcrImmutableId: "dcr-0123456789abcdef0123456789abcdef",
  ingestionEndpoint:
    "https://dcr-securityevent-eastus-a1b2.eastus-1.ingest.monitor.azure.com",
  streamName: "Custom-SecurityEvent",
  tenantId: "11111111-2222-3333-4444-555555555555",
  ingestionClientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
};

describe("buildSentinelDestination", () => {
  it("pins the exact OutputSentinel POST body for SecurityEvent (placeholder secret)", () => {
    expect(buildSentinelDestination(INPUT)).toEqual({
      id: "MS-Sentinel-SecurityEvent-dest",
      systemFields: [],
      streamtags: [],
      keepAlive: true,
      concurrency: 5,
      maxPayloadSizeKB: 1000,
      maxPayloadEvents: 0,
      compress: true,
      rejectUnauthorized: true,
      timeoutSec: 30,
      flushPeriodSec: 1,
      useRoundRobinDns: false,
      failedRequestLoggingMode: "none",
      safeHeaders: [],
      responseRetrySettings: [],
      timeoutRetrySettings: { timeoutRetry: false },
      responseHonorRetryAfterHeader: false,
      onBackpressure: "drop",
      authType: "oauth",
      scope: "https://monitor.azure.com/.default",
      endpointURLConfiguration: "ID",
      type: "sentinel",
      dceEndpoint:
        "https://dcr-securityevent-eastus-a1b2.eastus-1.ingest.monitor.azure.com",
      dcrID: "dcr-0123456789abcdef0123456789abcdef",
      streamName: "Custom-SecurityEvent",
      client_id: "'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'",
      secret: "<replace me>",
      loginUrl:
        "https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/oauth2/v2.0/token",
      url:
        "https://dcr-securityevent-eastus-a1b2.eastus-1.ingest.monitor.azure.com" +
        "/dataCollectionRules/dcr-0123456789abcdef0123456789abcdef" +
        "/streams/Custom-SecurityEvent?api-version=2021-11-01-preview",
    });
  });

  it("passes a provided secret through verbatim (TRANSIENT input, never read from KV)", () => {
    const config = buildSentinelDestination({
      ...INPUT,
      ingestionClientSecret: "s3cr3t-value",
    });
    expect(config.secret).toBe("s3cr3t-value");
  });

  it("ships the legacy placeholder when the secret is absent, null, or empty", () => {
    expect(buildSentinelDestination(INPUT).secret).toBe(
      SENTINEL_SECRET_PLACEHOLDER,
    );
    expect(
      buildSentinelDestination({ ...INPUT, ingestionClientSecret: null }).secret,
    ).toBe(SENTINEL_SECRET_PLACEHOLDER);
    expect(
      buildSentinelDestination({ ...INPUT, ingestionClientSecret: "" }).secret,
    ).toBe(SENTINEL_SECRET_PLACEHOLDER);
  });

  it("keeps dceEndpoint as the full URL but composes url from just the host", () => {
    const config = buildSentinelDestination({
      ...INPUT,
      ingestionEndpoint:
        "https://dcr-x-1234.westus2-1.ingest.monitor.azure.com/",
    });
    expect(config.dceEndpoint).toBe(
      "https://dcr-x-1234.westus2-1.ingest.monitor.azure.com/",
    );
    expect(config.url).toBe(
      "https://dcr-x-1234.westus2-1.ingest.monitor.azure.com" +
        "/dataCollectionRules/dcr-0123456789abcdef0123456789abcdef" +
        "/streams/Custom-SecurityEvent?api-version=2021-11-01-preview",
    );
  });

  it("throws SentinelDestinationError on blank required fields", () => {
    expect(() => buildSentinelDestination({ ...INPUT, id: " " })).toThrow(
      SentinelDestinationError,
    );
    expect(() =>
      buildSentinelDestination({ ...INPUT, dcrImmutableId: "" }),
    ).toThrow(SentinelDestinationError);
    expect(() => buildSentinelDestination({ ...INPUT, tenantId: "" })).toThrow(
      SentinelDestinationError,
    );
    expect(() =>
      buildSentinelDestination({ ...INPUT, ingestionClientId: "" }),
    ).toThrow(SentinelDestinationError);
  });
});

describe("defaultSentinelDestinationId", () => {
  it("applies the legacy IDprefix/IDsuffix convention", () => {
    expect(defaultSentinelDestinationId("SecurityEvent")).toBe(
      "MS-Sentinel-SecurityEvent-dest",
    );
  });

  it("strips one trailing _CL (case-insensitive) and sanitizes non-alphanumerics", () => {
    expect(defaultSentinelDestinationId("CloudFlare_CL")).toBe(
      "MS-Sentinel-CloudFlare-dest",
    );
    expect(defaultSentinelDestinationId("My-App.v2_cl")).toBe(
      "MS-Sentinel-My_App_v2-dest",
    );
  });
});
