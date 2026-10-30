/**
 * Pins for the verdict-returning pager (AZR-19). The first case is the gap
 * the pager was written for: the shared `listAllPages` used to turn a 2xx
 * without an array `value` into zero items with no signal (it throws since
 * DBT-148), which the logging map would then have stated as a verified "none".
 */

import { describe, expect, it } from "vitest";
import type {
  AzureManagement,
  AzureManagementRequest,
  AzureManagementUrlRequest,
} from "../../ports/azure-management";
import type { PortHttpResponse } from "../../ports/http";
import { MAX_LIST_PAGES, listAllPages } from "../azure-discovery";
import { readAllPages, readSingle } from "./arm-pager";

type Answer = PortHttpResponse | Error;

/** Path- and URL-routed stub: each route answers from its own FIFO list. */
class RoutedAzure implements AzureManagement {
  readonly calls: string[] = [];
  private readonly routes: Record<string, Answer[]>;
  constructor(routes: Record<string, Answer[]>) {
    this.routes = routes;
  }
  private answer(key: string): Promise<PortHttpResponse> {
    this.calls.push(key);
    const list = this.routes[key];
    const next = list?.shift();
    if (next === undefined) return Promise.reject(new Error(`unscripted ${key}`));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }
  request(opts: AzureManagementRequest): Promise<PortHttpResponse> {
    return this.answer(opts.path);
  }
  requestUrl(opts: AzureManagementUrlRequest): Promise<PortHttpResponse> {
    return this.answer(opts.url);
  }
}

const REQ: AzureManagementRequest = {
  method: "GET",
  path: "/subscriptions/s1/providers/Microsoft.Authorization/policyExemptions",
  apiVersion: "2022-07-01-preview",
};
const P = REQ.path;
const url = (n: number): string => `https://management.azure.com/next/${n}`;

