/**
 * onboarding-teardown (AZR-105) against route-insert's stateful fake leader,
 * extended with the group's sources, secrets and pipelines and the leader's
 * Lake datasets, each DELETE dirtying the file it would on disk (the markers
 * are the create path's, unmeasured). Pins: the plan's reads, the exact write
 * order (route, pipeline, input, secret, commit, then the dataset), refusals
 * and stops, a 403 said as a permission refusal, already-gone as success,
 * and which records survive.
 */

import { describe, expect, it } from "vitest";
import { UNROLL_PIPELINE_DESCRIPTION, UNROLL_PIPELINE_ID } from "../../domain/onboarding-lake-route";
import type { CriblSourceRecord, LakeRouteRecord } from "../../domain/onboarding-howto/progress-document";
import { FakeRoutesLeader, G, HASH, ROUTE_FILE } from "../route-insert/fake-routes-leader.test-util";
import {
  applyInputPause,
  applySourceTeardown,
  planInputPause,
  planSourceTeardown,
  type PlanTeardownInput,
  type PlanTeardownResult,
  type ReadyTeardown,
} from "./index";

const STAMP = "[managed-by:soc-optimizationtoolkit]";
const DATASETS = "/products/lake/lakes/default/datasets";
const INPUT_ID = "azure_onb_eh_abcd1234_ns1_activityLog";
const SECRET_ID = `${INPUT_ID}_secret`;
const ROUTE_ID = "azure_onb_activity_log_lake";
const DATASET_ID = "azure_activity_log";
const INPUTS_FILE = `groups/${G}/local/cribl/inputs.yml`;
const SECRETS_FILE = `groups/${G}/local/cribl/secrets.yml`;
const PIPE_FILE = `groups/${G}/local/cribl/pipelines/${UNROLL_PIPELINE_ID}/conf.yml`;

const SOURCE: CriblSourceRecord = { groupId: G, inputId: INPUT_ID, inputType: "eventhub", secretId: SECRET_ID };
const LAKE: LakeRouteRecord = { groupId: G, datasetId: DATASET_ID, pipelineId: UNROLL_PIPELINE_ID, routeId: ROUTE_ID, datasetCreated: true };

class TeardownLeader extends FakeRoutesLeader {
  inputs: Record<string, unknown>[] = [
    { id: INPUT_ID, type: "eventhub", disabled: false, description: `Azure onboarding ${STAMP}`, sasl: { textSecret: SECRET_ID }, topics: ["insights-activity-logs"] },
    { id: "in_syslog", type: "syslog" },
  ];
  secrets: Record<string, unknown>[] = [{ id: SECRET_ID, secretType: "text", description: `secret ${STAMP}` }];
  pipelines: Record<string, unknown>[] = [{ id: UNROLL_PIPELINE_ID, conf: { description: UNROLL_PIPELINE_DESCRIPTION } }, { id: "main", conf: {} }];
  datasets: Record<string, unknown>[] = [{ id: DATASET_ID, description: `Azure onboarding ${STAMP}` }];
  /** Status to answer a DELETE with, by path; default deletes. */
  deleteStatus: Record<string, number> = {};

