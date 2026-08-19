/**
 * Pins for sample-source discovery (plan Phase 3, ADR 0003).
 *
 * TWO GROUPS OF PINS, and they guard different failures.
 *
 * ADDRESSING cannot be read off the OpenAPI spec, which declares these paths
 * bare; it was settled live on 2026-08-19 by watching Cribl's own UI. Each is
 * asserted on the REQUEST rather than the result, because a wrong path fails as
 * an empty list - which reads as "your environment has nothing", the most
 * damaging wrong answer this feature can give.
 *
 * LAZINESS is a cost contract (user direction 2026-08-19): loading the page must
 * cost ONE request. The first cut fanned out across every Stream worker group,
 * which was up to nine. A regression here is invisible in behaviour and only
 * shows up as a slow page and a burnt proxy budget, so it is pinned by counting
 * calls.
 */

import { describe, expect, it } from "vitest";

import { FakeCriblClient } from "../../testing/fake-cribl-client";
import {
  lakeDatasetsPath,
  listSampleSourceGroups,
  loadSampleSources,
} from "./discover-sample-sources";

const okBody = (items: unknown[]) => ({ status: 200, body: { count: items.length, items } });

function clientWith(groups: Array<{ id: string; product?: string }>) {
  const cribl = new FakeCriblClient();
  cribl.groups = groups;
  return cribl;
}

describe("stage one: listing groups is ONE request and nothing else", () => {
  it("lists groups without touching a single source or dataset", async () => {
    const cribl = clientWith([
      { id: "default", product: "stream" },
      { id: "grp2", product: "stream" },
      { id: "default_search", product: "search" },
      { id: "edge1", product: "edge" },
    ]);

    const groups = await listSampleSourceGroups(cribl);

    // THE cost pin: the page load must not fan out.
    expect(cribl.calls).toHaveLength(0);
    expect(cribl.listGroupsCalls).toBe(1);
    expect(groups.ok).toBe(true);
    expect(groups.streamGroupIds).toEqual(["default", "grp2"]);
    expect(groups.searchGroupId).toBe("default_search");
  });

  it("returns EVERY stream group - the old cap silently hid some", async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ id: `g${i}`, product: "stream" }));
    const groups = await listSampleSourceGroups(clientWith(many));
    expect(groups.streamGroupIds).toHaveLength(15);
    expect(groups.notes).toEqual([]);
  });

  it("reports a failed listing rather than throwing, and says upload still works", async () => {
    const cribl = new FakeCriblClient();
    cribl.listGroups = async () => {
      throw new Error("leader unreachable");
    };

    const groups = await listSampleSourceGroups(cribl);

    expect(groups.ok).toBe(false);
    expect(groups.streamGroupIds).toEqual([]);
    expect(groups.notes.join(" ")).toContain("leader unreachable");
    expect(groups.notes.join(" ")).toContain("Uploading samples still works");
  });

  it("says when there is no Stream group to capture from", async () => {
    const groups = await listSampleSourceGroups(clientWith([{ id: "e", product: "edge" }]));
    expect(groups.streamGroupIds).toEqual([]);
    expect(groups.notes.join(" ")).toContain("no live source to capture from");
  });
});

