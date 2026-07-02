/**
 * Unit tests for the azure-config codec, organized by the contract each group
 * pins:
 *   - round-trip fidelity of the five non-secret fields
 *   - the TOLERANT/TOTAL parse rules (never throws; empty config for junk)
 *   - field-level coercion (non-string -> '', bogus setupPath -> 'existing')
 *   - the SECRET-EXCLUSION invariant: no clientSecret/accessToken ever leaks
 *     onto AzureConfig, and unknown keys are dropped
 *   - isAzureConfigComplete token vs. full-deployment readiness
 *
 * The secret-exclusion group is load-bearing: the client secret lives only in
 * the encrypted, write-only azureBasic entry, so a blob that plants a secret
 * must be parsed WITHOUT that key surfacing.
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_AZURE_CONFIG,
  isAzureConfigComplete,
  parseAzureConfig,
  serializeAzureConfig,
} from "./index";
import type { AzureConfig } from "./index";

/** A fully-populated, valid config for round-trip and completeness tests. */
const FULL_CONFIG: AzureConfig = {
  clientId: "11111111-1111-1111-1111-111111111111",
  tenantId: "22222222-2222-2222-2222-222222222222",
  subscriptionId: "33333333-3333-3333-3333-333333333333",
  resourceGroup: "rg-soc-lab",
  workspaceName: "law-soc-lab",
  setupPath: "lab-byo-rg",
};

describe("serializeAzureConfig / parseAzureConfig round-trip", () => {
  it("round-trips a fully-populated config to an equal object", () => {
    const parsed = parseAzureConfig(serializeAzureConfig(FULL_CONFIG));
    expect(parsed).toEqual(FULL_CONFIG);
  });

  it("round-trips the empty config", () => {
    const parsed = parseAzureConfig(serializeAzureConfig(EMPTY_AZURE_CONFIG));
    expect(parsed).toEqual(EMPTY_AZURE_CONFIG);
  });

  it("round-trips each valid setupPath value", () => {
    for (const setupPath of ["existing", "lab-new-rg", "lab-byo-rg"] as const) {
      const config: AzureConfig = { ...FULL_CONFIG, setupPath };
      expect(parseAzureConfig(serializeAzureConfig(config)).setupPath).toBe(
        setupPath,
      );
    }
  });

  it("serializes exactly the six known fields and nothing else", () => {
    const json = serializeAzureConfig(FULL_CONFIG);
    expect(Object.keys(JSON.parse(json)).sort()).toEqual([
      "clientId",
      "resourceGroup",
      "setupPath",
      "subscriptionId",
      "tenantId",
      "workspaceName",
    ]);
  });

  it("round-trips the workspaceName field", () => {
    const config: AzureConfig = { ...FULL_CONFIG, workspaceName: "law-prod" };
    expect(parseAzureConfig(serializeAzureConfig(config)).workspaceName).toBe(
      "law-prod",
    );
  });

  it("parses a stored config that predates workspaceName to ''", () => {
    // A blob written before workspaceName existed omits the key entirely.
    const legacy = JSON.stringify({
      clientId: FULL_CONFIG.clientId,
      tenantId: FULL_CONFIG.tenantId,
      subscriptionId: FULL_CONFIG.subscriptionId,
      resourceGroup: FULL_CONFIG.resourceGroup,
      setupPath: FULL_CONFIG.setupPath,
    });
    expect(parseAzureConfig(legacy).workspaceName).toBe("");
  });

  it("does not emit a stray secret even if one is attached to the input", () => {
    // Cast through unknown: a caller could hand us an object polluted with a
    // secret. serialize must still emit only the five canonical fields.
    const polluted = {
      ...FULL_CONFIG,
      clientSecret: "super-secret",
      accessToken: "ey.token",
    } as unknown as AzureConfig;
    const json = serializeAzureConfig(polluted);
    expect(json).not.toContain("super-secret");
    expect(json).not.toContain("ey.token");
    expect(json).not.toContain("clientSecret");
    expect(json).not.toContain("accessToken");
  });
});

