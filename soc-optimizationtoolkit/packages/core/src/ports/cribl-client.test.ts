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
import {
  deriveGroupProduct,
  isStreamWorkerGroup,
  streamWorkerGroups,
} from "./cribl-client";
import { toListing } from "../domain/inventory-listing";

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

describe("deriveGroupProduct", () => {
  it("prefers the explicit product string when present", () => {
    expect(deriveGroupProduct("stream", "edge", true, undefined)).toBe(
      "stream",
    );
    expect(deriveGroupProduct("edge", undefined, undefined, undefined)).toBe(
      "edge",
    );
  });

  it("derives from the ConfigGroup type (the Outpost marker)", () => {
    // Live report 2026-07-09: default_outpost carried type "outpost" and no
    // isFleet flag, so it survived the fleet fix until type was read.
    expect(deriveGroupProduct(undefined, "outpost", undefined, undefined)).toBe(
      "outpost",
    );
    expect(deriveGroupProduct(undefined, "stream", undefined, undefined)).toBe(
      "stream",
    );
    expect(
      deriveGroupProduct(undefined, "lake_access", undefined, undefined),
    ).toBe("lake_access");
  });

  it("derives edge from isFleet on leaders that omit product and type", () => {
    // Live report 2026-07-09: default_fleet and friends listed with no
    // product field - the isFleet boolean is the only fleet marker.
    expect(deriveGroupProduct(undefined, undefined, true, undefined)).toBe(
      "edge",
    );
  });

  it("derives search from isSearch", () => {
    expect(deriveGroupProduct(undefined, undefined, undefined, true)).toBe(
      "search",
    );
  });

  it("returns undefined when no signal is present (kept visible)", () => {
    expect(
      deriveGroupProduct(undefined, undefined, undefined, undefined),
    ).toBeUndefined();
    expect(deriveGroupProduct("", "", false, false)).toBeUndefined();
  });

  it("ignores non-boolean truthy flag values", () => {
    expect(
      deriveGroupProduct(undefined, undefined, "yes", undefined),
    ).toBeUndefined();
  });

  it("classes a group as stream when EITHER product or type says so", () => {
    // DBT-134 hardening: an unexpected product string used to outrank the
    // spec's own `type` discriminator and drop a Stream group from every
    // picker.
    expect(deriveGroupProduct("cribl", "stream", undefined, undefined)).toBe(
      "stream",
    );
    expect(deriveGroupProduct("Stream", "edge", undefined, undefined)).toBe(
      "stream",
    );
    // Neither says stream: the explicit product still wins over the type.
    expect(deriveGroupProduct("edge", "outpost", undefined, undefined)).toBe(
      "edge",
    );
  });
});

describe("streamWorkerGroups", () => {
  it("keeps an EMPTY listing unverified, with nothing excluded", () => {
    // The tester's case: a 2xx with no items is what a role that covers no
    // group receives, so it must not become a measured zero.
    expect(streamWorkerGroups(toListing([]))).toEqual({
      stream: { kind: "empty" },
      excluded: [],
    });
  });

  it("reports a listing of only non-Stream groups as a measured none, naming them", () => {
    const fleet = { id: "default_fleet", product: "edge" };
    const search = { id: "default_search", product: "search" };
    expect(streamWorkerGroups(toListing([fleet, search]))).toEqual({
      stream: { kind: "none" },
      excluded: [fleet, search],
    });
  });

  it("splits a mixed listing into Stream rows and the rest", () => {
    const stream = { id: "default", product: "stream" };
    const unreported = { id: "legacy" };
    const fleet = { id: "default_fleet", product: "edge" };
    expect(streamWorkerGroups(toListing([stream, fleet, unreported]))).toEqual({
      stream: { kind: "rows", rows: [stream, unreported] },
      excluded: [fleet],
    });
  });
});
