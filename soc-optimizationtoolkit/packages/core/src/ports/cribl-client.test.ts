/**
 * Pins for the isStreamWorkerGroup filter (user report 2026-07-08: the
 * Configure Cribl worker-group lists showed Edge fleets alongside Stream
 * worker groups; every group selector in the app deploys Stream pipelines
 * and destinations, so Edge fleets must never be offered).
 *
 * The UNREPORTED case is deliberate: older and single-product leaders omit
 * `product` from /master/groups (it is not in the vendored OpenAPI spec).
 * Treating missing product as Stream keeps those deployments working - they
 * are exactly the ones with no Edge fleets to mis-list.
 */

import { describe, expect, it } from "vitest";
import { isStreamWorkerGroup } from "./cribl-client";

describe("isStreamWorkerGroup", () => {
  it("keeps groups reporting product 'stream'", () => {
    expect(isStreamWorkerGroup({ id: "default", product: "stream" })).toBe(
      true,
    );
  });

  it("excludes Edge fleets", () => {
    expect(
      isStreamWorkerGroup({ id: "default_fleet", product: "edge" }),
    ).toBe(false);
  });

  it("keeps groups with no reported product (older leaders)", () => {
    expect(isStreamWorkerGroup({ id: "default" })).toBe(true);
  });

  it("matches product case-insensitively", () => {
    expect(isStreamWorkerGroup({ id: "g", product: "Stream" })).toBe(true);
    expect(isStreamWorkerGroup({ id: "f", product: "Edge" })).toBe(false);
  });

  it("excludes any other reported product (e.g. search)", () => {
    expect(isStreamWorkerGroup({ id: "s", product: "search" })).toBe(false);
  });
});
