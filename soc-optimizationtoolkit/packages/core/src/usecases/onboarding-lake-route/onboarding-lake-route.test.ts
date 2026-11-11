/**
 * onboarding-lake-route (AZR-35) against route-insert's stateful fake leader,
 * which holds the MEASURED routes listing shape (fake-routes-leader.test-util),
 * extended here with the leader's Lake dataset listing and the group's
 * pipelines. Pins: the cloud-only gate, the plan's reads and refusals, the
 * write order, stop-on-failure naming what was created, and ONE commit that
 * carries the routes file and the new pipeline's files.
 */

import { describe, expect, it } from "vitest";
import { stampFor } from "../../kit/config-writes/ownership";
import { APP_ID } from "../../domain/cribl-secrets/secret-body";
import { buildUnrollPipelineBody } from "../../domain/onboarding-lake-route";
import type { CriblSourceRecord, LakeRouteRecord } from "../../domain/onboarding-howto/progress-document";
import type { RoutePosition } from "../../domain/routes-table";
import { FakeRoutesLeader, G, HASH, ROUTE_FILE } from "../route-insert/fake-routes-leader.test-util";
import {
  applyLakeRoute,
  lakeRouteGate,
  planLakeRoute,
  type PlanLakeRouteInput,
  type PlanLakeRouteResult,
  type ReadyLakeRoute,
} from "./index";

const DATASETS = "/products/lake/lakes/default/datasets";
const PIPE = "azure_onb_unroll_records";
const PIPE_FILE = `groups/${G}/local/cribl/pipelines/${PIPE}/conf.yml`;
const SOURCE: CriblSourceRecord = { groupId: G, inputId: "in_def", inputType: "eventhub", secretId: "s_def" };
const ROUTE_ID = "azure_onb_defender_alerts_lake";
const OUR_RECORD: LakeRouteRecord = { groupId: G, datasetId: "azure_activity_log", pipelineId: PIPE, routeId: "azure_onb_activity_log_lake" };

/** The routes leader plus a Lake dataset listing (leader) and the group's pipelines. */
class LakeLeader extends FakeRoutesLeader {
  datasets: string[] = [];
  pipelines: Record<string, unknown>[] = [{ id: "main", conf: { functions: [] } }, { id: "passthru", conf: { functions: [] } }];
  datasetPost: number | null = null;
  pipelinePost: number | null = null;
  /** Mutates what the pipeline POST stores, to simulate a server that changes the body. */
  storePipeline: (body: Record<string, unknown>) => Record<string, unknown> = (b) => b;

  constructor() {
    super();
    this.hooks.push((req) => {
      if (req.groupId === undefined && req.path === DATASETS) {
        if (req.method === "GET") return { status: 200, body: { items: this.datasets.map((id) => ({ id })), count: this.datasets.length } };
        if (req.method === "POST") {
          if (this.datasetPost !== null) return { status: this.datasetPost, body: {} };
          const id = String((req.body as { id: string }).id);
          if (this.datasets.includes(id)) return { status: 409, body: {} };
          this.datasets.push(id);
          return { status: 200, body: { items: [req.body], count: 1 } };
        }
      }
      if (req.groupId === G && req.path === "/pipelines") {
        if (req.method === "GET") return { status: 200, body: { items: structuredClone(this.pipelines), count: this.pipelines.length } };
        if (req.method === "POST") {
          if (this.pipelinePost !== null) return { status: this.pipelinePost, body: {} };
          const body = structuredClone(req.body as Record<string, unknown>);
          this.pipelines.push(this.storePipeline(body));
          this.pending.push(`groups/${G}/local/cribl/pipelines/${String(body["id"])}/conf.yml`);
          return { status: 200, body: { items: [body], count: 1 } };
        }
      }
      return undefined;
    });
  }
}

function input(over: Partial<PlanLakeRouteInput> = {}): PlanLakeRouteInput {
  return {
    sourceId: "defenderExport",
    criblSource: SOURCE,
    lakeRoutes: {},
    deploymentType: "cloud",
    position: { kind: "top" },
    ...over,
  };
}

