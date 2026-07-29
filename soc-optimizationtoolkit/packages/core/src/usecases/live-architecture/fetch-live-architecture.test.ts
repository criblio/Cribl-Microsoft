/**
 * fetch-live-architecture pins: six GETs in snapshot-field order against
 * the selected group; rejections become undefined sections; HTTP errors
 * pass through untouched.
 */

import { describe, expect, it } from "vitest";
import { FakeCriblClient } from "../../testing/fake-cribl-client";
import { fetchLiveArchitecture } from "./fetch-live-architecture";

describe("fetchLiveArchitecture", () => {
  it("issues the six GETs against the group and captures each section", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith(
      { status: 200, body: { items: [{ id: "in1" }] } },
      { status: 200, body: { items: [{ id: "out1" }] } },
      { status: 200, body: { routes: [] } },
      { status: 200, body: { items: [] } },
      { status: 403, body: { error: "denied" } },
      { status: 200, body: { items: [] } },
    );
    const snapshot = await fetchLiveArchitecture(cribl, "grp-1");
    expect(cribl.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /system/inputs",
      "GET /system/outputs",
      "GET /routes",
      "GET /pipelines",
      "GET /lib/breakers",
      "GET /packs",
    ]);
    expect(cribl.calls.every((c) => c.groupId === "grp-1")).toBe(true);
    expect(snapshot.groupId).toBe("grp-1");
    expect(snapshot.inputs).toEqual({ status: 200, body: { items: [{ id: "in1" }] } });
    // HTTP errors pass through with status intact (the builder notes them).
    expect(snapshot.breakers).toEqual({ status: 403, body: { error: "denied" } });
  });

  it("turns a rejected request into an undefined section, keeping the rest", async () => {
    const cribl = new FakeCriblClient();
    // Only five responses scripted: the sixth call (packs) throws.
    cribl.respondWith(
      { status: 200, body: { items: [] } },
      { status: 200, body: { items: [] } },
      { status: 200, body: { routes: [] } },
      { status: 200, body: { items: [] } },
      { status: 200, body: { items: [] } },
    );
    const snapshot = await fetchLiveArchitecture(cribl, "grp-1");
    expect(snapshot.packs).toBeUndefined();
    expect(snapshot.inputs).toBeDefined();
    expect(snapshot.breakers).toBeDefined();
  });
});