describe("readAllPages", () => {
  it("refuses a 2xx with no `value` as unexpected-shape, where listAllPages throws (DBT-148)", async () => {
    // listAllPages used to read this body as zero items; it now throws, and
    // readAllPages returns the same failure as a verdict instead.
    await expect(
      listAllPages(new RoutedAzure({ [P]: [{ status: 200, body: {} }] }), REQ, "x"),
    ).rejects.toThrow(`x: HTTP 200 body from ${P} has no array 'value'`);

    const read = await readAllPages(new RoutedAzure({ [P]: [{ status: 200, body: {} }] }), REQ, "exemptions");
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.refusal.reason).toBe("unexpected-shape");
    expect(read.refusal.status).toBe(200);
    expect(read.refusal.request).toBe(P);
  });

  it("a 200 with value [] is a completed read of zero rows", async () => {
    const read = await readAllPages(new RoutedAzure({ [P]: [{ status: 200, body: { value: [] } }] }), REQ, "x");
    expect(read).toEqual({ state: "read", rows: [] });
  });

  it("follows nextLink: rows are the sum of both pages", async () => {
    const azure = new RoutedAzure({
      [P]: [{ status: 200, body: { value: [1, 2], nextLink: url(2) } }],
      [url(2)]: [{ status: 200, body: { value: [3] } }],
    });
    const read = await readAllPages(azure, REQ, "x");
    expect(read).toEqual({ state: "read", rows: [1, 2, 3] });
    expect(azure.calls).toEqual([P, url(2)]);
  });

  it("a page-2 body without `value` refuses the whole read and returns no partial rows", async () => {
    const azure = new RoutedAzure({
      [P]: [{ status: 200, body: { value: [1, 2], nextLink: url(2) } }],
      [url(2)]: [{ status: 200, body: { nextLink: "" } }],
    });
    const read = await readAllPages(azure, REQ, "x");
    expect(read.state).toBe("refused");
    expect("rows" in read).toBe(false);
    if (read.state === "refused") {
      expect(read.refusal.reason).toBe("unexpected-shape");
      expect(read.refusal.request).toBe(url(2));
    }
  });

  it("a non-2xx is refused http with the ARM code and greppable text", async () => {
    const body = { error: { code: "AuthorizationFailed", message: "no" } };
    const read = await readAllPages(new RoutedAzure({ [P]: [{ status: 403, body }] }), REQ, "exemptions at s1");
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.refusal.reason).toBe("http");
    expect(read.refusal.status).toBe(403);
    expect(read.refusal.code).toBe("AuthorizationFailed");
    expect(read.refusal.text).toContain("exemptions at s1: HTTP 403");
  });

  it("a rejection resolves as transport, never throws", async () => {
    const read = await readAllPages(new RoutedAzure({ [P]: [new Error("ECONNRESET")] }), REQ, "x");
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.refusal.reason).toBe("transport");
    expect(read.refusal.status).toBeNull();
    expect(read.refusal.text).toContain("ECONNRESET");
  });

  it("a rejection on page 2 is transport too", async () => {
    const azure = new RoutedAzure({
      [P]: [{ status: 200, body: { value: [1], nextLink: url(2) } }],
      [url(2)]: [new Error("socket hang up")],
    });
    const read = await readAllPages(azure, REQ, "x");
    expect(read.state === "refused" && read.refusal.reason).toBe("transport");
  });

  it("a nextLink with no requestUrl is refused 'pagination unavailable', not a first-page undercount", async () => {
    const inner = new RoutedAzure({ [P]: [{ status: 200, body: { value: [1], nextLink: url(2) } }] });
    const azure: AzureManagement = { request: (o) => inner.request(o) };
    const read = await readAllPages(azure, REQ, "x");
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.refusal.reason).toBe("too-many-pages");
    expect(read.refusal.text).toContain("pagination unavailable");
  });

  function chain(pages: number): RoutedAzure {
    const routes: Record<string, Answer[]> = {};
    for (let i = 1; i <= pages; i += 1) {
      const key = i === 1 ? P : url(i);
      const nextLink = i < pages ? url(i + 1) : "";
      routes[key] = [{ status: 200, body: { value: [i], nextLink } }];
    }
    return new RoutedAzure(routes);
  }

  it("reads exactly MAX_LIST_PAGES pages and refuses MAX_LIST_PAGES + 1 (boundary)", async () => {
    const atCap = await readAllPages(chain(MAX_LIST_PAGES), REQ, "x");
    expect(atCap.state).toBe("read");
    if (atCap.state === "read") expect(atCap.rows.length).toBe(MAX_LIST_PAGES);

    const over = chain(MAX_LIST_PAGES + 1);
    const read = await readAllPages(over, REQ, "x");
    expect(read.state === "refused" && read.refusal.reason).toBe("too-many-pages");
    expect(over.calls.length).toBe(MAX_LIST_PAGES);
  });
});

describe("readSingle", () => {
  it("an object body is read with that body as its one row", async () => {
    const read = await readSingle(new RoutedAzure({ [P]: [{ status: 200, body: { id: "a" } }] }), REQ, "x");
    expect(read).toEqual({ state: "read", rows: [{ id: "a" }] });
  });

  it("a non-object 2xx body is unexpected-shape; a 404 is http; a rejection is transport", async () => {
    const shape = await readSingle(new RoutedAzure({ [P]: [{ status: 200, body: null }] }), REQ, "x");
    expect(shape.state === "refused" && shape.refusal.reason).toBe("unexpected-shape");
    const http = await readSingle(new RoutedAzure({ [P]: [{ status: 404, body: {} }] }), REQ, "x");
    expect(http.state === "refused" && http.refusal.status).toBe(404);
    const transport = await readSingle(new RoutedAzure({ [P]: [new Error("boom")] }), REQ, "x");
    expect(transport.state === "refused" && transport.refusal.reason).toBe("transport");
  });
});