describe("parseAzureConfig is tolerant and total (never throws)", () => {
  it("returns EMPTY_AZURE_CONFIG for null", () => {
    expect(parseAzureConfig(null)).toEqual(EMPTY_AZURE_CONFIG);
  });

  it("returns EMPTY_AZURE_CONFIG for undefined", () => {
    expect(parseAzureConfig(undefined)).toEqual(EMPTY_AZURE_CONFIG);
  });

  it("returns EMPTY_AZURE_CONFIG for the empty string", () => {
    expect(parseAzureConfig("")).toEqual(EMPTY_AZURE_CONFIG);
  });

  it("returns EMPTY_AZURE_CONFIG for a whitespace-only string", () => {
    expect(parseAzureConfig("   ")).toEqual(EMPTY_AZURE_CONFIG);
    expect(parseAzureConfig("\t\n ")).toEqual(EMPTY_AZURE_CONFIG);
  });

  it("returns EMPTY_AZURE_CONFIG for non-JSON text", () => {
    expect(parseAzureConfig("not json")).toEqual(EMPTY_AZURE_CONFIG);
  });

  it("returns EMPTY_AZURE_CONFIG for a JSON array", () => {
    expect(parseAzureConfig("[1,2]")).toEqual(EMPTY_AZURE_CONFIG);
  });

  it("returns EMPTY_AZURE_CONFIG for a JSON number", () => {
    expect(parseAzureConfig("42")).toEqual(EMPTY_AZURE_CONFIG);
  });

  it("returns EMPTY_AZURE_CONFIG for a JSON string literal", () => {
    expect(parseAzureConfig('"just a string"')).toEqual(EMPTY_AZURE_CONFIG);
  });

  it("returns EMPTY_AZURE_CONFIG for JSON null", () => {
    expect(parseAzureConfig("null")).toEqual(EMPTY_AZURE_CONFIG);
  });

  it("never returns a reference to the shared EMPTY_AZURE_CONFIG (no mutation risk)", () => {
    const parsed = parseAzureConfig(null);
    expect(parsed).not.toBe(EMPTY_AZURE_CONFIG);
    parsed.clientId = "mutated";
    expect(EMPTY_AZURE_CONFIG.clientId).toBe("");
  });
});

describe("parseAzureConfig field-level coercion", () => {
  it("falls back to 'existing' for a bogus setupPath", () => {
    const parsed = parseAzureConfig(
      JSON.stringify({ ...FULL_CONFIG, setupPath: "wat" }),
    );
    expect(parsed.setupPath).toBe("existing");
  });

  it("falls back to 'existing' when setupPath is a non-string", () => {
    expect(parseAzureConfig('{"setupPath":42}').setupPath).toBe("existing");
    expect(parseAzureConfig('{"setupPath":null}').setupPath).toBe("existing");
    expect(parseAzureConfig('{"setupPath":{}}').setupPath).toBe("existing");
  });

  it("coerces non-string fields (number/object/null/array/bool) to ''", () => {
    const parsed = parseAzureConfig(
      JSON.stringify({
        clientId: 123,
        tenantId: { nested: true },
        subscriptionId: null,
        resourceGroup: ["a"],
        workspaceName: false,
        setupPath: "existing",
      }),
    );
    expect(parsed).toEqual({
      clientId: "",
      tenantId: "",
      subscriptionId: "",
      resourceGroup: "",
      workspaceName: "",
      setupPath: "existing",
    });
  });

  it("keeps present string fields and defaults absent ones to ''", () => {
    const parsed = parseAzureConfig(
      JSON.stringify({ clientId: "abc", setupPath: "lab-new-rg" }),
    );
    expect(parsed).toEqual({
      clientId: "abc",
      tenantId: "",
      subscriptionId: "",
      resourceGroup: "",
      workspaceName: "",
      setupPath: "lab-new-rg",
    });
  });
});

describe("parseAzureConfig never surfaces secrets or unknown keys", () => {
  it("drops a planted clientSecret and accessToken", () => {
    const parsed = parseAzureConfig(
      JSON.stringify({
        ...FULL_CONFIG,
        clientSecret: "super-secret",
        accessToken: "ey.token",
      }),
    );
    expect(parsed).toEqual(FULL_CONFIG);
    expect(Object.keys(parsed)).not.toContain("clientSecret");
    expect(Object.keys(parsed)).not.toContain("accessToken");
    expect(JSON.stringify(parsed)).not.toContain("super-secret");
  });

  it("ignores arbitrary unknown extra keys", () => {
    const parsed = parseAzureConfig(
      JSON.stringify({ ...FULL_CONFIG, extra: "x", nested: { a: 1 } }),
    );
    expect(parsed).toEqual(FULL_CONFIG);
    expect(Object.keys(parsed).sort()).toEqual([
      "clientId",
      "resourceGroup",
      "setupPath",
      "subscriptionId",
      "tenantId",
      "workspaceName",
    ]);
  });
});

describe("isAzureConfigComplete", () => {
  it("token readiness needs only clientId + tenantId", () => {
    const config: AzureConfig = {
      ...EMPTY_AZURE_CONFIG,
      clientId: "c",
      tenantId: "t",
    };
    expect(isAzureConfigComplete(config)).toBe(true);
    expect(isAzureConfigComplete(config, true)).toBe(true);
  });

  it("token readiness is false when clientId or tenantId is missing", () => {
    expect(
      isAzureConfigComplete({ ...EMPTY_AZURE_CONFIG, clientId: "c" }),
    ).toBe(false);
    expect(
      isAzureConfigComplete({ ...EMPTY_AZURE_CONFIG, tenantId: "t" }),
    ).toBe(false);
    expect(isAzureConfigComplete(EMPTY_AZURE_CONFIG)).toBe(false);
  });

  it("full-deployment readiness additionally needs subscriptionId + resourceGroup", () => {
    const tokenOnly: AzureConfig = {
      ...EMPTY_AZURE_CONFIG,
      clientId: "c",
      tenantId: "t",
    };
    expect(isAzureConfigComplete(tokenOnly, false)).toBe(false);
    expect(isAzureConfigComplete(FULL_CONFIG, false)).toBe(true);
  });
});
