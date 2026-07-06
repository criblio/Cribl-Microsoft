import { describe, expect, it } from "vitest";
import {
  planSourceWiring,
  prependRoutes,
  type RouteEntry,
} from "./source-wiring";

const BASE = {
  sourceId: "in_syslog_paloalto",
  packName: "paloalto-sentinel",
  workerGroups: ["wg-1", "wg-2"],
};

describe("planSourceWiring - ROUTE ORDER SEMANTICS (a regression silently drops data)", () => {
  it("no Lake: a single Sentinel route, final:true, at position 0", () => {
    const plan = planSourceWiring(BASE);
    expect(plan.filter).toBe("__inputId=='in_syslog_paloalto'");
    expect(plan.routes).toHaveLength(1);
    const [sentinel] = plan.routes;
    expect(sentinel).toMatchObject({
      id: "paloalto-sentinel-sentinel",
      filter: "__inputId=='in_syslog_paloalto'",
      pipeline: "pack:paloalto-sentinel",
      output: "default",
      final: true,
      position: 0,
    });
    expect(plan.createDataset).toBeNull();
    expect(plan.commitMessage).not.toContain("Lake");
    expect(plan.deployGroups).toEqual(["wg-1", "wg-2"]);
  });

  it("Lake (cloud): Lake route NON-final at position 0, Sentinel final at position 1", () => {
    const plan = planSourceWiring({
      ...BASE,
      lake: { enabled: true, dataset: "paloalto-raw", deploymentType: "cloud" },
    });
    expect(plan.routes).toHaveLength(2);

    // The load-bearing invariant: Lake (non-final) MUST evaluate BEFORE the
    // final Sentinel route, or data never reaches Lake / bypasses Sentinel.
    const [lake, sentinel] = plan.routes;
    expect(lake).toMatchObject({
      id: "paloalto-sentinel-lake",
      pipeline: "passthru",
      output: "cribl_lake:paloalto-raw",
      final: false,
      position: 0,
    });
    expect(sentinel).toMatchObject({
      id: "paloalto-sentinel-sentinel",
      pipeline: "pack:paloalto-sentinel",
      output: "default",
      final: true,
      position: 1,
    });
    expect(plan.createDataset).toBe("paloalto-raw");
    expect(plan.commitMessage).toContain("Cribl Lake");
  });

  it("the Sentinel route is ALWAYS final:true and the Lake route ALWAYS final:false", () => {
    const withLake = planSourceWiring({
      ...BASE,
      lake: { enabled: true, dataset: "ds", deploymentType: "cloud" },
    });
    const sentinel = withLake.routes.find((r) => r.id.endsWith("-sentinel"));
    const lake = withLake.routes.find((r) => r.id.endsWith("-lake"));
    expect(sentinel?.final).toBe(true);
    expect(lake?.final).toBe(false);
    // And Lake's position is strictly less than Sentinel's (evaluates first).
    expect(lake!.position).toBeLessThan(sentinel!.position);
  });

  it("Lake is a CLOUD-only capability - onprem never gets a Lake route", () => {
    const plan = planSourceWiring({
      ...BASE,
      lake: { enabled: true, dataset: "ds", deploymentType: "onprem" },
    });
    expect(plan.routes).toHaveLength(1);
    expect(plan.routes[0]!.id).toBe("paloalto-sentinel-sentinel");
    expect(plan.createDataset).toBeNull();
  });

  it("Lake disabled or dataset blank -> no Lake route even on cloud", () => {
    expect(
      planSourceWiring({
        ...BASE,
        lake: { enabled: false, dataset: "ds", deploymentType: "cloud" },
      }).routes,
    ).toHaveLength(1);
    expect(
      planSourceWiring({
        ...BASE,
        lake: { enabled: true, dataset: "  ", deploymentType: "cloud" },
      }).routes,
    ).toHaveLength(1);
  });

  it("throws on a blank source id or pack name", () => {
    expect(() => planSourceWiring({ ...BASE, sourceId: " " })).toThrow();
    expect(() => planSourceWiring({ ...BASE, packName: "" })).toThrow();
  });
});

describe("prependRoutes", () => {
  const existing: Array<{ id: string; name: string }> = [
    { id: "other-route", name: "pre-existing" },
  ];

  it("prepends plan routes (evaluation order) ahead of existing routes", () => {
    const plan = planSourceWiring({
      ...BASE,
      lake: { enabled: true, dataset: "ds", deploymentType: "cloud" },
    });
    const merged = prependRoutes(existing, plan.routes);
    // Lake, then Sentinel, then the pre-existing route - order preserved.
    expect(merged.map((r) => (r as { id: string }).id)).toEqual([
      "paloalto-sentinel-lake",
      "paloalto-sentinel-sentinel",
      "other-route",
    ]);
    // Emitted route entries drop the synthetic `position` field.
    expect((merged[0] as RouteEntry & { position?: number }).position).toBeUndefined();
  });

  it("skips a plan route whose id already exists (the already-exists guard)", () => {
    const plan = planSourceWiring(BASE);
    const withDup = [{ id: "paloalto-sentinel-sentinel", name: "already there" }];
    const merged = prependRoutes(withDup, plan.routes);
    expect(merged).toHaveLength(1);
    expect((merged[0] as { name: string }).name).toBe("already there");
  });
});