function ready(r: PlanLakeRouteResult): ReadyLakeRoute {
  if (r.kind !== "ready") throw new Error(`expected ready, got ${r.kind}: ${"detail" in r ? r.detail : ""}`);
  return r.ready;
}

const PLAN_READS = [
  `GET ${DATASETS}`,
  `GET /m/${G}/pipelines`,
  `GET /m/${G}/routes`,
  `GET /m/${G}/routes/default`,
  `GET /m/${G}/version/status`,
];

describe("lakeRouteGate - pure", () => {
  it("is Cribl.Cloud only: onprem and an undeclared deployment are refused with the reason", () => {
    for (const deploymentType of ["onprem", undefined] as const) {
      const g = lakeRouteGate({ sourceId: "activityLog", criblSource: SOURCE, deploymentType });
      expect(g?.reason).toBe("not-cloud");
      expect(g?.detail).toContain("Cribl.Cloud only");
    }
  });

  it("needs the source's Cribl input first", () => {
    const g = lakeRouteGate({ sourceId: "activityLog", criblSource: null, deploymentType: "cloud" });
    expect(g).toMatchObject({ reason: "no-cribl-source" });
    expect(g?.detail).toContain("Create the Cribl source first");
  });

  it("offers nothing for another source", () => {
    expect(lakeRouteGate({ sourceId: "entraId", criblSource: SOURCE, deploymentType: "cloud" })?.reason).toBe("not-a-lake-source");
    expect(lakeRouteGate({ sourceId: "defenderExport", criblSource: SOURCE, deploymentType: "cloud" })).toBeNull();
  });
});

