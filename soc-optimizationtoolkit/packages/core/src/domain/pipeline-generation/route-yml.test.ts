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
import { generateRouteYml, unreachableLogTypes, placeholderLogTypes } from "./route-yml";
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

/**
 * RE-PINNED 2026-08-13. These pin the EMITTER's handling of match-all routes.
 * The PLANNER no longer produces one for a multi-log-type pack - an
 * undiscriminable log type now gets a placeholder filter - so the inputs are
 * forced back to match-all rather than the pins being deleted. The emitter
 * still meets plans built by hand or by an older caller, and the ordering it
 * guards (a final match-all first makes every later route unreachable) is the
 * original 2026-07-13 defect.
 */
describe("multi-log-type route order (live flaw 2026-07-13)", () => {
  /** Force a table back to match-all, simulating a non-planner-built plan. */
  function forceMatchAll(
    plan: ReturnType<typeof buildPipelinePlan>,
    suffixes: string[],
  ): ReturnType<typeof buildPipelinePlan> {
    for (const t of plan.tables) {
      if (suffixes.includes(t.suffix)) t.routeCondition = "true";
    }
    return plan;
  }

  it("the planner no longer leaves an undiscriminable log type as match-all", () => {
    // Why the pins below need a forced plan - and the behaviour that replaced
    // the defect they were written for.
    const plan = buildPipelinePlan({
      solutionName: "Zscaler Internet",
      packName: "zia",
      tables: [
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
    expect(plan.tables.some((t) => t.routeCondition === "true")).toBe(false);
    expect(placeholderLogTypes(plan)).toEqual(["generic"]);
  });

  it("emits discriminated pairs FIRST and the match-all pair LAST", () => {
    const plan = forceMatchAll(
      buildPipelinePlan({
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
      }),
      ["generic"],
    );
    const yaml = generateRouteYml(plan);
    const fwAt = yaml.indexOf("sourcetype == 'zscalernss-fw'");
    const allAt = yaml.indexOf('filter: "true"');
    expect(fwAt).toBeGreaterThan(-1);
    expect(allAt).toBeGreaterThan(fwAt);
    expect(yaml).not.toContain("WARNING");
  });

  it("calls overlapping match-alls a GENERATOR BUG in the header", () => {
    // RE-PINNED 2026-08-17 (architecture audit finding 3), from
    // "WARNING: 2 log types". Not a wording tidy - the meaning changed.
    //
    // When this pin was written, overlapping match-alls were the NORMAL
    // outcome for log types the derivation could not separate, so the header
    // asked the operator to edit the filters. The placeholder ladder has since
    // taken that job: an unseparable log type gets a filter matching NOTHING
    // instead of one matching EVERYTHING. This state is therefore no longer
    // reachable from buildPipelinePlan at all - note the forceMatchAll helper
    // below, which exists to construct a plan the planner will not produce.
    //
    // So reaching it means the ladder regressed, and telling the operator to
    // go edit filters would send them to fix something they did not cause.
    // The header now says the pack should not ship and should be reported.
    const plan = forceMatchAll(
      buildPipelinePlan({
        solutionName: "Acme",
        packName: "acme",
        tables: [
          { sentinelTable: "A_CL", logType: "a", reductionRules: null },
          { sentinelTable: "B_CL", logType: "b", reductionRules: null },
        ],
      }),
      ["a", "b"],
    );
    const yaml = generateRouteYml(plan);
    expect(yaml).toContain("GENERATOR BUG: 2 log types");
    // It must not read as routine operator work any more.
    expect(yaml).not.toContain("Edit the");
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
  /**
   * RE-PINNED 2026-08-13: `.map` forces match-all because the planner now
   * hands these log types placeholder filters instead. unreachableLogTypes
   * remains the guard against a plan that DOES carry overlapping match-alls,
   * so it is still pinned - against an input that can produce them.
   */
  function sameSchemaPlan(logTypes: string[]) {
    const plan = buildPipelinePlan({
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
    for (const t of plan.tables) t.routeCondition = "true";
    return plan;
  }

  it("reports every match-all AFTER the first", () => {
    // Five identical schemas: one catch-all is legitimate, four are dead.
    const plan = sameSchemaPlan(["ALLOWED", "BLOCKED", "CAUTIONED", "OUTOFRANGE", "firewall"]);
    expect(unreachableLogTypes(plan)).toHaveLength(4);
  });

  it("the planner PREVENTS this shape now - placeholders, not match-alls", () => {
    // The pins above force match-all; this is what the planner actually emits.
    const real = buildPipelinePlan({
      solutionName: "Vendor Solution",
      packName: "vendor-sentinel",
      tables: ["ALLOWED", "BLOCKED", "CAUTIONED"].map((logType) => ({
        sentinelTable: "CommonSecurityLog",
        logType,
        sourceFormat: "cef" as const,
        presetFields: [
          { source: "src", target: "SourceIP", type: "string", action: "rename" as const },
        ],
      })),
    });
    expect(unreachableLogTypes(real)).toEqual([]);
    expect(placeholderLogTypes(real)).toHaveLength(3);
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

  it("WITHOUT values, every log type gets a placeholder awaiting a filter", () => {
    // RE-PINNED 2026-08-13. This asserted the shipped defect: four of five
    // routes dead behind a match-all. Undiscriminable log types now get
    // placeholder filters instead, so nothing is dead and nothing is caught by
    // the wrong pipeline - the work is simply visible and outstanding.
    const plan = zscalerLike(false);
    expect(unreachableLogTypes(plan)).toEqual([]);
    expect(placeholderLogTypes(plan)).toHaveLength(LOG_TYPES.length);
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

/**
 * The warning and the emitted file must name the SAME surviving catch-all.
 *
 * unreachableLogTypes and generateRouteYml both have to decide which match-all
 * lives. They used to compute that separately - one from plan order, one from
 * a sorted copy - and agreed only because the sort is stable. Architecture
 * audit 2026-08-12 made them read one sequence; this pins the consequence, so
 * a future reorder cannot make the app name one log type as dead while the
 * pack kills a different one.
 */
describe("unreachableLogTypes agrees with the emitted order", () => {
  /** A match-all deliberately FIRST in plan order, discriminated after it. */
  function matchAllFirst() {
    const plan = buildPipelinePlan({
      solutionName: "Vendor",
      packName: "vendor-sentinel",
      tables: [
        {
          sentinelTable: "CommonSecurityLog",
          logType: "catchall",
          sourceFormat: "cef" as const,
          presetFields: [
            { source: "shared", target: "SourceIP", type: "string", action: "rename" as const },
          ],
        },
        {
          sentinelTable: "CommonSecurityLog",
          logType: "alsoCatchall",
          sourceFormat: "cef" as const,
          presetFields: [
            { source: "shared", target: "SourceIP", type: "string", action: "rename" as const },
          ],
        },
        {
          sentinelTable: "CommonSecurityLog",
          logType: "distinct",
          sourceFormat: "cef" as const,
          presetFields: [
            { source: "onlyHere", target: "DestinationIP", type: "string", action: "rename" as const },
          ],
        },
      ],
    });
    // RE-PINNED 2026-08-13: the planner now placeholders the two indistinct
    // log types. The agreement being guarded - that the warning names the log
    // type the emitted file actually starves - only has meaning for a plan
    // that CARRIES match-alls, so they are forced back on here.
    for (const t of plan.tables) {
      if (t.suffix !== "distinct") t.routeCondition = "true";
    }
    return plan;
  }

  it("names the log type the emitted file actually starves", () => {
    const plan = matchAllFirst();
    const dead = unreachableLogTypes(plan);
    const yaml = generateRouteYml(plan);

    // Exactly one match-all survives, so exactly one is reported dead.
    expect(dead).toHaveLength(1);

    // The survivor is whichever match-all route the file emits FIRST, and the
    // reported one must not be it.
    const order = ["catchall", "alsoCatchall"].map((s) => ({
      suffix: s,
      at: yaml.indexOf(`Reduction + Transform: ${s}`),
    }));
    order.sort((a, b) => a.at - b.at);
    expect(dead).not.toContain(order[0].suffix);
    expect(dead).toContain(order[1].suffix);
  });

  it("puts the discriminated route ahead of both match-alls", () => {
    const yaml = generateRouteYml(matchAllFirst());
    expect(yaml.indexOf("Transform: distinct")).toBeLessThan(
      yaml.indexOf("Reduction + Transform: catchall"),
    );
  });
});

/**
 * Placeholder filters for undiscriminable log types (user request 2026-08-13).
 *
 * firewall and DNS are the log types a SOC most needs a path for, and on the
 * Zscaler corpus nothing separates them. The three options were: match-all
 * (hijacks siblings' events through the wrong pipeline - the shipped defect),
 * drop them (silent loss of a critical path), or a placeholder filter that
 * cannot match until someone writes one. These pin the third.
 *
 * The dangerous pin here is the LAST one: placeholdering a single-log-type
 * pack would leave it routing nothing at all, turning this fix into a worse
 * regression than the bug.
 */
describe("placeholder route filters", () => {
  function plan(logTypes: string[], sharedField = "shared") {
    return buildPipelinePlan({
      solutionName: "Vendor",
      packName: "vendor-sentinel",
      tables: logTypes.map((logType) => ({
        sentinelTable: "CommonSecurityLog",
        logType,
        sourceFormat: "cef" as const,
        presetFields: [
          { source: sharedField, target: "SourceIP", type: "string", action: "rename" as const },
        ],
      })),
    });
  }

  it("names every undiscriminable log type", () => {
    expect(placeholderLogTypes(plan(["firewall", "dns", "web"])).sort()).toEqual(
      ["dns", "firewall", "web"],
    );
  });

  it("emits a filter that CANNOT match, so it never steals a sibling's events", () => {
    // The whole failure being fixed is one route consuming another's traffic.
    // A placeholder that matched anything would be worse than the match-all.
    const conditions = plan(["firewall", "dns"]).tables.map((t) => t.routeCondition);
    for (const cond of conditions) {
      expect(cond).toContain("__UNSET__");
      // eslint-disable-next-line no-new-func
      expect(new Function(`const __UNSET__ = undefined; return (${cond});`)()).toBe(false);
    }
  });

  it("names the log type in the filter, so the operator knows what to write", () => {
    const dns = plan(["firewall", "dns"]).tables.find((t) => t.suffix === "dns");
    expect(dns?.routeCondition).toContain("dns");
  });

  it("emits NO match-all when it placeholders - nothing is silently caught", () => {
    const p = plan(["firewall", "dns", "web"]);
    expect(p.tables.some((t) => t.routeCondition === "true")).toBe(false);
    expect(unreachableLogTypes(p)).toEqual([]);
  });

  it("still emits the full route pair and pipeline for a placeholdered type", () => {
    // The point of a placeholder over dropping the log type: everything is
    // present and starts working the moment the filter is written.
    const yaml = generateRouteYml(plan(["firewall", "dns"]));
    expect(yaml).toContain("Reduction + Transform: firewall");
    expect(yaml).toContain("Transform: firewall");
    expect(yaml).toContain("pipeline: Reduction_Vendor_firewall");
  });

  it("tells the operator what to do, in route.yml itself", () => {
    const yaml = generateRouteYml(plan(["firewall", "dns"]));
    expect(yaml).toContain("ACTION REQUIRED");
    expect(yaml).toContain("firewall");
  });

  it("LEAVES a single-log-type pack on match-all", () => {
    // Nothing to shadow, so `true` is correct. Placeholdering here would stop
    // a working single-table pack (Cloudflare et al) routing anything at all -
    // a far worse regression than the bug this fixes.
    const solo = plan(["onlyOne"]);
    expect(solo.tables[0].routeCondition).toBe("true");
    expect(placeholderLogTypes(solo)).toEqual([]);
  });

  it("does not placeholder log types that ARE discriminable", () => {
    const mixed = buildPipelinePlan({
      solutionName: "Vendor",
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
    expect(placeholderLogTypes(mixed)).toEqual([]);
  });

  it("keeps the emitted YAML acceptable to Cribl", () => {
    expect(checkCriblYaml(generateRouteYml(plan(["firewall", "dns"])), "route.yml")).toEqual([]);
  });
});
