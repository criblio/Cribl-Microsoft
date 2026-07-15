/**
 * Pins for the Logs-Ingestion-fit classifier (2026-07-15): tier from CCF kind
 * or DCR/table structure, across the several connector root shapes (bare
 * object, ARRAY of ARM resources, template with resources[]), and the
 * best-tier solution aggregation. Real shapes taken from Azure-Sentinel:
 * Push = top-level {type: .../dataConnectors, kind: "Push"}; RestApiPoller
 * PollingConfig = an ARRAY of such resources carrying a dcrConfig.
 */

import { describe, expect, it } from "vitest";
import {
  classifyConnectorIngestion,
  classifySolutionIngestion,
  detectConnectorKinds,
} from "./ingestion-class";

describe("detectConnectorKinds", () => {
  it("reads the kind off a bare dataConnectors object (Push)", () => {
    expect(
      detectConnectorKinds({
        type: "Microsoft.SecurityInsights/dataConnectors",
        kind: "Push",
        properties: {},
      }),
    ).toEqual(["Push"]);
  });

  it("reads kinds from an ARRAY of ARM resources (PollingConfig)", () => {
    expect(
      detectConnectorKinds([
        {
          type: "Microsoft.SecurityInsights/dataConnectors",
          kind: "RestApiPoller",
          properties: {},
        },
      ]),
    ).toEqual(["RestApiPoller"]);
  });

  it("deduplicates repeated kinds", () => {
    const kinds = detectConnectorKinds([
      { type: "Microsoft.SecurityInsights/dataConnectors", kind: "RestApiPoller", properties: {} },
      { type: "Microsoft.SecurityInsights/dataConnectors", kind: "RestApiPoller", properties: {} },
    ]);
    expect(kinds).toEqual(["RestApiPoller"]);
  });
});

describe("classifyConnectorIngestion", () => {
  it("classifies a CCF Push connector as recommended", () => {
    const c = classifyConnectorIngestion({
      type: "Microsoft.SecurityInsights/dataConnectors",
      kind: "Push",
      properties: {},
    });
    expect(c.tier).toBe("recommended");
    expect(c.kind).toBe("Push");
  });

  it("classifies a CCF RestApiPoller (with dcrConfig) as supported", () => {
    const c = classifyConnectorIngestion([
      {
        type: "Microsoft.SecurityInsights/dataConnectors",
        kind: "RestApiPoller",
        properties: { dcrConfig: { streamName: "Custom-X_CL" } },
      },
    ]);
    expect(c.tier).toBe("supported");
    expect(c.kind).toBe("RestApiPoller");
  });

  it("classifies a connector that only declares a custom table as supported", () => {
    const c = classifyConnectorIngestion({
      title: "Legacy Function connector",
      tables: [{ name: "Vendor_CL", columns: [{ name: "TimeGenerated", type: "datetime" }] }],
    });
    expect(c.tier).toBe("supported");
    expect(c.kind).toBe("");
  });

  it("classifies a streamDeclarations DCR resource as supported", () => {
    const c = classifyConnectorIngestion({
      resources: [
        { properties: { streamDeclarations: { "Custom-X": { columns: [{ name: "a", type: "string" }] } } } },
      ],
    });
    expect(c.tier).toBe("supported");
  });

  it("classifies a name-only / agent connector as legacy", () => {
    const c = classifyConnectorIngestion({
      title: "Syslog",
      dataTypes: [{ name: "Syslog" }],
    });
    expect(c.tier).toBe("legacy");
  });
});

describe("classifySolutionIngestion", () => {
  it("takes the best tier across a solution's connectors", () => {
    const legacy = classifyConnectorIngestion({ dataTypes: [{ name: "T" }] });
    const push = classifyConnectorIngestion({
      type: "Microsoft.SecurityInsights/dataConnectors",
      kind: "Push",
      properties: {},
    });
    expect(classifySolutionIngestion([legacy, push]).tier).toBe("recommended");
    expect(classifySolutionIngestion([legacy]).tier).toBe("legacy");
  });

  it("treats a connector-less solution as legacy (no table to feed)", () => {
    expect(classifySolutionIngestion([]).tier).toBe("legacy");
  });
});
