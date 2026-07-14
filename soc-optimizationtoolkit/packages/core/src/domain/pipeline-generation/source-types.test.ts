/**
 * source-types catalog + generateInputsYml - Unit 17 (e).
 *
 * Pins the merge order (static -> preset -> field defaults -> user), the
 * formatYamlValue quoting rules, the discovery-section guard, and
 * suggestSourceType - all ported verbatim from legacy source-types.ts.
 */

import { describe, it, expect } from "vitest";
import {
  SOURCE_TYPES,
  VENDOR_SOURCE_HINTS,
  suggestSourceType,
  generateInputsYml,
  formatYamlValue,
  type SourceConfig,
} from "./source-types";
import { checkCriblYaml } from "./cribl-yaml-validator";

describe("catalog shape", () => {
  it("registers the nine source types", () => {
    expect(Object.keys(SOURCE_TYPES).sort()).toEqual(
      [
        "azure_blob",
        "azure_event_hub",
        "http",
        "kafka",
        "office365",
        "rest_collector",
        "s3",
        "syslog",
        "windows_event",
      ].sort(),
    );
  });

  it("VENDOR_SOURCE_HINTS keys resolve to real source types", () => {
    for (const hint of Object.values(VENDOR_SOURCE_HINTS)) {
      expect(SOURCE_TYPES[hint.sourceType]).toBeDefined();
    }
  });
});

describe("suggestSourceType", () => {
  it("maps a vendor keyword to its source + preset", () => {
    expect(suggestSourceType("Cloudflare Logpush", "Cloudflare_CL")).toEqual({
      sourceType: "rest_collector",
      preset: "cloudflare",
    });
  });

  it("returns null for an unknown vendor", () => {
    expect(suggestSourceType("Totally Unknown Vendor", "Foo_CL")).toBeNull();
  });
});

describe("generateInputsYml merge order", () => {
  it("static -> preset -> field defaults -> user, with type first", () => {
    const config: SourceConfig = {
      sourceType: "syslog",
      vendorPreset: "paloalto",
      fields: { maxConnections: 2000 },
    };
    const yaml = generateInputsYml("in_paloalto", config);
    // Nesting.
    expect(yaml).toContain("inputs:");
    expect(yaml).toContain("  in_paloalto:");
    // type sorts first among the emitted keys.
    const typeIdx = yaml.indexOf("type: syslog");
    const portIdx = yaml.indexOf("port: 6514");
    expect(typeIdx).toBeGreaterThan(-1);
    expect(portIdx).toBeGreaterThan(typeIdx);
    // Preset overrode the field default (514 -> 6514).
    expect(yaml).toContain("port: 6514");
    expect(yaml).not.toContain("port: 514\n");
    // User field applied.
    expect(yaml).toContain("maxConnections: 2000");
  });

  it("unknown source type yields the placeholder stub", () => {
    const yaml = generateInputsYml("x", { sourceType: "nope", fields: {} });
    expect(yaml).toContain("# Unknown source type: nope");
    expect(yaml).toContain("inputs: {}");
  });
});

describe("discovery-section guard", () => {
  it("omits discovery when no discoveryFields are supplied", () => {
    const yaml = generateInputsYml("in", {
      sourceType: "rest_collector",
      vendorPreset: "cloudflare",
      fields: {},
    });
    expect(yaml).not.toContain("# Discovery configuration");
  });

  it("emits discovery when discoveryFields are supplied for a discovery type", () => {
    const yaml = generateInputsYml("in", {
      sourceType: "rest_collector",
      vendorPreset: "cloudflare",
      fields: {},
      discoveryFields: { discoverUrl: "https://api.example.com/list" },
    });
    expect(yaml).toContain("# Discovery configuration");
    expect(yaml).toContain("discoverUrl:");
  });
});

describe("formatYamlValue quoting", () => {
  it("quotes strings with special chars / placeholders", () => {
    expect(formatYamlValue("a:b")).toBe('"a:b"');
    expect(formatYamlValue("<YOUR-ID>")).toBe('"<YOUR-ID>"');
    expect(formatYamlValue("*/5 * * * *")).toBe('"*/5 * * * *"');
    expect(formatYamlValue("")).toBe('""');
    expect(formatYamlValue("true")).toBe('"true"');
  });

  it("leaves plain strings unquoted", () => {
    expect(formatYamlValue("tcp")).toBe("tcp");
  });

  it("renders scalars, empty arrays, and empty objects", () => {
    expect(formatYamlValue(true)).toBe("true");
    expect(formatYamlValue(514)).toBe("514");
    expect(formatYamlValue([])).toBe("[]");
    expect(formatYamlValue({})).toBe("{}");
  });
});

describe("generated inputs.yml passes the core validator", () => {
  it("has no tabs and no disallowed description constructs", () => {
    const yaml = generateInputsYml("in", {
      sourceType: "syslog",
      vendorPreset: "paloalto",
      fields: {},
    });
    expect(checkCriblYaml(yaml, "inputs.yml")).toEqual([]);
  });
});