  constructor() {
    super();
    (this.table["routes"] as unknown[]).unshift({
      id: ROUTE_ID,
      name: "Azure onboarding: Activity Log to Cribl Lake",
      filter: `__inputId=='eventhub:${INPUT_ID}'`,
      pipeline: UNROLL_PIPELINE_ID,
      output: `cribl_lake:${DATASET_ID}`,
      final: true,
      description: `Activity Log ${STAMP}`,
    });
    this.hooks.push((req) => {
      const del = (list: Record<string, unknown>[], id: string, file: string | null) => {
        const forced = this.deleteStatus[req.path];
        if (forced !== undefined) return { status: forced, body: {} };
        const at = list.findIndex((x) => x["id"] === id);
        if (at < 0) return { status: 404, body: {} };
        list.splice(at, 1);
        if (file !== null && !this.pending.includes(file)) this.pending.push(file);
        return { status: 200, body: {} };
      };
      if (req.groupId === G && req.path === "/system/inputs" && req.method === "GET") {
        return { status: 200, body: { items: structuredClone(this.inputs), count: this.inputs.length } };
      }
      if (req.groupId === G && req.path.startsWith("/system/inputs/")) {
        const id = decodeURIComponent(req.path.slice("/system/inputs/".length));
        if (req.method === "DELETE") return del(this.inputs, id, INPUTS_FILE);
        if (req.method === "GET") {
          const found = this.inputs.find((x) => x["id"] === id);
          return found === undefined ? { status: 404, body: {} } : { status: 200, body: { items: [structuredClone(found)], count: 1 } };
        }
        if (req.method === "PATCH") {
          const at = this.inputs.findIndex((x) => x["id"] === id);
          this.inputs[at] = structuredClone(req.body as Record<string, unknown>);
          if (!this.pending.includes(INPUTS_FILE)) this.pending.push(INPUTS_FILE);
          return { status: 200, body: { items: [req.body], count: 1 } };
        }
      }
      if (req.groupId === G && req.path.startsWith("/system/secrets/")) {
        const id = decodeURIComponent(req.path.slice("/system/secrets/".length));
        if (req.method === "GET") {
          const found = this.secrets.filter((x) => x["id"] === id);
          return found.length === 0 ? { status: 404, body: {} } : { status: 200, body: { items: structuredClone(found), count: 1 } };
        }
        if (req.method === "DELETE") return del(this.secrets, id, SECRETS_FILE);
      }
      if (req.groupId === G && req.path === "/pipelines" && req.method === "GET") {
        return { status: 200, body: { items: structuredClone(this.pipelines), count: this.pipelines.length } };
      }
      if (req.groupId === G && req.path.startsWith("/pipelines/") && req.method === "DELETE") {
        const id = decodeURIComponent(req.path.slice("/pipelines/".length));
        return del(this.pipelines, id, `groups/${G}/local/cribl/pipelines/${id}/conf.yml`);
      }
      if (req.groupId === undefined && req.path === DATASETS && req.method === "GET") {
        return { status: 200, body: { items: structuredClone(this.datasets), count: this.datasets.length } };
      }
      if (req.groupId === undefined && req.path.startsWith(`${DATASETS}/`) && req.method === "DELETE") {
        return del(this.datasets, decodeURIComponent(req.path.slice(DATASETS.length + 1)), null);
      }
      return undefined;
    });
  }
}

function input(over: Partial<PlanTeardownInput> = {}): PlanTeardownInput {
  return { sourceId: "activityLog", criblSource: SOURCE, lakeRoute: LAKE, otherLakeRoutes: [], removeDataset: true, ...over };
}

function ready(r: PlanTeardownResult): ReadyTeardown {
  if (r.kind !== "ready") throw new Error(`expected ready, got ${r.kind}: ${"detail" in r ? r.detail : ""}`);
  return r.ready;
}

describe("planSourceTeardown - read-only", () => {
  it("reads, plans every object and names the commit, writing nothing", async () => {
    const leader = new TeardownLeader();
    const r = ready(await planSourceTeardown({ cribl: leader }, input()));
    expect(leader.log).toEqual([
      `GET /m/${G}/system/inputs`,
      `GET /m/${G}/routes`,
      `GET /m/${G}/system/secrets/${SECRET_ID}`,
      `GET /m/${G}/pipelines`,
      `GET ${DATASETS}`,
      `GET /m/${G}/routes/default`,
      `GET /m/${G}/version/status`,
    ]);
    expect(r.steps.map((s) => `${s.kind}:${s.verdict.kind}`)).toEqual(["route:delete", "pipeline:delete", "input:delete", "secret:delete", "dataset:delete"]);
    expect(r.commitFiles).toEqual([
      ROUTE_FILE,
      `groups/${G}/local/cribl/pipelines/${UNROLL_PIPELINE_ID}/`,
      INPUTS_FILE,
      SECRETS_FILE,
      `groups/${G}/local/cribl/auth/cribl.secret`,
    ]);
    // The approved diff removes exactly our route.
    expect(r.routeWrite?.routes.map((x) => (x as { id: string }).id)).toEqual(["r_fw", "r_okta", "r_complex", "default"]);
  });

  it("everything already gone is nothing-to-remove, and every record goes", async () => {
    const leader = new TeardownLeader();
    leader.inputs = [];
    leader.secrets = [];
    leader.pipelines = [];
    leader.datasets = [];
    (leader.table["routes"] as unknown[]).shift();
    const r = await planSourceTeardown({ cribl: leader }, input());
    expect(r).toMatchObject({ kind: "nothing-to-remove", records: { criblSource: null, lakeRoute: null } });
    expect(leader.writes()).toEqual([]);
  });

  it("a 403 on the sources list refuses, said as a permission refusal", async () => {
    const leader = new TeardownLeader();
    leader.hooks.unshift((req) => (req.path === "/system/inputs" && req.method === "GET" ? { status: 403, body: {} } : undefined));
    const r = await planSourceTeardown({ cribl: leader }, input());
    expect(r).toMatchObject({ kind: "refused", reason: "inputs-unreadable", denied: true });
  });
});

