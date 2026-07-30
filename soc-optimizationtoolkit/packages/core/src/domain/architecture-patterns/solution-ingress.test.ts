/**
 * solution-ingress pins: the tier-first archetype mapping (shipped kinds
 * include junk strings), factory well-formedness mirroring the catalog
 * integrity bars, backbone merge behavior, dual-path honesty, and the
 * recommendWithSolutions contract.
 */

import { describe, expect, it } from "vitest";

import {
  ARCHITECTURE_PATTERNS,
  diagramNodeInfo,
  recommendPatterns,
  unifyPatternDiagrams,
} from "./architecture-patterns";
import {
  recommendWithSolutions,
  solutionIngressArchetype,
  solutionIngressPattern,
} from "./solution-ingress";
import type { SolutionIngestion } from "../sentinel-content";
import { CCF_PULL_KINDS } from "../sentinel-content";

const PUSH: SolutionIngestion = { tier: "recommended", kind: "Push" };
const PULL: SolutionIngestion = { tier: "supported", kind: "RestApiPoller" };
const LEGACY: SolutionIngestion = { tier: "legacy", kind: "" };

describe("solutionIngressArchetype", () => {
  it("maps Push/recommended to the plain Cribl push topology", () => {
    expect(solutionIngressArchetype("Push", "recommended")).toBe(
      "push-logs-ingestion",
    );
  });

  it("maps every CCF pull kind (case-insensitive) to pull-native", () => {
    for (const kind of CCF_PULL_KINDS) {
      expect(solutionIngressArchetype(kind, "supported")).toBe("pull-native");
      expect(solutionIngressArchetype(kind.toLowerCase(), "supported")).toBe(
        "pull-native",
      );
    }
  });

  it("junk kinds on the supported tier still draw the push topology", () => {
    for (const junk of ["", "Linux", "StorageV2", "Customizable"]) {
      expect(solutionIngressArchetype(junk, "supported")).toBe(
        "push-logs-ingestion",
      );
    }
  });

  it("the legacy tier always draws the agent archetype, whatever the kind", () => {
    for (const kind of ["", "functionapp", "[if(variables('isReserved'),1,2)]"]) {
      expect(solutionIngressArchetype(kind, "legacy")).toBe("agent-legacy");
    }
  });
});

describe("solutionIngressPattern", () => {
  const factories: Array<[string, SolutionIngestion]> = [
    ["AbnormalSecurity", PUSH],
    ["1Password", PULL],
    ["Some Legacy Vendor", LEGACY],
  ];

  it("meets the catalog integrity bars for every archetype", () => {
    for (const [name, ingestion] of factories) {
      const pattern = solutionIngressPattern(name, ingestion);
      expect(pattern.id.startsWith("solution:")).toBe(true);
      expect(pattern.summary.length).toBeGreaterThan(20);
      expect(pattern.why.length).toBeGreaterThan(20);
      expect(pattern.considerations.length).toBeGreaterThanOrEqual(2);
      const nodeIds = new Set(pattern.diagram.nodes.map((n) => n.id));
      expect(nodeIds.size).toBe(pattern.diagram.nodes.length);
      expect(pattern.diagram.nodes.length).toBeGreaterThanOrEqual(3);
      for (const edge of pattern.diagram.edges) {
        expect(nodeIds.has(edge.from)).toBe(true);
        expect(nodeIds.has(edge.to)).toBe(true);
      }
      const source = pattern.diagram.nodes.find((n) => n.id === "src")!;
      expect(source.label).toBe(`${name} (solution)`);
      expect(source.tier).toBe("source");
    }
  });

  it("is deterministic", () => {
    expect(solutionIngressPattern("Okta", PUSH)).toEqual(
      solutionIngressPattern("Okta", PUSH),
    );
  });

  it("merges onto the catalog backbone (one Stream, one DCR, one workspace)", () => {
    const directDcr = ARCHITECTURE_PATTERNS.find((p) => p.id === "direct-dcr")!;
    const unified = unifyPatternDiagrams([
      directDcr,
      solutionIngressPattern("AbnormalSecurity", PUSH),
    ]);
    const labels = unified.nodes.map((n) => n.label);
    expect(labels.filter((l) => l === "Cribl Stream")).toHaveLength(1);
    expect(labels.filter((l) => l === "Kind:Direct DCR")).toHaveLength(1);
    expect(labels.filter((l) => l === "Log Analytics workspace")).toHaveLength(1);
    expect(labels).toContain("AbnormalSecurity (solution)");
  });

  it("pull-native draws BOTH the native pull path and the Cribl alternative", () => {
    const pattern = solutionIngressPattern("1Password", PULL);
    const labels = pattern.diagram.nodes.map((n) => n.label);
    expect(labels).toContain("Sentinel connector (pull)");
    expect(labels).toContain("Cribl Stream");
    expect(
      pattern.diagram.edges.some((e) => e.label === "native pull (RestApiPoller)"),
    ).toBe(true);
    expect(pattern.diagram.edges.some((e) => e.label === "Cribl alternative")).toBe(
      true,
    );
    expect(pattern.considerations.join(" ")).toContain("Run ONE path");
  });

  it("agent-legacy draws the native agent path and the _CL+alias alternative", () => {
    const pattern = solutionIngressPattern("Some Legacy Vendor", LEGACY);
    const labels = pattern.diagram.nodes.map((n) => n.label);
    expect(labels).toContain("Agent / Functions connector");
    expect(labels).toContain("Custom _CL + alias");
    expect(pattern.considerations.join(" ")).toContain("function alias");
  });

  it("every node label resolves diagramNodeInfo (the fallback covers sources)", () => {
    for (const [name, ingestion] of factories) {
      for (const node of solutionIngressPattern(name, ingestion).diagram.nodes) {
        expect(diagramNodeInfo(node.label), node.label).toBeDefined();
      }
    }
  });
});

describe("recommendWithSolutions", () => {
  it("a solution-only selection surfaces the dynamic pattern as a match", () => {
    const recs = recommendWithSolutions({
      products: [],
      resources: [],
      solutionSources: ["AbnormalSecurity"],
    });
    const match = recs.find((r) => r.pattern.id === "solution:abnormalsecurity");
    expect(match?.fit).toBe("match");
  });

  it("without solution sources it equals recommendPatterns", () => {
    const selection = {
      products: ["stream"],
      resources: ["sentinel"],
    } as const;
    expect(recommendWithSolutions(selection)).toEqual(recommendPatterns(selection));
  });

  it("unknown solution names fall back to the conservative agent drawing", () => {
    const recs = recommendWithSolutions({
      products: [],
      resources: [],
      solutionSources: ["Totally Unknown Vendor"],
    });
    const pattern = recs[0]?.pattern;
    expect(pattern?.diagram.nodes.map((n) => n.label)).toContain(
      "Agent / Functions connector",
    );
  });

  it("static catalog matches outrank the specificity-0 dynamic patterns", () => {
    const recs = recommendWithSolutions({
      products: ["stream"],
      resources: ["sentinel"],
      solutionSources: ["AbnormalSecurity"],
    });
    const matched = recs.filter((r) => r.fit === "match").map((r) => r.pattern.id);
    expect(matched).toContain("direct-dcr");
    expect(matched.indexOf("direct-dcr")).toBeLessThan(
      matched.indexOf("solution:abnormalsecurity"),
    );
  });
});
