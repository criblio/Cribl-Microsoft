/**
 * route.yml emission - Unit 17 (d).
 *
 * Pins the paired reduction/passthrough routes, the disable-swap, the filter-key
 * contract (re-pointing the legacy 'filter: not condition:' regression at the
 * REAL emitter), and the unified naming that fixes the route/pipeline
 * suffix-mismatch defect.
 */

import { describe, it, expect } from "vitest";
import { buildPipelinePlan } from "./plan";
import { generateRouteYml } from "./route-yml";
import { checkCriblYaml } from "./cribl-yaml-validator";
import type { TableRoutingInfo } from "../gap-analysis";

const routing = (routeCondition: string): TableRoutingInfo => ({
  tableName: "CommonSecurityLog",
  outputStream: "Custom-CommonSecurityLog",
  routeCondition,
  eventSimpleNames: [],
  columns: [],
  typeConversions: [],
});

describe("paired routes + disable-swap", () => {
  it("emits reduction (enabled) + passthrough (disabled) when rules exist", () => {
    const plan = buildPipelinePlan({
      solutionName: "PaloAlto PAN-OS",
      packName: "pa",
      tables: [
        {
          sentinelTable: "CommonSecurityLog",
          logType: "TRAFFIC",
          sourceFormat: "cef",
          routing: routing("sourcetype == 'pan:traffic'"),
        },
      ],
    });
    const yaml = generateRouteYml(plan);
    const suffix = plan.tables[0].suffix;
    const prefix = plan.vendorPrefix;

    expect(yaml).toContain(`- id: reduction_${prefix}_${suffix}`);
    expect(yaml).toContain(`- id: route_${prefix}_${suffix}`);
    // Reduction route enabled, passthrough disabled (the swap).
    const redBlock = yaml.slice(yaml.indexOf(`reduction_${prefix}_${suffix}`));
    expect(redBlock).toContain("disabled: false");
    const passBlock = yaml.slice(yaml.indexOf(`route_${prefix}_${suffix}`));
    expect(passBlock).toContain("disabled: true");
  });

  it("emits ONLY a passthrough (enabled) when there are no rules", () => {
    const plan = buildPipelinePlan({
      solutionName: "Acme",
      packName: "acme",
      tables: [{ sentinelTable: "Acme_CL", reductionRules: null }],
    });
    const yaml = generateRouteYml(plan);
    expect(yaml).not.toContain("- id: reduction_");
    expect(yaml).toContain("- id: route_");
    const passBlock = yaml.slice(yaml.indexOf("- id: route_"));
    expect(passBlock).toContain("disabled: false");
  });
});

describe("filter key contract (regression re-pointed at real code)", () => {
  it("route.yml uses filter: and never condition:", () => {
    const plan = buildPipelinePlan({
      solutionName: "PaloAlto PAN-OS",
      packName: "pa",
      tables: [
        {
          sentinelTable: "CommonSecurityLog",
          logType: "TRAFFIC",
          routing: routing("sourcetype == 'pan:traffic'"),
        },
      ],
    });
    const yaml = generateRouteYml(plan);
    expect(yaml).toContain(`filter: "sourcetype == 'pan:traffic'"`);
    expect(yaml).not.toContain("condition:");
    // And the core validator agrees (route detection is content-based).
    expect(checkCriblYaml(yaml, "route.yml")).toEqual([]);
  });

  it("match-all routes emit filter: \"true\" (quoted)", () => {
    const plan = buildPipelinePlan({
      solutionName: "Acme",
      packName: "acme",
      tables: [{ sentinelTable: "Acme_CL", reductionRules: null }],
    });
    const yaml = generateRouteYml(plan);
    expect(yaml).toContain('filter: "true"');
  });
});

describe("route pipeline references match the pipeline names (suffix-mismatch fix)", () => {
  it("even for a _CL table with a >25-char log type, route pipeline === plan pipeline", () => {
    const plan = buildPipelinePlan({
      solutionName: "Acme Solution",
      packName: "acme",
      tables: [
        {
          sentinelTable: "AcmeThing_CL",
          logType: "ThisIsAnExtremelyLongLogTypeNameWellOverTwentyFive",
          reductionRules: {
            keep: [],
            drop: [{ id: "d", description: "d", filter: "true", reason: "r" }],
            suppress: [],
          },
        },
      ],
    });
    const t = plan.tables[0];
    const yaml = generateRouteYml(plan);

    // The passthrough route's pipeline target is exactly the transformation
    // pipeline name...
    expect(yaml).toContain(`pipeline: ${t.pipelineName}`);
    // ...and the reduction route's pipeline target is exactly the reduction id.
    expect(yaml).toContain(`pipeline: ${t.reductionPipelineId}`);
    // Both are built from the SAME single suffix (the legacy defect had the
    // route use an uncapped/unstripped suffix that diverged from the dir).
    expect(t.pipelineName.endsWith(t.suffix)).toBe(true);
    expect(t.reductionPipelineId.endsWith(t.suffix)).toBe(true);
    expect(t.suffix.length).toBeLessThanOrEqual(25);
  });
});