describe("stage two: addressing (the part the spec could not settle)", () => {
  it("reads the SELECTED group's sources, and only that group's", async () => {
    const cribl = clientWith([]);
    cribl.respondWith(okBody([{ id: "in_syslog", type: "syslog" }]), okBody([]), okBody([]));

    await loadSampleSources(cribl, { groupId: "chosen", searchGroupId: "s" });

    const inputCalls = cribl.calls.filter((c) => c.path === "/system/inputs");
    expect(inputCalls).toHaveLength(1);
    expect(inputCalls[0].groupId).toBe("chosen");
  });

  it("reads Search datasets through the SEARCH group, not the selected one", async () => {
    const cribl = clientWith([]);
    cribl.respondWith(okBody([]), okBody([{ id: "ds1" }]), okBody([]));

    await loadSampleSources(cribl, { groupId: "default", searchGroupId: "default_search" });

    const searchCall = cribl.calls.find((c) => c.path === "/search/datasets");
    expect(searchCall?.groupId).toBe("default_search");
    expect(searchCall?.method).toBe("GET");
  });

  it("reads Lake datasets as a LEADER route with NO groupId", async () => {
    const cribl = clientWith([]);
    cribl.respondWith(okBody([]), okBody([{ id: "lake1" }]));

    await loadSampleSources(cribl, { groupId: "default" });

    const lakeCall = cribl.calls.find((c) => c.path.startsWith("/products/lake/"));
    expect(lakeCall?.path).toBe("/products/lake/lakes/default/datasets");
    // The distinction that makes it work: no /m/{group} prefix.
    expect(lakeCall?.groupId).toBeUndefined();
    // And NOT the create route Unit 20 uses.
    expect(cribl.calls.some((c) => c.path === "/system/lake/datasets")).toBe(false);
  });

  it("skips the Search read entirely when the workspace has no Search group", async () => {
    const cribl = clientWith([]);
    cribl.respondWith(okBody([]), okBody([]));

    const inventory = await loadSampleSources(cribl, { groupId: "default" });

    expect(cribl.calls.some((c) => c.path === "/search/datasets")).toBe(false);
    expect(inventory.sections.find((s) => s.kind === "search-dataset")?.status).toBe(
      "unavailable",
    );
  });

  it("lakeDatasetsPath encodes the lake id", () => {
    expect(lakeDatasetsPath("default")).toBe("/products/lake/lakes/default/datasets");
    expect(lakeDatasetsPath("my lake")).toBe("/products/lake/lakes/my%20lake/datasets");
  });
});

describe("stage two: cost", () => {
  it("costs THREE requests the first time and ONE on a group change", async () => {
    const cribl = clientWith([]);
    cribl.respondWith(okBody([]), okBody([]), okBody([]));
    await loadSampleSources(cribl, { groupId: "a", searchGroupId: "s" });
    expect(cribl.calls).toHaveLength(3);

    // The datasets do not depend on the group, so a caller that already has
    // them says so and pays for the source listing alone.
    cribl.calls.length = 0;
    cribl.respondWith(okBody([]));
    await loadSampleSources(cribl, {
      groupId: "b",
      searchGroupId: "s",
      includeDatasets: false,
    });
    expect(cribl.calls).toHaveLength(1);
    expect(cribl.calls[0].path).toBe("/system/inputs");
  });

  it("leaves un-requested surfaces PENDING, never empty", async () => {
    const cribl = clientWith([]);
    cribl.respondWith(okBody([{ id: "in_a" }]));

    const inventory = await loadSampleSources(cribl, {
      groupId: "a",
      searchGroupId: "s",
      includeDatasets: false,
    });

    // "Not asked" and "asked, and there are none" are different claims.
    expect(inventory.sections.find((s) => s.kind === "search-dataset")?.status).toBe("pending");
    expect(inventory.sections.find((s) => s.kind === "lake-dataset")?.status).toBe("pending");
    expect(inventory.sections.find((s) => s.kind === "cribl-source")?.status).toBe("ok");
  });
});

describe("stage two: degradation", () => {
  it("a refused Search read does NOT cost the operator their source list", async () => {
    const cribl = clientWith([]);
    cribl.respondWith(
      okBody([{ id: "in_syslog", type: "syslog" }]),
      { status: 403, body: "nope" },
      okBody([]),
    );

    const inventory = await loadSampleSources(cribl, {
      groupId: "default",
      searchGroupId: "s",
    });

    expect(inventory.sections.find((s) => s.kind === "search-dataset")?.status).toBe("failed");
    const sources = inventory.sections.find((s) => s.kind === "cribl-source");
    expect(sources?.status).toBe("ok");
    expect(sources?.entries.map((e) => e.id)).toEqual(["in_syslog"]);
  });

  it("a TRANSPORT rejection is folded into a failed section, never thrown", async () => {
    const cribl = clientWith([]);
    // One scripted response; the rest throw inside the fake, standing in for a
    // network failure.
    cribl.respondWith(okBody([]));

    const inventory = await loadSampleSources(cribl, {
      groupId: "default",
      searchGroupId: "s",
    });

    expect(inventory.sections).toHaveLength(3);
    expect(inventory.sections.some((s) => s.status === "failed")).toBe(true);
  });
});
