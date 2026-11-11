import { describe, expect, it } from "vitest";
import { parseRouteFilterInputs } from "../../domain/live-architecture/live-architecture";
import { matchInputIdFilter } from "../../domain/capture-filter/input-id";
import { planSourceWiring } from "./source-wiring";

const BASE = {
  sourceId: "in_syslog_paloalto",
  sourceType: "syslog",
  packName: "paloalto-sentinel",
};

describe("planSourceWiring - ROUTE ORDER SEMANTICS (a regression silently drops data)", () => {
  it("no Lake: a single Sentinel route, final:true, at position 0", () => {
    const plan = planSourceWiring(BASE);
    // DBT-301: the typed form Cribl's events carry; syslog adds the sender segment.
    expect(plan.filter).toBe("__inputId.startsWith('syslog:in_syslog_paloalto:')");
    expect(plan.routes).toHaveLength(1);
    const [sentinel] = plan.routes;
    expect(sentinel).toMatchObject({
      id: "paloalto-sentinel-sentinel",
      filter: "__inputId.startsWith('syslog:in_syslog_paloalto:')",
      pipeline: "pack:paloalto-sentinel",
      output: "default",
      final: true,
      position: 0,
    });
    expect(plan.createDataset).toBeNull();
    expect(plan.commitMessage).not.toContain("Lake");
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

  it("throws on a blank source id, source type or pack name", () => {
    expect(() => planSourceWiring({ ...BASE, sourceId: " " })).toThrow();
    expect(() => planSourceWiring({ ...BASE, sourceType: " " })).toThrow();
    expect(() => planSourceWiring({ ...BASE, packName: "" })).toThrow();
  });
});

// DBT-301 replaced the bare-id filter pin (`__inputId=='<id>'`, recorded in
// input-id.ts as matching nothing live) with these: every route's filter
// selects the input by `<type>:<id>`, and reads back as a `match`, never
// `legacy`.
describe("planSourceWiring - the filter selects the input by <type>:<id>", () => {
  it("a non-segmented type writes an equality on <type>:<id>", () => {
    const plan = planSourceWiring({ ...BASE, sourceType: "tcpjson", sourceId: "in_tcp" });
    expect(plan.filter).toBe("__inputId=='tcpjson:in_tcp'");
  });

  it("every route, Lake included, carries the one filter, and it reads back as a typed match", () => {
    const plan = planSourceWiring({
      ...BASE,
      lake: { enabled: true, dataset: "ds", deploymentType: "cloud" },
    });
    for (const route of plan.routes) {
      expect(route.filter).toBe(plan.filter);
      expect(route.filter).not.toBe("__inputId=='in_syslog_paloalto'");
      const parsed = parseRouteFilterInputs(route.filter);
      expect(parsed.kind).not.toBe("unparsed");
      if (parsed.kind === "unparsed") return;
      expect(matchInputIdFilter(parsed, { type: "syslog", id: "in_syslog_paloalto" })).toBe("match");
    }
  });
});
