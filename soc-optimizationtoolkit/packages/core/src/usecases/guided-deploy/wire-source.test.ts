import { describe, expect, it } from "vitest";
import { FakeCriblClient } from "../../testing";
import { wireSource } from "./wire-source";

const BASE = {
  sourceId: "in_syslog_paloalto",
  packName: "paloalto-sentinel",
  workerGroups: ["wg-1", "wg-2"],
};

describe("wireSource - applies the plan in the correct route order", () => {
  it("no Lake: GET routes -> prepend Sentinel -> PUT -> commit -> deploy per group", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith(
      { status: 200, body: { id: "default", routes: [{ id: "existing" }] } }, // GET
      { status: 200, body: {} }, // PUT
      { status: 200, body: { version: "commit-1" } }, // commit
      { status: 200, body: {} }, // deploy wg-1
      { status: 200, body: {} }, // deploy wg-2
    );

    const result = await wireSource({ cribl }, BASE);

    expect(result.appliedRoutes.map((r) => r.id)).toEqual([
      "paloalto-sentinel-sentinel",
      "existing",
    ]);
    expect(result.appliedRoutes[0]!.final).toBe(true);
    expect(result.committed).toBe("commit-1");
    expect(result.deployedGroups).toEqual(["wg-1", "wg-2"]);
    expect(result.warnings).toEqual([]);

    // The PUT carried the merged routes in evaluation order.
    const putCall = cribl.calls[1]!;
    expect(putCall.method).toBe("PUT");
    expect((putCall.body as { routes: Array<{ id: string }> }).routes.map((r) => r.id)).toEqual(
      ["paloalto-sentinel-sentinel", "existing"],
    );
  });

  it("Lake (cloud): creates the dataset, then Lake-before-Sentinel routes", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith(
      { status: 200, body: {} }, // POST dataset
      { status: 200, body: { id: "default", routes: [] } }, // GET
      { status: 200, body: {} }, // PUT
      { status: 200, body: { version: "commit-2" } }, // commit
      { status: 200, body: {} }, // deploy wg-1
      { status: 200, body: {} }, // deploy wg-2
    );

    const result = await wireSource(
      { cribl },
      {
        ...BASE,
        lake: { enabled: true, dataset: "paloalto-raw", deploymentType: "cloud" },
      },
    );

    expect(result.datasetCreated).toBe(true);
    expect(result.appliedRoutes.map((r) => r.id)).toEqual([
      "paloalto-sentinel-lake",
      "paloalto-sentinel-sentinel",
    ]);
    // Lake non-final BEFORE final Sentinel - the data-preserving order.
    expect(result.appliedRoutes[0]!.final).toBe(false);
    expect(result.appliedRoutes[1]!.final).toBe(true);
    // The dataset POST happened first.
    expect(cribl.calls[0]!.path).toBe("/system/lake/datasets");
  });

  it("records commit/deploy API failures as non-fatal warnings", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith(
      { status: 200, body: { id: "default", routes: [] } }, // GET
      { status: 200, body: {} }, // PUT
      { status: 400, body: { message: "no pending changes" } }, // commit fails
      { status: 500, body: {} }, // deploy wg-1 fails
      { status: 200, body: {} }, // deploy wg-2 ok
    );

    const result = await wireSource({ cribl }, BASE);
    expect(result.committed).toBeNull();
    expect(result.deployedGroups).toEqual(["wg-2"]);
    expect(result.warnings.length).toBe(2);
  });

  it("throws when the routes GET fails (cannot apply routes)", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith({ status: 500, body: {} });
    await expect(wireSource({ cribl }, BASE)).rejects.toThrow(/GET routes failed/);
  });
});
