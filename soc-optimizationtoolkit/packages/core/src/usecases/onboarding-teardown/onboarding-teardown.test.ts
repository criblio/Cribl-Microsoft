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
import { toListing } from "../../domain/inventory-listing/inventory-listing";
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
  outputs: Record<string, unknown>[] = [{ id: "default", type: "devnull" }];
  jobs: Record<string, unknown>[] = [];
  /** Another worker group's routes and destinations (read for the dataset). */
  g2Routes: Record<string, unknown>[] = [{ id: "default", filter: "true", output: "default", final: true }];
  g2Outputs: Record<string, unknown>[] = [];
  /** What the workers run; the deploy moves it to HEAD. */
  deployed = "0000000000000000000000000000000000000000";

  override async listGroups(): Promise<never> {
    return toListing([{ id: G, product: "stream" }, { id: "g2", product: "stream" }, { id: "default_search", product: "search" }]) as never;
  }

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
      if (req.groupId === G && req.method === "GET" && req.path === "/system/outputs") {
        return { status: 200, body: { items: structuredClone(this.outputs), count: this.outputs.length } };
      }
      if (req.groupId === G && req.method === "GET" && req.path === "/jobs") {
        return { status: 200, body: { items: structuredClone(this.jobs), count: this.jobs.length } };
      }
      if (req.groupId === "g2" && req.method === "GET" && req.path === "/routes") {
        return { status: 200, body: { items: [{ id: "default", routes: structuredClone(this.g2Routes) }], count: 1 } };
      }
      if (req.groupId === "g2" && req.method === "GET" && req.path === "/system/outputs") {
        return { status: 200, body: { items: structuredClone(this.g2Outputs), count: this.g2Outputs.length } };
      }
      if (req.groupId === undefined && req.method === "PATCH" && req.path === `/products/stream/groups/${G}/deploy`) {
        this.deployed = String((req.body as { version: string }).version);
        return { status: 200, body: {} };
      }
      if (req.groupId === undefined && req.method === "GET" && req.path === `/products/stream/groups/${G}`) {
        return { status: 200, body: { items: [{ id: G, configVersion: this.deployed }] } };
      }
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
      `GET /m/${G}/system/outputs`,
      `GET /m/${G}/jobs`,
      // The dataset is a leader object: every other group's routes and
      // destinations are read (the Search group holds none and is skipped).
      `GET /m/g2/routes`,
      `GET /m/g2/system/outputs`,
      `GET /m/${G}/version/status`,
      `GET /m/${G}/routes/default`,
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

  it("review finding 1: already gone but the workers do not run HEAD is nothing-to-remove that keeps every record", async () => {
    const leader = new TeardownLeader();
    leader.inputs = [];
    leader.secrets = [];
    leader.pipelines = [];
    leader.datasets = [];
    (leader.table["routes"] as unknown[]).shift();
    leader.head = HASH; // committed by an earlier run, never deployed
    const r = await planSourceTeardown({ cribl: leader }, input());
    // The leader's dataset needs no commit: gone is gone, so only its proof goes.
    const { datasetCreated: _c, ...lakeWithoutDataset } = LAKE;
    expect(r).toMatchObject({ kind: "nothing-to-remove", records: { criblSource: SOURCE, lakeRoute: lakeWithoutDataset } });
    expect(r.kind === "nothing-to-remove" && r.unsettled).toBe(
      `Worker group ${G} runs 0000000000000000000000000000000000000000, not its newest commit ${HASH}, so earlier removals may not be live yet. Deploy the group in Cribl, then check again.`,
    );
    expect(leader.writes()).toEqual([]);
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

  it("re-review 1: a rerun after a refused commit never commits files it cannot attribute; the dataset and the records stay", async () => {
    const leader = new TeardownLeader();
    const first = ready(await planSourceTeardown({ cribl: leader }, input({ removeDataset: false })));
    leader.hooks.unshift((req) => (req.method === "POST" && req.path === "/version/commit" ? { status: 500, body: {} } : undefined));
    const run1 = await applySourceTeardown({ cribl: leader }, first);
    expect(run1.commit.kind).toBe("commit-failed");
    expect(run1.records).toEqual({ criblSource: SOURCE, lakeRoute: LAKE });
    leader.hooks.shift();

    // Run 2, with the dataset: every group object reads as gone, and their
    // files are pending - possibly the app's earlier removal, possibly not.
    const second = ready(await planSourceTeardown({ cribl: leader }, input()));
    expect(second.markers).toEqual([]);
    const writesBefore = leader.writes().length;
    const run2 = await applySourceTeardown({ cribl: leader }, second);
    expect(leader.writes().slice(writesBefore)).toEqual([]);
    expect(run2.commit.kind).toBe("unsettled");
    expect(run2.commit.kind === "unsettled" && run2.commit.detail).toContain("They may be an earlier removal by this app or someone else's work");
    expect(run2.steps.find((s) => s.kind === "dataset")?.result).toBe("not-reached");
    expect(run2.records).toEqual({ criblSource: SOURCE, lakeRoute: LAKE });
  });

  it("re-review 1: everything gone and committed, but an operator's half-done source dirties inputs.yml - nothing is committed, the records stay", async () => {
    const leader = new TeardownLeader();
    leader.inputs = [{ id: "in_new_half_done", type: "syslog" }];
    leader.secrets = [];
    leader.pipelines = [];
    (leader.table["routes"] as unknown[]).shift();
    leader.pending = [INPUTS_FILE];
    const r = await planSourceTeardown({ cribl: leader }, input({ removeDataset: false }));
    expect(r.kind).toBe("nothing-to-remove");
    expect(r.kind === "nothing-to-remove" && r.unsettled).toBe(
      `Worker group ${G} has uncommitted changes in ${INPUTS_FILE}. They may be an earlier removal by this app or someone else's work, and the app does not commit changes it did not make in this run. Commit or discard them in Cribl, then check again.`,
    );
    expect(r.kind === "nothing-to-remove" && r.records.criblSource).toEqual(SOURCE);
    expect(leader.writes()).toEqual([]);
  });

  it("re-review 1: a pipeline KEPT because in use never puts its directory in the commit", async () => {
    const leader = new TeardownLeader();
    (leader.table["routes"] as unknown[]).push({ id: "admin_route", filter: "true", pipeline: UNROLL_PIPELINE_ID, output: "devnull" });
    leader.pending = [PIPE_FILE]; // an operator is editing the pipeline
    const r = ready(await planSourceTeardown({ cribl: leader }, input({ removeDataset: false })));
    expect(r.steps.find((s) => s.kind === "pipeline")?.verdict.kind).toBe("keep");
    expect(r.commitFiles.some((f) => f.includes("/pipelines/azure_onb_unroll_records/"))).toBe(false);
    const outcome = await applySourceTeardown({ cribl: leader }, r);
    const commit = leader.requests.find((q) => q.method === "POST" && q.path === "/version/commit")!;
    expect((commit.body as { files: string[] }).files.sort()).toEqual([INPUTS_FILE, ROUTE_FILE, SECRETS_FILE].sort());
    expect(leader.pending).toEqual([PIPE_FILE]);
    expect(outcome.kind).toBe("removed");
    expect(outcome.records).toEqual({
      criblSource: null,
      lakeRoute: { groupId: G, datasetId: DATASET_ID, pipelineId: UNROLL_PIPELINE_ID, routeId: null, datasetCreated: true },
    });
  });

  it("re-review 3: an operator's pending change in a file the removal would commit refuses at plan time, writing nothing", async () => {
    const leader = new TeardownLeader();
    leader.pending = [INPUTS_FILE]; // a half-made source in the same inputs.yml
    const r = await planSourceTeardown({ cribl: leader }, input());
    expect(r).toEqual({
      kind: "refused",
      reason: "scope-dirty",
      detail: `Worker group ${G} has uncommitted changes in ${INPUTS_FILE}, which this removal would have to commit with its own. The app does not commit changes it did not make. Nothing was changed; commit or discard them in Cribl, then check again.`,
    });
    expect(leader.writes()).toEqual([]);
  });

  it("re-review 2: a run that removed something but finds nothing to commit is unsettled: records and dataset stay", async () => {
    const leader = new TeardownLeader();
    const r = ready(await planSourceTeardown({ cribl: leader }, input()));
    // DELETEs and the routes write that dirty files the markers do not cover.
    leader.hooks.unshift((req) => {
      if (req.method === "DELETE" && req.groupId === G) {
        const list = req.path.startsWith("/pipelines/") ? leader.pipelines : req.path.startsWith("/system/inputs/") ? leader.inputs : leader.secrets;
        const id = decodeURIComponent(req.path.split("/").pop() ?? "");
        const at = list.findIndex((x) => x["id"] === id);
        if (at >= 0) list.splice(at, 1);
        leader.pending.push(`groups/${G}/local/cribl/elsewhere-${id}.yml`);
        return { status: 200, body: {} };
      }
      return undefined;
    });
    leader.hooks.unshift((req) => {
      if (req.method === "PATCH" && req.path === "/routes/default") {
        leader.table = structuredClone(req.body as Record<string, unknown>);
        return { status: 200, body: { items: [leader.table], count: 1 } };
      }
      return undefined;
    });
    const outcome = await applySourceTeardown({ cribl: leader }, r);
    expect(outcome.commit).toEqual({
      kind: "unsettled",
      detail: `The removals were made, but Cribl reported none of their files as pending under the paths this app expects, so nothing was committed and they are not live. Check worker group ${G}'s pending changes in Cribl.`,
    });
    expect(leader.writes().some((w) => w.startsWith("DELETE /products"))).toBe(false);
    expect(outcome.records).toEqual({ criblSource: SOURCE, lakeRoute: LAKE });
    expect(outcome.kind).toBe("stopped");
  });

  it("review finding 1: a rerun after a failed deploy keeps the dataset and the records (the deployed route still sends there)", async () => {
    const leader = new TeardownLeader();
    const first = ready(await planSourceTeardown({ cribl: leader }, input({ removeDataset: false })));
    leader.hooks.unshift((req) => (req.method === "PATCH" && req.path.endsWith("/deploy") ? { status: 500, body: {} } : undefined));
    await applySourceTeardown({ cribl: leader }, first);
    expect(leader.pending).toEqual([]); // committed, not deployed

    const second = ready(await planSourceTeardown({ cribl: leader }, input()));
    const run2 = await applySourceTeardown({ cribl: leader }, second);
    expect(run2.commit).toEqual({
      kind: "unsettled",
      detail: `Worker group ${G} runs 0000000000000000000000000000000000000000, not its newest commit ${HASH}, so earlier removals may not be live yet. Deploy the group in Cribl, then check again.`,
    });
    expect(leader.writes().some((w) => w.startsWith("DELETE /products"))).toBe(false);
    expect(run2.steps.find((s) => s.kind === "dataset")?.result).toBe("not-reached");
    expect(run2.kind).toBe("stopped");
    expect(run2.records).toEqual({ criblSource: SOURCE, lakeRoute: LAKE });
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
