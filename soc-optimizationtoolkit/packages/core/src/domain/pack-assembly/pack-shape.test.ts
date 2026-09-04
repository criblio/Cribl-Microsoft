/**
 * Pins for the two PACK SHAPES (GEN-13).
 *
 * THE DEFECT THESE COME FROM, reported by a user and then verified in the live
 * Cribl UI: a pack this app built installed into the worker group but could NOT
 * be selected from the Routes page pipeline dropdown. Filtering that dropdown
 * for "sentinel" returned exactly one entry, and it was somebody else's pack.
 *
 * The cause was found by diffing against a known-good pack the user supplied
 * (HelloPacks_1.0.0.crbl) and is EXACTLY TWO FILES:
 *   - every route carried `output: <destinationId>` where HelloPacks carries
 *     `output: default`
 *   - the pack shipped `default/outputs.yml`, which HelloPacks has no
 *     equivalent of
 * WHICH OF THE TWO IS THE GATE was established live on 2026-09-04 by the
 * operator, and it is NOT what this header first said. Setting the pack route's
 * destination to Cribl's own "Send to Worker Group Routes" - the UI form of
 * `output: default` - did NOT make the pack appear. Deleting the destination
 * from the pack DID, immediately. So outputs.yml is the gate and the route
 * output is its companion: without it a routable pack's routes would name a
 * destination the pack no longer ships.
 *
 * WHY THESE PINS ASSERT BOTH FILES TOGETHER. Either one alone produces a
 * BROKEN pack rather than a different one: routes that hand events back while
 * the pack still ships a configured Sentinel destination leave an output
 * nothing routes to, carrying a secret reference the group may not resolve; and
 * a pack with no outputs.yml whose routes still name a destination points at
 * something that does not exist. They are one decision expressed in two places,
 * and the pins refuse to let them drift apart.
 */

import { describe, expect, it } from "vitest";
import type { PipelinePlan } from "../pipeline-generation/models";
import { generateRouteYml } from "../pipeline-generation/route-yml";

/**
 * A plan with one table, built inline rather than through the planner: these
 * pins are about how a SHAPE is rendered, and a planner change should not be
 * able to make them pass or fail for an unrelated reason.
 */
function planWith(shape?: PipelinePlan["packShape"]): PipelinePlan {
  return {
    solutionName: "AWS VPC Flow Logs",
    packName: "ms-sentinel-aws-vpc",
    version: "1.0.0",
    vendorPrefix: "aws",
    tables: [
      {
        suffix: "AWSVPCFlow",
        pipelineName: "AWS_VPC_vpcflow",
        reductionPipelineId: "AWS_VPC_vpcflow_reduction",
        destinationId: "sentinel:MS-AWSVPCFlow",
        routeCondition: "true",
        reductionRules: null,
        fields: [],
      },
    ],
    ...(shape !== undefined ? { packShape: shape } : {}),
  } as unknown as PipelinePlan;
}

describe("the route output follows the pack shape", () => {
  it("names the destination for an ALL-INCLUSIVE pack, which is the default", () => {
    // Omitted shape must behave exactly as before the option existed - every
    // pack built until 2026-09-04 was this, and every stored build record
    // replays as this.
    const yml = generateRouteYml(planWith());
    expect(yml).toContain("output: sentinel:MS-AWSVPCFlow");
    expect(yml).not.toContain("output: default");
  });

  it("is unchanged when all-inclusive is stated explicitly", () => {
    // The explicit value and the omitted one must not diverge, or a stored
    // choice would render differently from the default it was meant to match.
    expect(generateRouteYml(planWith("all-inclusive"))).toBe(
      generateRouteYml(planWith()),
    );
  });

  it("hands events BACK for a ROUTABLE pack, so no route names a dropped destination", () => {
    // NOT what earns the dropdown entry - see the header. This is the companion
    // to omitting outputs.yml: with the destination gone, a route still naming
    // it would dangle. Asserted as the exact string HelloPacks uses, because a
    // pin merely checking the output "changed" would pass for any value.
    const yml = generateRouteYml(planWith("routable"));
    expect(yml).toContain("output: default");
    expect(yml).not.toContain("output: sentinel:MS-AWSVPCFlow");
  });

  it("applies the shape to EVERY route, not just the first", () => {
    // A pack emits a reduction route and a transform route per log type, and a
    // single-route fixture would pass with the second still hard-coded. This is
    // the assertion that catches a half-applied change.
    const plan = planWith("routable");
    const yml = generateRouteYml(plan);
    const outputs = yml.match(/output: \S+/g) ?? [];
    expect(outputs.length).toBeGreaterThan(0);
    expect(outputs.every((o) => o === "output: default")).toBe(true);
  });
});