describe("applySourceTeardown", () => {
  it("removes in teardown order, commits the group change once, THEN deletes the dataset", async () => {
    const leader = new TeardownLeader();
    const r = ready(await planSourceTeardown({ cribl: leader }, input()));
    const outcome = await applySourceTeardown({ cribl: leader }, r);
    expect(leader.writes()).toEqual([
      `PATCH /m/${G}/routes/default`,
      `DELETE /m/${G}/pipelines/${UNROLL_PIPELINE_ID}`,
      `DELETE /m/${G}/system/inputs/${INPUT_ID}`,
      `DELETE /m/${G}/system/secrets/${SECRET_ID}`,
      `POST /m/${G}/version/commit`,
      `PATCH /products/stream/groups/${G}/deploy`,
      `DELETE ${DATASETS}/${DATASET_ID}`,
    ]);
    const commit = leader.requests.find((q) => q.method === "POST" && q.path === "/version/commit")!;
    expect((commit.body as { files: string[] }).files.sort()).toEqual([ROUTE_FILE, PIPE_FILE, INPUTS_FILE, SECRETS_FILE].sort());
    // The routes write sent every other route and key back.
    const patch = leader.lastPatch()!;
    expect((patch["routes"] as Array<{ id: string }>).map((x) => x.id)).toEqual(["r_fw", "r_okta", "r_complex", "default"]);
    expect(patch["groups"]).toEqual({ Gx1aB2: { name: "Security sources", description: "owned by the SOC team", disabled: false, index: 1 } });
    expect(outcome.kind).toBe("removed");
    expect(outcome.steps.map((s) => `${s.kind}:${s.result}`)).toEqual(["route:removed", "pipeline:removed", "input:removed", "secret:removed", "dataset:removed"]);
    expect(outcome.commit.kind).toBe("deployed");
    expect(outcome.detail).toContain(HASH);
    expect(outcome.records).toEqual({ criblSource: null, lakeRoute: null });
  });

  it("without the dataset opt-in the dataset is never deleted, and stays recorded", async () => {
    const leader = new TeardownLeader();
    const r = ready(await planSourceTeardown({ cribl: leader }, input({ removeDataset: false })));
    const outcome = await applySourceTeardown({ cribl: leader }, r);
    expect(leader.writes().some((w) => w.startsWith("DELETE /products"))).toBe(false);
    expect(outcome.kind).toBe("removed");
    expect(outcome.records.lakeRoute).toEqual({ groupId: G, datasetId: DATASET_ID, pipelineId: null, routeId: null, datasetCreated: true });
  });

  it("a 403 on a DELETE stops there, says permission, still commits what went, and skips the dataset", async () => {
    const leader = new TeardownLeader();
    const r = ready(await planSourceTeardown({ cribl: leader }, input()));
    leader.deleteStatus[`/system/inputs/${INPUT_ID}`] = 403;
    const outcome = await applySourceTeardown({ cribl: leader }, r);
    expect(outcome.kind).toBe("stopped");
    expect(outcome.steps.map((s) => `${s.kind}:${s.result}`)).toEqual(["route:removed", "pipeline:removed", "input:failed", "secret:not-reached", "dataset:not-reached"]);
    const failed = outcome.steps.find((s) => s.kind === "input")!;
    expect(failed.denied).toBe(true);
    expect(failed.detail).toBe(`Cribl refused removing cribl source ${INPUT_ID} (HTTP 403): this account may lack the permission. It was not removed.`);
    const commit = leader.requests.find((q) => q.method === "POST" && q.path === "/version/commit")!;
    expect((commit.body as { files: string[] }).files.sort()).toEqual([ROUTE_FILE, PIPE_FILE].sort());
    expect(leader.writes().some((w) => w.startsWith("DELETE /products"))).toBe(false);
    // The source stays recorded (it is still there); the route and pipeline do not.
    expect(outcome.records).toEqual({
      criblSource: SOURCE,
      lakeRoute: { groupId: G, datasetId: DATASET_ID, pipelineId: null, routeId: null, datasetCreated: true },
    });
  });

  it("a deploy that fails keeps the dataset (a deployed route may still send to it) and every group record", async () => {
    const leader = new TeardownLeader();
    const r = ready(await planSourceTeardown({ cribl: leader }, input()));
    leader.hooks.unshift((req) => (req.method === "PATCH" && req.path.endsWith("/deploy") ? { status: 500, body: {} } : undefined));
    const outcome = await applySourceTeardown({ cribl: leader }, r);
    expect(outcome.kind).toBe("stopped");
    expect(outcome.commit.kind).toBe("deploy-failed");
    expect(outcome.steps.find((s) => s.kind === "dataset")).toMatchObject({
      result: "not-reached",
      detail: `Cribl Lake dataset ${DATASET_ID} was kept: the route change was not deployed, so a deployed route may still send to it.`,
    });
    expect(leader.writes().some((w) => w.startsWith("DELETE /products"))).toBe(false);
    expect(outcome.records).toEqual({ criblSource: SOURCE, lakeRoute: LAKE });
  });

  it("an object removed by someone else meanwhile is already gone: success, no DELETE sent", async () => {
    const leader = new TeardownLeader();
    const r = ready(await planSourceTeardown({ cribl: leader }, input({ removeDataset: false })));
    leader.secrets = [];
    const outcome = await applySourceTeardown({ cribl: leader }, r);
    expect(outcome.steps.find((s) => s.kind === "secret")?.result).toBe("already-gone");
    expect(leader.writes().some((w) => w.includes("/system/secrets/"))).toBe(false);
    expect(outcome.kind).toBe("removed");
    expect(outcome.records.criblSource).toBeNull();
  });

  it("new pending work in a committed file since the confirm voids BEFORE any write", async () => {
    const leader = new TeardownLeader();
    const r = ready(await planSourceTeardown({ cribl: leader }, input()));
    leader.pending = [INPUTS_FILE];
    const outcome = await applySourceTeardown({ cribl: leader }, r);
    expect(outcome.kind).toBe("void");
    expect(leader.writes()).toEqual([]);
    expect(outcome.records).toEqual({ criblSource: SOURCE, lakeRoute: LAKE });
  });

  it("a routing table that moved since the confirm voids: nothing is written", async () => {
    const leader = new TeardownLeader();
    const r = ready(await planSourceTeardown({ cribl: leader }, input()));
    (leader.table["routes"] as unknown[]).push({ id: "late", filter: "true", output: "o" });
    const outcome = await applySourceTeardown({ cribl: leader }, r);
    expect(outcome.kind).toBe("void");
    expect(leader.writes()).toEqual([]);
  });

  it("a source someone started to use since the confirm is kept, and the run stops there", async () => {
    const leader = new TeardownLeader();
    const r = ready(await planSourceTeardown({ cribl: leader }, input({ removeDataset: false })));
    leader.inputs.push({ id: "in_borrower", type: "eventhub", sasl: { textSecret: SECRET_ID } });
    const outcome = await applySourceTeardown({ cribl: leader }, r);
    expect(outcome.kind).toBe("stopped");
    expect(outcome.steps.find((s) => s.kind === "secret")?.result).toBe("kept");
    expect(leader.writes().some((w) => w.includes("/system/secrets/"))).toBe(false);
    // The route, pipeline and input that did go are committed.
    expect(leader.writes()).toContain(`POST /m/${G}/version/commit`);
  });
});