describe("planLakeRoute - read-only", () => {
  it("a refused gate makes no call at all", async () => {
    const leader = new LakeLeader();
    const r = await planLakeRoute({ cribl: leader }, input({ deploymentType: "onprem" }));
    expect(r).toMatchObject({ kind: "refused", reason: "not-cloud" });
    expect(leader.log).toEqual([]);
  });

  it("plans dataset + pipeline creates and the route at the top; GETs only, in order", async () => {
    const leader = new LakeLeader();
    const r = ready(await planLakeRoute({ cribl: leader }, input()));
    expect(leader.log).toEqual(PLAN_READS);
    expect(r.dataset).toEqual({ id: "azure_defender_alerts", action: "create" });
    expect(r.pipeline).toEqual({ id: PIPE, action: "create" });
    expect(r.route).toMatchObject({
      id: ROUTE_ID,
      filter: "__inputId=='eventhub:in_def'",
      pipeline: PIPE,
      output: "cribl_lake:azure_defender_alerts",
      final: true,
    });
    expect(r.insert.index).toBe(0);
    expect(r.insert.table.rows.map((x) => x.id)).toEqual(["r_fw", "r_okta", "r_complex", "default"]);
    // The commit names the routes file AND the new pipeline's directory.
    expect(r.insert.commitFiles).toEqual([ROUTE_FILE, `groups/${G}/local/cribl/pipelines/${PIPE}/`]);
  });

  it("an existing dataset is reused (said in the confirm), never recreated", async () => {
    const leader = new LakeLeader();
    leader.datasets = ["azure_defender_alerts"];
    expect(ready(await planLakeRoute({ cribl: leader }, input())).dataset.action).toBe("reuse");
  });

  it("an unreadable dataset listing refuses; nothing further is read", async () => {
    const leader = new LakeLeader();
    leader.hooks.unshift((req) => (req.path === DATASETS ? { status: 403, body: {} } : undefined));
    const r = await planLakeRoute({ cribl: leader }, input());
    expect(r).toMatchObject({ kind: "refused", reason: "datasets-unreadable" });
    expect(leader.log).toEqual([`GET ${DATASETS}`]);
  });

  it("a pipeline with our id that the app cannot prove it created is REFUSED", async () => {
    const leader = new LakeLeader();
    leader.pipelines.push(structuredClone(buildUnrollPipelineBody()) as unknown as Record<string, unknown>);
    // Stamped and in the manifest, but no KV record: not provably ours.
    const r = await planLakeRoute({ cribl: leader }, input());
    expect(r).toMatchObject({ kind: "refused", reason: "pipeline-foreign" });
    if (r.kind === "refused") expect(r.detail).toContain("no record of writing it");
    expect(leader.log).toEqual([`GET ${DATASETS}`, `GET /m/${G}/pipelines`]);
  });

  it("an owned pipeline that was edited is REFUSED with the differing fields, never rewritten", async () => {
    const leader = new LakeLeader();
    const edited = structuredClone(buildUnrollPipelineBody()) as unknown as { conf: { functions: { conf: { path: string } }[] } };
    edited.conf.functions[0]!.conf.path = "data";
    leader.pipelines.push(edited as unknown as Record<string, unknown>);
    const r = await planLakeRoute({ cribl: leader }, input({ lakeRoutes: { activityLog: OUR_RECORD } }));
    expect(r).toMatchObject({ kind: "refused", reason: "pipeline-differs" });
    if (r.kind === "refused") {
      expect(r.differences?.map((d) => d.path)).toEqual(["conf.functions[0].conf.path"]);
      expect(r.detail).toContain("conf.functions[0].conf.path");
    }
    expect(leader.writes()).toEqual([]);
  });

  it("an owned, unchanged pipeline is reused, and then the commit does NOT carry its files", async () => {
    const leader = new LakeLeader();
    leader.pipelines.push(structuredClone(buildUnrollPipelineBody()) as unknown as Record<string, unknown>);
    const r = ready(await planLakeRoute({ cribl: leader }, input({ lakeRoutes: { activityLog: OUR_RECORD } })));
    expect(r.pipeline.action).toBe("reuse");
    expect(r.insert.commitFiles).toEqual([ROUTE_FILE]);
  });

  it("a record in ANOTHER group is not ownership evidence here", async () => {
    const leader = new LakeLeader();
    leader.pipelines.push(structuredClone(buildUnrollPipelineBody()) as unknown as Record<string, unknown>);
    const r = await planLakeRoute({ cribl: leader }, input({ lakeRoutes: { activityLog: { ...OUR_RECORD, groupId: "other" } } }));
    expect(r).toMatchObject({ kind: "refused", reason: "pipeline-foreign" });
  });

  it("an EQUAL FILTER already in the table is refused, naming the route and where it sends", async () => {
    const leader = new LakeLeader();
    (leader.table["routes"] as unknown[]).splice(1, 0, {
      id: "theirs",
      name: "Defender to S3",
      filter: "__inputId=='eventhub:in_def'",
      pipeline: "main",
      output: "s3_archive",
      final: true,
    });
    const r = await planLakeRoute({ cribl: leader }, input());
    expect(r).toMatchObject({ kind: "refused", reason: "conflicts" });
    if (r.kind === "refused") {
      expect(r.conflicts?.map((c) => c.existing.id)).toEqual(["theirs"]);
      expect(r.detail).toContain("theirs");
      expect(r.detail).toContain("s3_archive");
      expect(r.table?.rows.map((x) => x.id)).toContain("theirs");
    }
    expect(leader.writes()).toEqual([]);
  });

  it.each<[RoutePosition, number, string[]]>([
    [{ kind: "before", routeId: "r_complex" }, 2, []],
    [{ kind: "end" }, 4, ["default"]],
  ])("the operator's position %j lands at %i, with shadowedBy", async (position, index, shadow) => {
    const leader = new LakeLeader();
    const r = ready(await planLakeRoute({ cribl: leader }, input({ position })));
    expect(r.insert.index).toBe(index);
    expect(r.insert.shadowedBy.map((x) => x.id)).toEqual(shadow);
  });

  it("the app's own recorded route already in the table is already-applied, not a conflict", async () => {
    const leader = new LakeLeader();
    (leader.table["routes"] as unknown[]).unshift({ id: ROUTE_ID, filter: "__inputId=='eventhub:in_def'", pipeline: PIPE, output: "cribl_lake:azure_defender_alerts", final: true });
    const r = await planLakeRoute({ cribl: leader }, input({ lakeRoutes: { defenderExport: { groupId: G, datasetId: "azure_defender_alerts", pipelineId: null, routeId: ROUTE_ID } } }));
    expect(r.kind).toBe("already-applied");
  });

  it("the same route WITHOUT the app's record is a conflict (the app never claims a route it cannot prove)", async () => {
    const leader = new LakeLeader();
    (leader.table["routes"] as unknown[]).unshift({ id: ROUTE_ID, filter: "__inputId=='eventhub:in_def'", pipeline: PIPE, output: "cribl_lake:azure_defender_alerts", final: true });
    expect(await planLakeRoute({ cribl: leader }, input())).toMatchObject({ kind: "refused", reason: "conflicts" });
  });
});

