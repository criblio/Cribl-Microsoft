/**
 * Pins for sample-source discovery (plan Phase 3, ADR 0003).
 *
 * The load-bearing ones are about ADDRESSING, because that is what cannot be
 * read off the OpenAPI spec and was settled live on 2026-08-19 by watching
 * Cribl's own UI:
 *
 *   - `/search/datasets` is GROUP-scoped, and specifically to the SEARCH group -
 *     sending it to a Stream group gets a 404 that reads as "no datasets";
 *   - Lake datasets are a LEADER route with a lakeId segment, NOT the
 *     `/system/lake/datasets` route Unit 20 POSTs to;
 *   - the Search group id is NOT a constant (`default_search` is one
 *     workspace's), so it must come from listGroups().
 *
 * A spec-shaped mistake in any of these fails silently as an empty inventory,
 * so each is asserted on the REQUEST, not on the result.
 */

import { describe, expect, it } from "vitest";

import { FakeCriblClient } from "../../testing/fake-cribl-client";
import {
  MAX_SOURCE_GROUPS,
  discoverSampleSources,
  lakeDatasetsPath,
} from "./discover-sample-sources";

const okBody = (items: unknown[]) => ({ status: 200, body: { count: items.length, items } });

function clientWith(groups: Array<{ id: string; product?: string }>) {
  const cribl = new FakeCriblClient();
  cribl.groups = groups;
  return cribl;
}

describe("addressing (the part the spec could not settle)", () => {
  it("reads Search datasets through the SEARCH group, not a Stream group", async () => {
    const cribl = clientWith([
      { id: "default", product: "stream" },
      { id: "default_search", product: "search" },
    ]);
    // search, lake, then one per stream group - in that order.
    cribl.respondWith(okBody([{ id: "ds1" }]), okBody([]), okBody([]));

    await discoverSampleSources(cribl);

    const searchCall = cribl.calls.find((c) => c.path === "/search/datasets");
    expect(searchCall).toBeDefined();
    expect(searchCall?.groupId).toBe("default_search");
    expect(searchCall?.method).toBe("GET");
  });

  it("reads Lake datasets as a LEADER route with NO groupId", async () => {
    const cribl = clientWith([{ id: "default", product: "stream" }]);
    cribl.respondWith(okBody([{ id: "lake1" }]), okBody([]));

    await discoverSampleSources(cribl);

    const lakeCall = cribl.calls.find((c) => c.path.startsWith("/products/lake/"));
    expect(lakeCall?.path).toBe("/products/lake/lakes/default/datasets");
    // The distinction that makes it work: no /m/{group} prefix.
    expect(lakeCall?.groupId).toBeUndefined();
    // And NOT the create route Unit 20 uses.
    expect(cribl.calls.some((c) => c.path === "/system/lake/datasets")).toBe(false);
  });

  it("reads sources per STREAM group, each with its own groupId", async () => {
    const cribl = clientWith([
      { id: "default", product: "stream" },
      { id: "edge1", product: "edge" },
      { id: "grp2", product: "stream" },
    ]);
    cribl.respondWith(okBody([]), okBody([]), okBody([]));

    await discoverSampleSources(cribl);

    const inputCalls = cribl.calls.filter((c) => c.path === "/system/inputs");
    expect(inputCalls.map((c) => c.groupId)).toEqual(["default", "grp2"]);
    // Edge fleets are not Stream groups and carry no capturable Stream source.
    expect(inputCalls.some((c) => c.groupId === "edge1")).toBe(false);
  });

  it("does not invent a Search group when the leader reports none", async () => {
    const cribl = clientWith([{ id: "default", product: "stream" }]);
    cribl.respondWith(okBody([]), okBody([]));

    const { inventory } = await discoverSampleSources(cribl);

    expect(cribl.calls.some((c) => c.path === "/search/datasets")).toBe(false);
    const search = inventory.sections.find((s) => s.kind === "search-dataset");
    expect(search?.status).toBe("unavailable");
  });

  it("lakeDatasetsPath encodes the lake id", () => {
    expect(lakeDatasetsPath("default")).toBe("/products/lake/lakes/default/datasets");
    expect(lakeDatasetsPath("my lake")).toBe("/products/lake/lakes/my%20lake/datasets");
  });
});

describe("degradation", () => {
  it("a refused Search read does NOT cost the operator their source list", async () => {
    const cribl = clientWith([
      { id: "default", product: "stream" },
      { id: "s", product: "search" },
    ]);
    cribl.respondWith(
      { status: 403, body: "nope" },
      okBody([]),
      okBody([{ id: "in_syslog", type: "syslog" }]),
    );

    const { inventory } = await discoverSampleSources(cribl);

    expect(inventory.sections.find((s) => s.kind === "search-dataset")?.status).toBe("failed");
    const sources = inventory.sections.find((s) => s.kind === "cribl-source");
    expect(sources?.status).toBe("ok");
    expect(sources?.entries.map((e) => e.id)).toEqual(["in_syslog"]);
  });

  it("a TRANSPORT rejection is folded into a failed section, never thrown", async () => {
    const cribl = clientWith([{ id: "default", product: "stream" }]);
    // Only one scripted response: the second request throws inside the fake,
    // standing in for a network failure.
    cribl.respondWith(okBody([]));

    const { inventory } = await discoverSampleSources(cribl);

    expect(inventory.sections).toHaveLength(3);
    expect(inventory.sections.some((s) => s.status === "failed")).toBe(true);
  });

  it("a failed listGroups yields an empty inventory and says upload still works", async () => {
    const cribl = new FakeCriblClient();
    cribl.listGroups = async () => {
      throw new Error("leader unreachable");
    };

    const { inventory, notes } = await discoverSampleSources(cribl);

    expect(inventory.sections).toHaveLength(3);
    expect(inventory.sections.every((s) => s.entries.length === 0)).toBe(true);
    expect(notes.join(" ")).toContain("leader unreachable");
    expect(notes.join(" ")).toContain("Uploading samples still works");
    // Nothing was attempted, so no request went out.
    expect(cribl.calls).toHaveLength(0);
  });
});

describe("request budget", () => {
  it("caps the worker groups read and SAYS how many it skipped", async () => {
    const groups = Array.from({ length: MAX_SOURCE_GROUPS + 4 }, (_, i) => ({
      id: `g${i}`,
      product: "stream",
    }));
    const cribl = clientWith(groups);
    // lake + one per capped group.
    cribl.respondWith(...Array.from({ length: MAX_SOURCE_GROUPS + 1 }, () => okBody([])));

    const { notes } = await discoverSampleSources(cribl);

    expect(cribl.calls.filter((c) => c.path === "/system/inputs")).toHaveLength(
      MAX_SOURCE_GROUPS,
    );
    // A silent cap reads as "this is everything", which is the failure the
    // no-silent-caps rule exists for.
    expect(notes.join(" ")).toContain(`first ${MAX_SOURCE_GROUPS} of ${groups.length}`);
  });

  it("an explicit group list overrides discovery and is not capped away", async () => {
    const cribl = clientWith([
      { id: "default", product: "stream" },
      { id: "other", product: "stream" },
    ]);
    cribl.respondWith(okBody([]), okBody([]));

    const { notes } = await discoverSampleSources(cribl, { groupIds: ["other"] });

    expect(cribl.calls.filter((c) => c.path === "/system/inputs").map((c) => c.groupId)).toEqual([
      "other",
    ]);
    expect(notes).toEqual([]);
  });
});
