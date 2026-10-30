// Pins for the per-scope read verdict (AZR-19, U1a).

import { describe, expect, it } from "vitest";

import {
  mapListRead,
  readRefused,
  readRows,
  refusalsOf,
  toListingFromRead,
  type Refusal,
} from "./list-read";
import type { PolicyAssignment, PolicyExemption, ScopeRead } from "./logging-map-types";

function refusal(request: string, reason: Refusal["reason"], status: number | null): Refusal {
  return { request, status, code: status === 403 ? "AuthorizationFailed" : "", text: "x", reason };
}

describe("toListingFromRead", () => {
  it("a read with zero rows is a VERIFIED none", () => {
    expect(toListingFromRead(readRows([]))).toEqual({ kind: "none" });
  });

  it("a read with rows carries exactly those rows", () => {
    expect(toListingFromRead(readRows(["a", "b"]))).toEqual({ kind: "rows", rows: ["a", "b"] });
  });

  it("a refused read is UNKNOWN (empty), never none", () => {
    const listing = toListingFromRead(readRefused(refusal("/p", "http", 403)));
    expect(listing).toEqual({ kind: "empty" });
  });
});

describe("refusalsOf", () => {
  it("derives exactly one refusal per refused list, in order, with its reason", () => {
    const reads: ScopeRead[] = [
      {
        scopeId: "/subscriptions/a",
        assignments: readRows<PolicyAssignment>([]),
        exemptions: readRows<PolicyExemption>([]),
      },
      {
        scopeId: "/subscriptions/b",
        assignments: readRefused<PolicyAssignment>(refusal("/b/assign", "http", 403)),
        exemptions: readRows<PolicyExemption>([]),
      },
      {
        scopeId: "/subscriptions/c",
        assignments: readRows<PolicyAssignment>([]),
        exemptions: readRefused<PolicyExemption>(refusal("/c/exempt", "unexpected-shape", 200)),
      },
    ];
    const out = refusalsOf(reads);
    expect(out).toHaveLength(2);
    expect(out.map((r) => [r.request, r.reason])).toEqual([
      ["/b/assign", "http"],
      ["/c/exempt", "unexpected-shape"],
    ]);
  });

  it("accepts bare list reads too, and a read list contributes nothing", () => {
    const out = refusalsOf([readRows([1]), readRefused(refusal("/t", "transport", null))]);
    expect(out.map((r) => r.reason)).toEqual(["transport"]);
  });
});

describe("mapListRead", () => {
  it("maps rows and passes a refusal through untouched", () => {
    expect(mapListRead(readRows([1, 2]), (r) => r.map(String))).toEqual(readRows(["1", "2"]));
    const ref = refusal("/x", "too-many-pages", null);
    expect(mapListRead(readRefused<number>(ref), (r) => r)).toEqual({ state: "refused", refusal: ref });
  });
});