describe("applyLakeRoute - order, one commit, stop on failure", () => {
  async function planned(leader: LakeLeader, over: Partial<PlanLakeRouteInput> = {}): Promise<ReadyLakeRoute> {
    const r = ready(await planLakeRoute({ cribl: leader }, input(over)));
    leader.log.length = 0;
    leader.requests.length = 0;
    return r;
  }

  it("dataset -> pipeline -> route, then ONE commit with the routes file and the pipeline file, then deploy", async () => {
    const leader = new LakeLeader();
    const r = await planned(leader);
    const outcome = await applyLakeRoute({ cribl: leader }, r);
    expect(outcome).toMatchObject({ kind: "deployed", stage: null, dataset: "created", pipeline: "created" });
    expect(leader.log).toEqual([
      `GET /m/${G}/version/status`,
      `GET ${DATASETS}`,
      `POST ${DATASETS}`,
      `GET ${DATASETS}`,
      `GET /m/${G}/pipelines`,
      `POST /m/${G}/pipelines`,
      `GET /m/${G}/pipelines`,
      `GET /m/${G}/version/status`,
      `GET /m/${G}/routes/default`,
      `PATCH /m/${G}/routes/default`,
      `GET /m/${G}/routes/default`,
      `GET /m/${G}/version/status`,
      `POST /m/${G}/version/commit`,
      `GET /m/${G}/version/status`,
      `GET /m/${G}/version?offset=0&limit=1`,
      `PATCH /products/stream/groups/${G}/deploy`,
    ]);
    const commits = leader.requests.filter((q) => q.method === "POST" && q.path === "/version/commit");
    expect(commits).toHaveLength(1);
    expect((commits[0]!.body as { files: string[] }).files.sort()).toEqual([PIPE_FILE, ROUTE_FILE].sort());
    // What was sent: the stamped pipeline, the dataset, the route at the top.
    const pipePost = leader.requests.find((q) => q.method === "POST" && q.path === "/pipelines")!;
    expect(pipePost.body).toEqual(buildUnrollPipelineBody());
    const dsPost = leader.requests.find((q) => q.method === "POST" && q.path === DATASETS)!;
    expect(dsPost.body).toMatchObject({ id: "azure_defender_alerts" });
    expect(String((dsPost.body as { description: string }).description)).toContain(stampFor(APP_ID));
    expect((leader.lastPatch()!["routes"] as Array<{ id: string }>)[0]!.id).toBe(ROUTE_ID);
    expect(outcome.record).toEqual({ groupId: G, datasetId: "azure_defender_alerts", pipelineId: PIPE, routeId: ROUTE_ID });
    expect(outcome.detail).toContain(HASH);
  });

  it("a dataset create that fails STOPS: no pipeline, no route, nothing recorded", async () => {
    const leader = new LakeLeader();
    const r = await planned(leader);
    leader.datasetPost = 500;
    const outcome = await applyLakeRoute({ cribl: leader }, r);
    expect(outcome).toMatchObject({ kind: "stopped", stage: "dataset", dataset: "failed", pipeline: "not-reached", route: null, record: null });
    expect(leader.writes()).toEqual([`POST ${DATASETS}`]);
    expect(outcome.detail).toContain("HTTP 500");
  });

  it("a 409 on the dataset create means it exists: used as it is, and the apply continues", async () => {
    const leader = new LakeLeader();
    const r = await planned(leader);
    leader.datasetPost = 409;
    const outcome = await applyLakeRoute({ cribl: leader }, r);
    expect(outcome).toMatchObject({ kind: "deployed", dataset: "existed" });
  });

  it("a pipeline create that fails STOPS after the dataset, and the outcome names the dataset as created", async () => {
    const leader = new LakeLeader();
    const r = await planned(leader);
    leader.pipelinePost = 400;
    const outcome = await applyLakeRoute({ cribl: leader }, r);
    expect(outcome).toMatchObject({ kind: "stopped", stage: "pipeline", dataset: "created", pipeline: "failed", route: null });
    expect(outcome.detail).toContain("Cribl Lake dataset azure_defender_alerts was created.");
    expect(outcome.record).toEqual({ groupId: G, datasetId: "azure_defender_alerts", pipelineId: null, routeId: null });
    expect(leader.writes()).toEqual([`POST ${DATASETS}`, `POST /m/${G}/pipelines`]);
  });

  it("a pipeline read-back that differs is created-not-verified: no route, no commit", async () => {
    const leader = new LakeLeader();
    const r = await planned(leader);
    leader.storePipeline = (b) => ({ ...b, conf: { ...(b["conf"] as object), functions: [] } });
    const outcome = await applyLakeRoute({ cribl: leader }, r);
    expect(outcome).toMatchObject({ kind: "stopped", stage: "pipeline", pipeline: "created-not-verified" });
    expect(outcome.detail).toContain("conf.functions");
    expect(leader.writes().some((w) => w.includes("/routes/") || w.includes("/version/commit"))).toBe(false);
    expect(outcome.record?.pipelineId).toBe(PIPE);
  });

  it("a pipeline that appeared since the confirm STOPS before creating anything of its own", async () => {
    const leader = new LakeLeader();
    const r = await planned(leader);
    leader.pipelines.push({ id: PIPE, conf: { description: "someone else's", functions: [] } });
    const outcome = await applyLakeRoute({ cribl: leader }, r);
    expect(outcome).toMatchObject({ kind: "stopped", stage: "pipeline", pipeline: "failed" });
    expect(leader.writes()).toEqual([`POST ${DATASETS}`]);
  });

  it("a route table that moved after the confirm voids the route; the pipeline is said to be uncommitted", async () => {
    const leader = new LakeLeader();
    const r = await planned(leader);
    (leader.table["routes"] as unknown[]).push({ id: "late", filter: "__inputId=='http:x'", output: "o" });
    const outcome = await applyLakeRoute({ cribl: leader }, r);
    expect(outcome).toMatchObject({ kind: "void", stage: "route", dataset: "created", pipeline: "created" });
    expect(outcome.route?.kind).toBe("void");
    expect(outcome.detail).toContain("not committed");
    expect(leader.writes().some((w) => w.startsWith("PATCH /m/"))).toBe(false);
    expect(outcome.record).toEqual({ groupId: G, datasetId: "azure_defender_alerts", pipelineId: PIPE, routeId: null });
  });

  it("new pending work in a committed file since the confirm voids BEFORE any write", async () => {
    const leader = new LakeLeader();
    const r = await planned(leader);
    leader.pending = [ROUTE_FILE];
    const outcome = await applyLakeRoute({ cribl: leader }, r);
    expect(outcome).toMatchObject({ kind: "void", stage: "scope", dataset: "not-reached", record: null });
    expect(leader.writes()).toEqual([]);
  });

  it("reusing an owned pipeline writes no pipeline and commits the routes file only", async () => {
    const leader = new LakeLeader();
    leader.pipelines.push(structuredClone(buildUnrollPipelineBody()) as unknown as Record<string, unknown>);
    leader.datasets = ["azure_defender_alerts"];
    const r = await planned(leader, { lakeRoutes: { activityLog: OUR_RECORD } });
    const outcome = await applyLakeRoute({ cribl: leader }, r);
    expect(outcome).toMatchObject({ kind: "deployed", dataset: "existed", pipeline: "reused" });
    expect(leader.writes().filter((w) => w.startsWith("POST /products") || w === `POST /m/${G}/pipelines`)).toEqual([]);
    const commit = leader.requests.find((q) => q.method === "POST" && q.path === "/version/commit")!;
    expect(commit.body).toMatchObject({ files: [ROUTE_FILE] });
    expect(outcome.record).toEqual({ groupId: G, datasetId: "azure_defender_alerts", pipelineId: PIPE, routeId: ROUTE_ID });
  });
});
