/**
 * A stateful in-memory leader for the routing-table write tests (DBT-301):
 * one worker group's routing table, its pending files, git HEAD, and the
 * deploy. Every request is logged as `METHOD /m/<g>/path?query` (leader calls
 * without the /m/ prefix), so a test pins the exact call order.
 *
 * THE FIXTURE is the shape measured live on 2026-11-10: GET /m/<g>/routes
 * answered `{items:[{id, groups, routes:[...]}], count:1}`. `groups` is
 * non-empty here on purpose, so a write that drops it is caught.
 */

import type { CriblClient, CriblRequest } from "../../ports/cribl-client";
import type { PortHttpResponse } from "../../ports/http";

export const G = "g1";
export const HASH = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
export const ROUTE_FILE = `groups/${G}/local/cribl/pipelines/route.yml`;

/** A routing table as the leader holds it, with routes another admin owns. */
export function measuredTable(): Record<string, unknown> {
  return {
    id: "default",
    groups: {
      Gx1aB2: { name: "Security sources", description: "owned by the SOC team", disabled: false, index: 1 },
    },
    comments: [{ id: "c1", comment: "Do not reorder without change control", index: 0 }],
    routes: [
      {
        id: "r_fw",
        name: "Firewall",
        filter: "__inputId.startsWith('syslog:in_fw:')",
        pipeline: "fw_pipeline",
        output: "splunk_out",
        final: true,
        disabled: false,
        groupId: "Gx1aB2",
        enableOutputExpression: false,
      },
      {
        id: "r_okta",
        name: "Okta",
        filter: "__inputId.startsWith('http:in_okta:')",
        pipeline: "passthru",
        output: "s3_archive",
        final: false,
        clones: [{ env: "prod" }],
      },
      {
        id: "r_complex",
        name: "Complex",
        filter: "sourcetype=='pan:traffic' && host.startsWith('fw')",
        pipeline: "main",
        output: "devnull",
        final: true,
      },
      { id: "default", name: "default", filter: "true", pipeline: "main", output: "default", final: true },
    ],
  };
}

type Hook = (req: CriblRequest, leader: FakeRoutesLeader) => PortHttpResponse | undefined;

export class FakeRoutesLeader implements CriblClient {
  table: Record<string, unknown> = measuredTable();
  /** Paths `/version/status` reports as modified. */
  pending: string[] = [];
  head = "0000000000000000000000000000000000000000";
  /** Override the listing body (GET /routes), e.g. an unexpected shape. */
  listingBody: unknown = undefined;
  /** A PATCH is accepted (200) but NOT stored: the read-back shows the old table. */
  dropWrites = false;
  /** Runs before the default handling; a response it returns is served instead. */
  hooks: Hook[] = [];
  readonly log: string[] = [];
  readonly requests: CriblRequest[] = [];

  label(r: CriblRequest): string {
    const q = r.query ? `?${Object.entries(r.query).map(([k, v]) => `${k}=${v}`).join("&")}` : "";
    return `${r.method} ${r.groupId === undefined ? "" : `/m/${r.groupId}`}${r.path}${q}`;
  }

  /** Every non-GET call, labelled. */
  writes(): string[] {
    return this.log.filter((l) => !l.startsWith("GET "));
  }

  /** The body of the last PATCH to the routing table, or undefined. */
  lastPatch(): Record<string, unknown> | undefined {
    for (let i = this.requests.length - 1; i >= 0; i--) {
      const r = this.requests[i]!;
      if (r.method === "PATCH" && r.path.startsWith("/routes/")) return r.body as Record<string, unknown>;
    }
    return undefined;
  }

  async request(req: CriblRequest): Promise<PortHttpResponse> {
    this.log.push(this.label(req));
    this.requests.push(req);
    for (const hook of this.hooks) {
      const answer = hook(req, this);
      if (answer !== undefined) return answer;
    }
    const tableId = String(this.table["id"]);
    const copy = () => structuredClone(this.table);
    if (req.groupId === G && req.method === "GET" && req.path === "/routes") {
      return { status: 200, body: this.listingBody !== undefined ? this.listingBody : { items: [copy()], count: 1 } };
    }
    if (req.groupId === G && req.path === `/routes/${tableId}`) {
      if (req.method === "GET") return { status: 200, body: { items: [copy()], count: 1 } };
      if (req.method === "PATCH") {
        if (!this.dropWrites) this.table = structuredClone(req.body as Record<string, unknown>);
        if (!this.pending.includes(ROUTE_FILE)) this.pending.push(ROUTE_FILE);
        return { status: 200, body: { items: [copy()], count: 1 } };
      }
    }
    if (req.groupId === G && req.method === "GET" && req.path === "/version/status") {
      return { status: 200, body: { items: [{ modified: [...this.pending] }] } };
    }
    if (req.groupId === G && req.method === "POST" && req.path === "/version/commit") {
      const files = (req.body as { files?: string[] }).files ?? [];
      this.pending = this.pending.filter((p) => !files.includes(p));
      this.head = HASH;
      return { status: 200, body: { items: [{ commit: HASH }] } };
    }
    if (req.groupId === G && req.method === "GET" && req.path === "/version") {
      return { status: 200, body: { items: [{ hash: this.head }] } };
    }
    if (req.groupId === undefined && req.method === "PATCH" && req.path === `/products/stream/groups/${G}/deploy`) {
      return { status: 200, body: {} };
    }
    throw new Error(`FakeRoutesLeader: unscripted ${this.label(req)}`);
  }

  async listGroups(): Promise<never> {
    throw new Error("FakeRoutesLeader: listGroups is not used here");
  }
}