describe("input pause", () => {
  it("plans read-only and applies a PATCH of the whole source with disabled set, then commits", async () => {
    const leader = new TeardownLeader();
    const planned = await planInputPause({ cribl: leader }, { record: SOURCE, pause: true });
    if (planned.kind !== "ready") throw new Error(planned.detail);
    expect(leader.writes()).toEqual([]);
    expect(planned.ready.diff).toEqual([{ path: "disabled", from: false, to: true }]);
    const outcome = await applyInputPause({ cribl: leader }, planned.ready);
    expect(outcome.kind).toBe("deployed");
    expect(leader.writes()).toEqual([`PATCH /m/${G}/system/inputs/${INPUT_ID}`, `POST /m/${G}/version/commit`, `PATCH /products/stream/groups/${G}/deploy`]);
    const patch = leader.requests.find((q) => q.method === "PATCH" && q.path.startsWith("/system/inputs/"))!;
    // Full replacement: every key round-trips, only disabled changes.
    expect(patch.body).toEqual({ ...leader.inputs[0], disabled: true });
    expect((patch.body as Record<string, unknown>)["topics"]).toEqual(["insights-activity-logs"]);
  });

  it("refuses an input the app cannot prove, and writes nothing", async () => {
    const leader = new TeardownLeader();
    leader.inputs[0] = { ...leader.inputs[0], description: "edited" };
    const planned = await planInputPause({ cribl: leader }, { record: SOURCE, pause: true });
    expect(planned.kind).toBe("refused");
    expect(leader.writes()).toEqual([]);
  });

  it("already paused is nothing to do", async () => {
    const leader = new TeardownLeader();
    leader.inputs[0] = { ...leader.inputs[0], disabled: true };
    const planned = await planInputPause({ cribl: leader }, { record: SOURCE, pause: true });
    expect(planned.kind).toBe("already");
  });
});
