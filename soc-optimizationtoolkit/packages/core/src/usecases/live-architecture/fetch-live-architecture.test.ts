/**
 * fetch-live-architecture pins: seven GETs in snapshot-field order against
 * the selected group (including /jobs for scheduled collectors); rejections
 * become undefined sections; HTTP errors pass through untouched.
 */

import { describe, expect, it } from "vitest";
import { FakeCriblClient } from "../../testing/fake-cribl-client";
import { fetchLiveArchitecture } from "./fetch-live-architecture";

describe("fetchLiveArchitecture", () => {
  it("issues the seven GETs against the group and captures each section", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith(
      { status: 200, body: { items: [{ id: "in1" }] } },
      { status: 200, body: { items: [{ id: "out1" }] } },
      { status: 200, body: { routes: [] } },
      { status: 200, body: { items: [] } },
      { status: 403, body: { error: "denied" } },
      { status: 200, body: { items: [] } },
      { status: 200, body: { items: [{ id: "job1" }] } },
    );
    const snapshot = await fetchLiveArchitecture(cribl, "grp-1");
    expect(cribl.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /system/inputs",
      "GET /system/outputs",
      "GET /routes",
      "GET /pipelines",
      "GET /lib/breakers",
      "GET /packs",
      "GET /jobs",
    ]);
    expect(cribl.calls.every((c) => c.groupId === "grp-1")).toBe(true);
    expect(snapshot.groupId).toBe("grp-1");
    expect(snapshot.inputs).toEqual({ status: 200, body: { items: [{ id: "in1" }] } });
    expect(snapshot.jobs).toEqual({ status: 200, body: { items: [{ id: "job1" }] } });
    // HTTP errors pass through with status intact (the builder notes them).
    expect(snapshot.breakers).toEqual({ status: 403, body: { error: "denied" } });
  });

  it("turns a rejected request into an undefined section, keeping the rest", async () => {
    const cribl = new FakeCriblClient();
    // Only six responses scripted: the seventh call (jobs) throws.
    cribl.respondWith(
      { status: 200, body: { items: [] } },
      { status: 200, body: { items: [] } },
      { status: 200, body: { routes: [] } },
      { status: 200, body: { items: [] } },
      { status: 200, body: { items: [] } },
      { status: 200, body: { items: [] } },
    );
    const snapshot = await fetchLiveArchitecture(cribl, "grp-1");
    expect(snapshot.jobs).toBeUndefined();
    expect(snapshot.inputs).toBeDefined();
    expect(snapshot.packs).toBeDefined();
  });
});
