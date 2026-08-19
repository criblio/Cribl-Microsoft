/**
 * Pins for sample-source discovery (plan Phase 3, ADR 0003).
 *
 * THREE GROUPS OF PINS, guarding different failures.
 *
 * ADDRESSING cannot be read off the OpenAPI spec, which declares these paths
 * bare; it was settled live on 2026-08-19 by watching Cribl's own UI. Asserted
 * on the REQUEST rather than the result, because a wrong path fails as an empty
 * list - which reads as "your environment has nothing", the most damaging wrong
 * answer this feature can give.
 *
 * LAZINESS is a cost contract: loading the page must cost ONE request, and
 * choosing a mode must read ONLY that mode's surface. A regression is invisible
 * in behaviour and shows up only as a slow page, so it is pinned by counting.
 *
 * MODE SEPARATION: Lake needs no worker group, capture needs one. Getting that
 * backwards would send a leader route through /m/{group} and 404.
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

  it("reports the SEARCH group even though nothing here calls Search", async () => {
    // Load-bearing for lake-query mode: a Lake dataset is queried THROUGH
    // Search, so the UI needs to know up front whether that is possible.
    const withSearch = await listSampleSourceGroups(
      clientWith([{ id: "s", product: "search" }]),
    );
    expect(withSearch.searchGroupId).toBe("s");

    const without = await listSampleSourceGroups(
      clientWith([{ id: "default", product: "stream" }]),
    );
    expect(without.searchGroupId).toBeUndefined();
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

describe("stage two: lake-query mode", () => {
  it("reads Lake datasets as a LEADER route with NO groupId", async () => {
    const cribl = clientWith([]);
    cribl.respondWith(okBody([{ id: "lake1" }]));

    await loadSampleSources(cribl, { mode: "lake-query" });

    expect(cribl.calls).toHaveLength(1);
    expect(cribl.calls[0].path).toBe("/products/lake/lakes/default/datasets");
    // The distinction that makes it work: no /m/{group} prefix.
    expect(cribl.calls[0].groupId).toBeUndefined();
    // And NOT the create route Unit 20 uses.
    expect(cribl.calls.some((c) => c.path === "/system/lake/datasets")).toBe(false);
  });

  it("IGNORES a groupId - Lake mode needs no worker group at all", async () => {
    const cribl = clientWith([]);
    cribl.respondWith(okBody([]));

    await loadSampleSources(cribl, { mode: "lake-query", groupId: "default" });

    expect(cribl.calls).toHaveLength(1);
    expect(cribl.calls[0].groupId).toBeUndefined();
    expect(cribl.calls.some((c) => c.path === "/system/inputs")).toBe(false);
  });

  it("leaves the SOURCE surface pending - it was never asked about", async () => {
    const cribl = clientWith([]);
    cribl.respondWith(okBody([{ id: "lake1" }]));

    const inventory = await loadSampleSources(cribl, { mode: "lake-query" });

    expect(inventory.sections.find((s) => s.kind === "lake-dataset")?.status).toBe("ok");
    expect(inventory.sections.find((s) => s.kind === "cribl-source")?.status).toBe("pending");
  });

  it("lakeDatasetsPath encodes the lake id", () => {
    expect(lakeDatasetsPath("default")).toBe("/products/lake/lakes/default/datasets");
    expect(lakeDatasetsPath("my lake")).toBe("/products/lake/lakes/my%20lake/datasets");
  });
});

describe("stage two: live-capture mode", () => {
  it("reads the SELECTED group's sources, and only that group's", async () => {
    const cribl = clientWith([]);
    cribl.respondWith(okBody([{ id: "in_syslog", type: "syslog" }]));

    await loadSampleSources(cribl, { mode: "live-capture", groupId: "chosen" });

    expect(cribl.calls).toHaveLength(1);
    expect(cribl.calls[0].path).toBe("/system/inputs");
    expect(cribl.calls[0].groupId).toBe("chosen");
    // Lake is a different mode's surface and must not be read.
    expect(cribl.calls.some((c) => c.path.startsWith("/products/lake/"))).toBe(false);
  });

  it("reads NOTHING when no group has been picked yet", async () => {
    const cribl = clientWith([]);

    const inventory = await loadSampleSources(cribl, { mode: "live-capture" });

    expect(cribl.calls).toHaveLength(0);
    expect(inventory.sections.every((s) => s.status === "pending")).toBe(true);
  });

  it("leaves the LAKE surface pending - it was never asked about", async () => {
    const cribl = clientWith([]);
    cribl.respondWith(okBody([{ id: "in_a" }]));

    const inventory = await loadSampleSources(cribl, {
      mode: "live-capture",
      groupId: "g",
    });

    expect(inventory.sections.find((s) => s.kind === "lake-dataset")?.status).toBe("pending");
    expect(inventory.sections.find((s) => s.kind === "cribl-source")?.status).toBe("ok");
  });
});

describe("stage two: degradation", () => {
  it("a failed read becomes a failed section, never an exception", async () => {
    const cribl = clientWith([]);
    cribl.respondWith({ status: 403, body: "nope" });

    const inventory = await loadSampleSources(cribl, { mode: "lake-query" });

    expect(inventory.sections.find((s) => s.kind === "lake-dataset")?.status).toBe("failed");
  });

  it("a TRANSPORT rejection is folded into a failed section, never thrown", async () => {
    const cribl = clientWith([]);
    // No scripted response: the fake throws, standing in for a network failure.

    const inventory = await loadSampleSources(cribl, { mode: "lake-query" });

    expect(inventory.sections).toHaveLength(2);
    expect(inventory.sections.find((s) => s.kind === "lake-dataset")?.status).toBe("failed");
  });
});
