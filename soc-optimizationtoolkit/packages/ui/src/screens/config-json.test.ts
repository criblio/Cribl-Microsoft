import { describe, expect, it } from "vitest";
import { validateConfigJson } from "./config-json";

const FULL_CONFIG_JSON = JSON.stringify(
  {
    clientId: "client-1",
    tenantId: "tenant-1",
    subscriptionId: "sub-1",
    resourceGroup: "rg-1",
    workspaceName: "ws-1",
    setupPath: "lab-byo-rg",
  },
  null,
  2,
);

describe("validateConfigJson", () => {
  it("refuses empty and whitespace-only input", () => {
    for (const text of ["", "   ", "\n\t"]) {
      const result = validateConfigJson(text);
      expect(result.ok).toBe(false);
    }
  });

  it("refuses malformed JSON with a message naming the problem", () => {
    const result = validateConfigJson("{ not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Not valid JSON");
    }
  });

  it("refuses valid JSON that is not a plain object", () => {
    // The legacy editor accepted these and the tolerant codec would flatten
    // them to an empty config - a silent wipe. Here they refuse the save.
    for (const text of ["[]", "42", '"full"', "null", "true"]) {
      const result = validateConfigJson(text);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("JSON object");
      }
    }
  });

  it("round-trips a clean full config with no warnings", () => {
    const result = validateConfigJson(FULL_CONFIG_JSON);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config).toEqual({
        clientId: "client-1",
        tenantId: "tenant-1",
        subscriptionId: "sub-1",
        resourceGroup: "rg-1",
        workspaceName: "ws-1",
        setupPath: "lab-byo-rg",
      });
      expect(result.warnings).toEqual([]);
      expect(JSON.parse(result.normalizedJson)).toEqual(result.config);
    }
  });

  it("accepts a partial object, defaulting missing fields", () => {
    const result = validateConfigJson('{"tenantId":"t"}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.tenantId).toBe("t");
      expect(result.config.clientId).toBe("");
      expect(result.config.setupPath).toBe("existing");
      expect(result.warnings).toEqual([]);
    }
  });

  it("drops unknown keys with a warning and never lets a secret through", () => {
    const result = validateConfigJson(
      '{"tenantId":"t","clientSecret":"hunter2","extra":1}',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.some((w) => w.includes('"clientSecret"'))).toBe(
        true,
      );
      expect(result.warnings.some((w) => w.includes('"extra"'))).toBe(true);
      expect(result.normalizedJson).not.toContain("hunter2");
      expect(
        Object.prototype.hasOwnProperty.call(result.config, "clientSecret"),
      ).toBe(false);
    }
  });

  it("warns when a known field is not a string and resets it", () => {
    const result = validateConfigJson('{"subscriptionId":42}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.subscriptionId).toBe("");
      expect(
        result.warnings.some((w) => w.includes('"subscriptionId"')),
      ).toBe(true);
    }
  });

  it("warns when setupPath is invalid and falls back to existing", () => {
    const result = validateConfigJson('{"setupPath":"bogus"}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.setupPath).toBe("existing");
      expect(result.warnings.some((w) => w.includes('"setupPath"'))).toBe(
        true,
      );
    }
  });

  it("does not warn for a valid non-default setupPath", () => {
    const result = validateConfigJson('{"setupPath":"lab-new-rg"}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.setupPath).toBe("lab-new-rg");
      expect(result.warnings).toEqual([]);
    }
  });

  it("emits normalizedJson in canonical pretty-printed form", () => {
    const result = validateConfigJson('{"tenantId":"t","junk":true}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalizedJson).toBe(
        JSON.stringify(result.config, null, 2),
      );
      expect(result.normalizedJson).not.toContain("junk");
    }
  });
});
