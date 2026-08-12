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
import { generateRouteYml, unreachableLogTypes } from "./route-yml";
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

describe("multi-log-type route order (live flaw 2026-07-13)", () => {
  it("emits discriminated pairs FIRST and the match-all pair LAST", () => {
    const plan = buildPipelinePlan({
      solutionName: "Zscaler Internet",
      packName: "zia",
      tables: [
        // The match-all table is declared FIRST - emission must reorder it
        // behind the discriminated one or the final match-all route makes
        // every later route unreachable.
        { sentinelTable: "CommonSecurityLog", logType: "generic", reductionRules: null },
        {
          sentinelTable: "CommonSecurityLog",
          logType: "firewall",
          sourceFormat: "cef",
          reductionRules: null,
          routing: routing("sourcetype == 'zscalernss-fw'"),
        },
      ],
    });
    const yaml = generateRouteYml(plan);
    const fwAt = yaml.indexOf("sourcetype == 'zscalernss-fw'");
    const allAt = yaml.indexOf('filter: "true"');
    expect(fwAt).toBeGreaterThan(-1);
    expect(allAt).toBeGreaterThan(fwAt);
    expect(yaml).not.toContain("WARNING");
  });

  it("warns in the header when several match-all pairs overlap", () => {
    const plan = buildPipelinePlan({
      solutionName: "Acme",
      packName: "acme",
      tables: [
        { sentinelTable: "A_CL", logType: "a", reductionRules: null },
        { sentinelTable: "B_CL", logType: "b", reductionRules: null },
      ],
    });
    // No sample fields -> no discriminators -> two overlapping match-alls.
    expect(generateRouteYml(plan)).toContain("WARNING: 2 log types");
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

/**
 * Unreachable match-all routes. Measured on the Zscaler Internet Access pack
 * (2026-08-12): ten log types, only two separable by field presence, so eight
 * became match-all - and because every route is `final: true`, seven of them
 * could never receive an event. Cribl's own UI flagged exactly those seven.
 *
 * The affected log types do not go unprocessed, which is what makes this
 * silent: they fall into the FIRST match-all's pipeline and get that log
 * type's renames, so the data lands mis-shaped rather than missing.
 *
 * Not a Zscaler bug. Field-presence discrimination fails for ANY vendor whose
 * log types share a schema and differ by field value, so these pins use a
 * shape, not a vendor.
 */
describe("unreachableLogTypes - overlapping match-all routes", () => {
  /** n log types that share one schema, so none can be told apart. */
  function sameSchemaPlan(logTypes: string[]) {
    return buildPipelinePlan({
      solutionName: "Vendor Solution",
      packName: "vendor-sentinel",
      tables: logTypes.map((logType) => ({
        sentinelTable: "CommonSecurityLog",
        logType,
        sourceFormat: "cef" as const,
        presetFields: [
          { source: "src", target: "SourceIP", type: "string", action: "rename" as const },
          { source: "dst", target: "DestinationIP", type: "string", action: "rename" as const },
        ],
      })),
    });
  }

  it("reports every match-all AFTER the first", () => {
    // Five identical schemas: one catch-all is legitimate, four are dead.
    const plan = sameSchemaPlan(["ALLOWED", "BLOCKED", "CAUTIONED", "OUTOFRANGE", "firewall"]);
    expect(unreachableLogTypes(plan)).toHaveLength(4);
  });

  it("says NOTHING when the log types are separable", () => {
    // Distinct fields per log type - the discriminator separates them, so no
    // route is match-all and there is nothing to warn about. A warning that
    // fires on healthy packs is the noise that gets the real one ignored.
    const plan = buildPipelinePlan({
      solutionName: "Vendor Solution",
      packName: "vendor-sentinel",
      tables: [
        {
          sentinelTable: "CommonSecurityLog",
          logType: "web",
          sourceFormat: "cef" as const,
          presetFields: [
            { source: "requestUrl", target: "RequestURL", type: "string", action: "rename" as const },
          ],
        },
        {
          sentinelTable: "CommonSecurityLog",
          logType: "tunnel",
          sourceFormat: "cef" as const,
          presetFields: [
            { source: "tunnelPackets", target: "SentBytes", type: "int", action: "rename" as const },
          ],
        },
      ],
    });
    expect(unreachableLogTypes(plan)).toEqual([]);
  });

  it("says nothing for a single log type", () => {
    expect(unreachableLogTypes(sameSchemaPlan(["firewall"]))).toEqual([]);
  });

  it("names the log types, so the operator can act on it", () => {
    // A count alone ("4 log types overlap") is not actionable - the operator
    // has to know WHICH filters to separate.
    const names = unreachableLogTypes(sameSchemaPlan(["a", "b", "c"]));
    expect(names.every((n) => typeof n === "string" && n.length > 0)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it("agrees with the route.yml the same plan emits", () => {
    // The warning and the emitted routing must not drift: if this says 4 are
    // dead, route.yml must carry 5 match-all filters (1 reachable + 4 dead)
    // per enabled route pair.
    const plan = sameSchemaPlan(["ALLOWED", "BLOCKED", "CAUTIONED", "OUTOFRANGE", "firewall"]);
    const yaml = generateRouteYml(plan);
    const matchAllRoutes = [...yaml.matchAll(/filter: "true"/g)].length;
    expect(matchAllRoutes).toBe((unreachableLogTypes(plan).length + 1) * 2);
  });
});

/**
 * End to end: sample VALUES turn the dead routes back on.
 *
 * The regression this closes was measured on the real pack - ten Zscaler log
 * types through one CommonSecurityLog schema, seven of them unreachable
 * because nothing but a field value told them apart. The unit pins for the
 * derivation live in route-value-discriminator.test.ts; this one pins the
 * thing the operator actually gets, which is the number of routes that can
 * receive events.
 */
describe("value discrimination revives unreachable routes", () => {
  const LOG_TYPES = ["ALLOWED", "BLOCKED", "CAUTIONED", "OUTOFRANGE", "firewall"];

  /** One shared schema; only `action` differs, exactly like the live corpus. */
  function zscalerLike(withValues: boolean) {
    return buildPipelinePlan({
      solutionName: "Zscaler Internet Access",
      packName: "ms-sentinel-zscaler-internet",
      tables: LOG_TYPES.map((logType) => ({
        sentinelTable: "CommonSecurityLog",
        logType,
        sourceFormat: "cef" as const,
        presetFields: [
          { source: "action", target: "DeviceAction", type: "string", action: "rename" as const },
          { source: "src", target: "SourceIP", type: "string", action: "rename" as const },
        ],
        ...(withValues
          ? {
              sampleFieldValues: {
                eventCount: 3,
                values: {
                  action: [logType, logType, logType],
                  src: ["10.0.0.1", "10.0.0.2", "10.0.0.3"],
                },
              },
            }
          : {}),
      })),
    });
  }

  it("WITHOUT values, four of five routes are dead - the shipped defect", () => {
    expect(unreachableLogTypes(zscalerLike(false))).toHaveLength(LOG_TYPES.length - 1);
  });

  it("WITH values, every log type can receive events", () => {
    expect(unreachableLogTypes(zscalerLike(true))).toEqual([]);
  });

  it("routes on the discriminating field, not on per-event data", () => {
    const yaml = generateRouteYml(zscalerLike(true));
    expect(yaml).toContain("action");
    // src separates these samples perfectly too, and must never be chosen.
    expect(yaml).not.toContain("SourceIP ===");
    expect(yaml).not.toContain("10.0.0.1");
  });

  it("gives every log type a DISTINCT filter", () => {
    const plan = zscalerLike(true);
    const filters = plan.tables.map((t) => t.routeCondition);
    expect(new Set(filters).size).toBe(LOG_TYPES.length);
    expect(filters).not.toContain("true");
  });

  it("still emits YAML the Cribl loader accepts", () => {
    // The filters now carry quotes and JS operators - the exact shape most
    // likely to break the emitter's escaping.
    expect(checkCriblYaml(generateRouteYml(zscalerLike(true)), "route.yml")).toEqual([]);
  });
});
