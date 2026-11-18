import { describe, expect, it } from "vitest";
import {
  classifyActivityLogRemoval,
  classifyInputForPause,
  planCriblTeardown,
  recordsAfterTeardown,
  sameDeletions,
  teardownDeletions,
  teardownReadsNeeded,
  type CriblTeardownInput,
  type CriblTeardownReads,
  type TeardownStep,
} from "./teardown-plan";
import { UNROLL_PIPELINE_DESCRIPTION, UNROLL_PIPELINE_ID } from "../onboarding-lake-route/lake-route";
import type { CriblSourceRecord, LakeRouteRecord } from "../onboarding-howto/progress-document";
import type { DiagnosticSettingRead } from "../activity-log-export/diagnostic-setting";

const STAMP = "[managed-by:soc-optimizationtoolkit]";
const INPUT_ID = "azure_onb_eh_abcd1234_ns1_activityLog";
const SECRET_ID = `${INPUT_ID}_secret`;
const ROUTE_ID = "azure_onb_activity_log_lake";
const DATASET_ID = "azure_activity_log";

const SOURCE: CriblSourceRecord = { groupId: "g1", inputId: INPUT_ID, inputType: "eventhub", secretId: SECRET_ID };
const LAKE: LakeRouteRecord = { groupId: "g1", datasetId: DATASET_ID, pipelineId: UNROLL_PIPELINE_ID, routeId: ROUTE_ID, datasetCreated: true };

function input(over: Partial<CriblTeardownInput> = {}): CriblTeardownInput {
  return { sourceId: "activityLog", criblSource: SOURCE, lakeRoute: LAKE, otherLakeRoutes: [], removeDataset: true, ...over };
}

const OUR_INPUT = { id: INPUT_ID, type: "eventhub", description: `Azure onboarding: Activity Log from ns1 ${STAMP}`, sasl: { textSecret: SECRET_ID } };
const OTHER_INPUT = { id: "in_syslog", type: "syslog", description: "hand made" };
const OUR_ROUTE = {
  id: ROUTE_ID,
  name: "Azure onboarding: Activity Log to Cribl Lake",
  filter: `__inputId=='eventhub:${INPUT_ID}'`,
  pipeline: UNROLL_PIPELINE_ID,
  output: `cribl_lake:${DATASET_ID}`,
  final: true,
  description: `Activity Log ${STAMP}`,
};
const DEFAULT_ROUTE = { id: "default", name: "default", filter: "true", pipeline: "main", output: "default", final: true };

function reads(over: Partial<CriblTeardownReads> = {}): CriblTeardownReads {
  return {
    inputs: { state: "read", items: [OUR_INPUT, OTHER_INPUT] },
    routes: { state: "read", items: [OUR_ROUTE, DEFAULT_ROUTE] },
    secret: { state: "read", items: [{ id: SECRET_ID, description: `secret ${STAMP}` }] },
    pipelines: { state: "read", items: [{ id: UNROLL_PIPELINE_ID, conf: { description: UNROLL_PIPELINE_DESCRIPTION } }, { id: "main", conf: {} }] },
    datasets: { state: "read", items: [{ id: DATASET_ID, description: `Azure onboarding ${STAMP}` }, { id: "default_logs" }] },
    outputs: { state: "read", items: [{ id: "default", type: "devnull" }] },
    jobs: { state: "read", items: [] },
    otherGroups: { state: "read", groups: [{ groupId: "g2", routes: [DEFAULT_ROUTE], outputs: [] }] },
    ...over,
  };
}

function steps(plan: ReturnType<typeof planCriblTeardown>): readonly TeardownStep[] {
  if (plan.kind !== "plan") throw new Error(`expected a plan, got ${plan.kind}: ${plan.detail}`);
  return plan.steps;
}

function verdictOf(plan: ReturnType<typeof planCriblTeardown>, kind: TeardownStep["kind"]) {
  const s = steps(plan).find((x) => x.kind === kind);
  if (s === undefined) throw new Error(`no ${kind} step`);
  return s.verdict;
}

describe("planCriblTeardown", () => {
  it("deletes every proven object, route first, the dataset last", () => {
    const plan = planCriblTeardown(input(), reads());
    expect(plan.kind).toBe("plan");
    expect(steps(plan).map((s) => `${s.kind}:${s.id}:${s.verdict.kind}`)).toEqual([
      `route:${ROUTE_ID}:delete`,
      `pipeline:${UNROLL_PIPELINE_ID}:delete`,
      `input:${INPUT_ID}:delete`,
      `secret:${SECRET_ID}:delete`,
      `dataset:${DATASET_ID}:delete`,
    ]);
    expect(plan.kind === "plan" && plan.groupId).toBe("g1");
  });

  it("keeps the dataset unless the operator opted in", () => {
    const plan = planCriblTeardown(input({ removeDataset: false }), reads({ datasets: null }));
    expect(verdictOf(plan, "dataset")).toEqual({
      kind: "keep",
      reason: "opt-in-off",
      detail: "Kept: it holds the data already stored. Tick the option to delete it as well.",
    });
    expect(teardownDeletions(steps(plan)).map((s) => s.kind)).toEqual(["route", "pipeline", "input", "secret"]);
  });

  it("never deletes a dataset the app did not record creating, even when opted in", () => {
    const { datasetCreated: _c, ...used } = LAKE;
    const v = verdictOf(planCriblTeardown(input({ lakeRoute: used }), reads()), "dataset");
    expect(v.kind).toBe("keep");
    expect(v.kind === "keep" && v.reason).toBe("not-proven");
    expect(v.kind === "keep" && v.detail).toContain("this app has no record of creating it");
  });

  it("keeps a route without the stamp, and everything it still references", () => {
    const edited = { ...OUR_ROUTE, description: "edited by an admin" };
    const plan = planCriblTeardown(input(), reads({ routes: { state: "read", items: [edited, DEFAULT_ROUTE] } }));
    const v = verdictOf(plan, "route");
    expect(v).toEqual({
      kind: "keep",
      reason: "not-proven",
      detail: "This app cannot prove it created it (description carries no stamp from this app), so it was kept. Remove it in Cribl if it should go.",
    });
    expect(verdictOf(plan, "pipeline")).toEqual({ kind: "keep", reason: "in-use", detail: `Still used by route ${ROUTE_ID}, so it was kept.` });
    expect(verdictOf(plan, "input")).toEqual({ kind: "keep", reason: "in-use", detail: `Still used by route ${ROUTE_ID}, so it was kept.` });
    expect(verdictOf(plan, "secret")).toEqual({ kind: "keep", reason: "in-use", detail: `Still used by source ${INPUT_ID}, so it was kept.` });
    expect(verdictOf(plan, "dataset")).toEqual({ kind: "keep", reason: "in-use", detail: `Still used by route ${ROUTE_ID} in g1, so it was kept.` });
    expect(teardownDeletions(steps(plan))).toEqual([]);
  });

  it("keeps the shared pipeline while another source's recorded route uses it, or any route in the table", () => {
    const other: LakeRouteRecord = { groupId: "g1", datasetId: "azure_defender_alerts", pipelineId: UNROLL_PIPELINE_ID, routeId: "azure_onb_defender_alerts_lake" };
    const plan = planCriblTeardown(input({ otherLakeRoutes: [{ sourceId: "defenderExport", record: other }] }), reads());
    expect(verdictOf(plan, "pipeline")).toEqual({
      kind: "keep",
      reason: "in-use",
      detail: "Still used by this app's recorded route azure_onb_defender_alerts_lake (defenderExport), so it was kept.",
    });
    // The route itself still goes.
    expect(verdictOf(plan, "route").kind).toBe("delete");

    const foreignUser = { id: "admin_route", filter: "true", pipeline: UNROLL_PIPELINE_ID, output: "devnull" };
    const plan2 = planCriblTeardown(input(), reads({ routes: { state: "read", items: [OUR_ROUTE, foreignUser, DEFAULT_ROUTE] } }));
    expect(verdictOf(plan2, "pipeline")).toEqual({ kind: "keep", reason: "in-use", detail: "Still used by route admin_route, so it was kept." });
  });

  it("a recorded route of another source in ANOTHER group does not hold the pipeline", () => {
    const other: LakeRouteRecord = { groupId: "g2", datasetId: "azure_defender_alerts", pipelineId: UNROLL_PIPELINE_ID, routeId: "azure_onb_defender_alerts_lake" };
    const plan = planCriblTeardown(input({ otherLakeRoutes: [{ sourceId: "defenderExport", record: other }] }), reads());
    expect(verdictOf(plan, "pipeline").kind).toBe("delete");
  });

  it("treats objects that are not there as already gone, and deletes nothing", () => {
    const plan = planCriblTeardown(
      input(),
      reads({
        inputs: { state: "read", items: [OTHER_INPUT] },
        routes: { state: "read", items: [DEFAULT_ROUTE] },
        secret: { state: "read", items: [] },
        pipelines: { state: "read", items: [{ id: "main" }] },
        datasets: { state: "read", items: [] },
      }),
    );
    expect(steps(plan).map((s) => s.verdict.kind)).toEqual(["already-gone", "already-gone", "already-gone", "already-gone", "already-gone"]);
    expect(teardownDeletions(steps(plan))).toHaveLength(0);
  });

  it("surfaces a 403 on one read honestly and still plans the rest", () => {
    const plan = planCriblTeardown(input(), reads({ pipelines: { state: "refused", status: 403, detail: "the pipelines list: HTTP 403" } }));
    expect(verdictOf(plan, "pipeline")).toEqual({
      kind: "keep",
      reason: "unreadable",
      detail: `Pipeline ${UNROLL_PIPELINE_ID} could not be read: Cribl refused it (HTTP 403), so this account may lack the permission. It was kept.`,
      denied: true,
    });
    expect(teardownDeletions(steps(plan)).map((s) => s.kind)).toEqual(["route", "input", "secret", "dataset"]);
  });

  it("refuses the whole plan when the sources or the routes cannot be read", () => {
    const a = planCriblTeardown(input(), reads({ inputs: { state: "refused", status: 403, detail: "the sources list: HTTP 403" } }));
    expect(a).toEqual({
      kind: "refused",
      reason: "inputs-unreadable",
      detail: "The worker group's sources could not be read (the sources list: HTTP 403), so what still uses each object is unknown. Nothing was changed.",
      denied: true,
    });
    const b = planCriblTeardown(input(), reads({ routes: { state: "refused", status: 500, detail: "the routing table: HTTP 500" } }));
    expect(b.kind === "refused" && b.reason).toBe("routes-unreadable");
    expect(b.kind === "refused" && b.denied).toBeUndefined();
  });

  it("refuses an input whose id is outside the manifest, whatever its description says", () => {
    const rec: CriblSourceRecord = { ...SOURCE, inputId: "in_custom", secretId: "in_custom_secret" };
    const plan = planCriblTeardown(
      input({ criblSource: rec, lakeRoute: null }),
      reads({
        inputs: { state: "read", items: [{ ...OUR_INPUT, id: "in_custom" }] },
        routes: { state: "read", items: [DEFAULT_ROUTE] },
        secret: { state: "read", items: [{ id: "in_custom_secret", description: STAMP }] },
      }),
    );
    expect(verdictOf(plan, "input")).toEqual({
      kind: "keep",
      reason: "not-proven",
      detail: "This app cannot prove it created it (id is not in this app’s manifest), so it was kept. Remove it in Cribl if it should go.",
    });
  });

  it("keeps the secret when another source names it", () => {
    const borrower = { id: "in_borrower", type: "eventhub", sasl: { textSecret: SECRET_ID } };
    const plan = planCriblTeardown(input(), reads({ inputs: { state: "read", items: [OUR_INPUT, borrower] } }));
    expect(verdictOf(plan, "input").kind).toBe("delete");
    expect(verdictOf(plan, "secret")).toEqual({ kind: "keep", reason: "in-use", detail: "Still used by source in_borrower, so it was kept." });
  });

  it("keeps an input that a route other than ours still names", () => {
    const another = { id: "admin_copy", filter: `__inputId=='eventhub:${INPUT_ID}' && x`, output: "devnull" };
    const plan = planCriblTeardown(input(), reads({ routes: { state: "read", items: [OUR_ROUTE, another, DEFAULT_ROUTE] } }));
    expect(verdictOf(plan, "input")).toEqual({ kind: "keep", reason: "in-use", detail: "Still used by route admin_copy, so it was kept." });
    expect(verdictOf(plan, "secret").kind).toBe("keep");
  });

  it("refuses when the records name two groups, and when nothing is recorded", () => {
    expect(planCriblTeardown(input({ lakeRoute: { ...LAKE, groupId: "g2" } }), reads()).kind === "refused").toBe(true);
    const none = planCriblTeardown(input({ criblSource: null, lakeRoute: null }), reads());
    expect(none.kind === "refused" && none.reason).toBe("nothing-recorded");
  });

  it("asks only for the reads it needs", () => {
    expect(teardownReadsNeeded(input({ removeDataset: false }))).toEqual({ secret: true, pipelines: true, datasets: false, outputs: true, jobs: true, otherGroups: false });
    expect(teardownReadsNeeded(input({ lakeRoute: null }))).toEqual({ secret: true, pipelines: false, datasets: false, outputs: true, jobs: true, otherGroups: false });
    expect(teardownReadsNeeded(input({ criblSource: null, lakeRoute: { ...LAKE, pipelineId: null } }))).toEqual({
      secret: false,
      pipelines: false,
      datasets: true,
      outputs: true,
      jobs: false,
      otherGroups: true,
    });
  });

  it("compares two plans by what they delete", () => {
    const a = steps(planCriblTeardown(input(), reads()));
    const b = steps(planCriblTeardown(input({ removeDataset: false }), reads()));
    expect(sameDeletions(a, a)).toBe(true);
    expect(sameDeletions(a, b)).toBe(false);
  });
});

describe("in-use checks beyond routes (review findings 2-4)", () => {
  it("keeps the pipeline while a QuickConnect connection, a destination or a collector names it", () => {
    const qc = { id: "in_qc", type: "syslog", connections: [{ pipeline: UNROLL_PIPELINE_ID, output: "devnull" }] };
    const a = planCriblTeardown(input(), reads({ inputs: { state: "read", items: [OUR_INPUT, qc] } }));
    expect(verdictOf(a, "pipeline")).toEqual({ kind: "keep", reason: "in-use", detail: "Still used by source in_qc, so it was kept." });
    const post = { id: "out_s3", type: "s3", pipeline: UNROLL_PIPELINE_ID };
    const b = planCriblTeardown(input(), reads({ outputs: { state: "read", items: [post] } }));
    expect(verdictOf(b, "pipeline")).toEqual({ kind: "keep", reason: "in-use", detail: "Still used by destination out_s3, so it was kept." });
    const job = { id: "job1", input: { pipeline: UNROLL_PIPELINE_ID } };
    const c = planCriblTeardown(input(), reads({ jobs: { state: "read", items: [job] } }));
    expect(verdictOf(c, "pipeline")).toEqual({ kind: "keep", reason: "in-use", detail: "Still used by collector job1, so it was kept." });
  });

  it("keeps the pipeline and the secret when the destinations cannot be read, saying what was not read", () => {
    const plan = planCriblTeardown(input(), reads({ outputs: { state: "refused", status: 403, detail: "the destinations list: HTTP 403" } }));
    expect(verdictOf(plan, "pipeline")).toEqual({
      kind: "keep",
      reason: "unreadable",
      detail: `The destinations could not be read: Cribl refused it (HTTP 403), so whether anything still uses pipeline ${UNROLL_PIPELINE_ID} is unknown. It was kept.`,
      denied: true,
    });
    expect(verdictOf(plan, "secret").kind === "keep" && verdictOf(plan, "secret")).toMatchObject({ reason: "unreadable", denied: true });
    expect(verdictOf(plan, "input").kind).toBe("delete");
  });

  it("keeps the secret while a destination or a collector names it", () => {
    const dest = { id: "out_eh", type: "azure_eventhub", sasl: { textSecret: SECRET_ID } };
    const a = planCriblTeardown(input(), reads({ outputs: { state: "read", items: [dest] } }));
    expect(verdictOf(a, "secret")).toEqual({ kind: "keep", reason: "in-use", detail: "Still used by destination out_eh, so it was kept." });
    const job = { id: "job2", collector: { conf: { textSecret: SECRET_ID } } };
    const b = planCriblTeardown(input(), reads({ jobs: { state: "read", items: [job] } }));
    expect(verdictOf(b, "secret")).toEqual({ kind: "keep", reason: "in-use", detail: "Still used by collector job2, so it was kept." });
  });

  it("keeps the dataset while ANOTHER worker group routes to it, or a Cribl Lake destination names it", () => {
    const remote = { id: "r_remote", filter: "true", output: `cribl_lake:${DATASET_ID}` };
    const a = planCriblTeardown(input(), reads({ otherGroups: { state: "read", groups: [{ groupId: "g2", routes: [remote], outputs: [] }] } }));
    expect(verdictOf(a, "dataset")).toEqual({ kind: "keep", reason: "in-use", detail: "Still used by route r_remote in g2, so it was kept." });
    const lakeDest = { id: "lake_out", type: "cribl_lake", destPath: DATASET_ID };
    const b = planCriblTeardown(input(), reads({ otherGroups: { state: "read", groups: [{ groupId: "g3", routes: [], outputs: [lakeDest] }] } }));
    expect(verdictOf(b, "dataset")).toEqual({ kind: "keep", reason: "in-use", detail: "Still used by destination lake_out in g3, so it was kept." });
    const c = planCriblTeardown(input(), reads({ outputs: { state: "read", items: [lakeDest] } }));
    expect(verdictOf(c, "dataset")).toEqual({ kind: "keep", reason: "in-use", detail: "Still used by destination lake_out in g1, so it was kept." });
  });

  it("never deletes the dataset on partial knowledge: an unreadable group keeps it", () => {
    const plan = planCriblTeardown(input(), reads({ otherGroups: { state: "refused", status: 403, detail: "worker group g2: the routing table: HTTP 403" } }));
    expect(verdictOf(plan, "dataset")).toEqual({
      kind: "keep",
      reason: "unreadable",
      detail: `The other worker groups' routes and destinations could not be read: Cribl refused it (HTTP 403), so whether anything still uses Cribl Lake dataset ${DATASET_ID} is unknown. It was kept.`,
      denied: true,
    });
    const notRead = planCriblTeardown(input(), reads({ otherGroups: null }));
    expect(verdictOf(notRead, "dataset").kind === "keep" && verdictOf(notRead, "dataset")).toMatchObject({ reason: "unreadable" });
  });
});

describe("recordsAfterTeardown", () => {
  it("review finding 1: already-gone objects keep their records while the group is not settled", () => {
    const gone = { route: "already-gone", pipeline: "already-gone", input: "already-gone", secret: "already-gone", dataset: "kept" } as const;
    expect(recordsAfterTeardown({ criblSource: SOURCE, lakeRoute: LAKE, results: gone, committed: false })).toEqual({ criblSource: SOURCE, lakeRoute: LAKE });
    expect(recordsAfterTeardown({ criblSource: SOURCE, lakeRoute: LAKE, results: gone, committed: true }).criblSource).toBeNull();
  });

  it("forgets only what is gone for good: already gone, or removed and committed", () => {
    const all = { route: "removed", pipeline: "removed", input: "removed", secret: "removed", dataset: "removed" } as const;
    expect(recordsAfterTeardown({ criblSource: SOURCE, lakeRoute: LAKE, results: all, committed: true })).toEqual({ criblSource: null, lakeRoute: null });
    // Not committed: the group objects can come back, so their records stay.
    expect(recordsAfterTeardown({ criblSource: SOURCE, lakeRoute: LAKE, results: all, committed: false })).toEqual({
      criblSource: SOURCE,
      lakeRoute: { groupId: "g1", datasetId: DATASET_ID, pipelineId: UNROLL_PIPELINE_ID, routeId: ROUTE_ID },
    });
  });

  it("keeps a created dataset recorded until it is deleted", () => {
    const r = recordsAfterTeardown({
      criblSource: SOURCE,
      lakeRoute: LAKE,
      results: { route: "removed", pipeline: "kept", input: "already-gone", secret: "removed", dataset: "kept" },
      committed: true,
    });
    expect(r).toEqual({
      criblSource: null,
      lakeRoute: { groupId: "g1", datasetId: DATASET_ID, pipelineId: UNROLL_PIPELINE_ID, routeId: null, datasetCreated: true },
    });
    const s = recordsAfterTeardown({
      criblSource: null,
      lakeRoute: { ...LAKE, pipelineId: null, routeId: null },
      results: { dataset: "kept" },
      committed: true,
    });
    expect(s.lakeRoute).toEqual({ groupId: "g1", datasetId: DATASET_ID, pipelineId: null, routeId: null, datasetCreated: true });
  });

  it("drops the Lake record when nothing it names is left and the dataset was never the app's", () => {
    const { datasetCreated: _c, ...used } = LAKE;
    const r = recordsAfterTeardown({ criblSource: null, lakeRoute: used, results: { route: "already-gone", pipeline: "removed", dataset: "kept" }, committed: true });
    expect(r.lakeRoute).toBeNull();
  });
});

describe("classifyInputForPause", () => {
  it("is ready only for a proven input not yet in the asked state", () => {
    expect(classifyInputForPause({ state: "read", items: [OUR_INPUT] }, SOURCE, true)).toEqual({ kind: "ready" });
    expect(classifyInputForPause({ state: "read", items: [{ ...OUR_INPUT, disabled: true }] }, SOURCE, true)).toEqual({ kind: "already" });
    expect(classifyInputForPause({ state: "read", items: [{ ...OUR_INPUT, disabled: true }] }, SOURCE, false)).toEqual({ kind: "ready" });
    expect(classifyInputForPause({ state: "read", items: [OUR_INPUT] }, SOURCE, false)).toEqual({ kind: "already" });
    expect(classifyInputForPause({ state: "read", items: [] }, SOURCE, true)).toEqual({ kind: "absent" });
  });

  it("refuses an input it cannot prove, and says a 403 is a permission refusal", () => {
    const v = classifyInputForPause({ state: "read", items: [{ ...OUR_INPUT, description: "copied" }] }, SOURCE, true);
    expect(v).toEqual({
      kind: "not-proven",
      detail: `This app cannot prove it created Cribl source ${INPUT_ID} (description carries no stamp from this app), so it does not change it.`,
    });
    expect(classifyInputForPause({ state: "refused", status: 403, detail: "x" }, SOURCE, true)).toEqual({
      kind: "unreadable",
      detail: "The worker group's sources could not be read: Cribl refused it (HTTP 403), so this account may lack the permission. Nothing was changed.",
      denied: true,
    });
  });
});

describe("classifyActivityLogRemoval", () => {
  const RULE = "/subscriptions/s1/resourceGroups/rg/providers/Microsoft.EventHub/namespaces/ns1/authorizationRules/manage";
  const setting = (over: Partial<DiagnosticSettingRead> = {}): DiagnosticSettingRead =>
    ({ id: "x", name: "cribl-activity-log", ruleId: RULE, hub: "", enabled: [], enabledGroups: [], ...over }) as DiagnosticSettingRead;
  const record = { subscriptionId: "S1", settingName: "cribl-activity-log", ruleId: RULE.toLowerCase() };

  it("deletes only the recorded setting still sending with the recorded rule", () => {
    expect(classifyActivityLogRemoval({ kind: "found", setting: setting() }, record, "s1")).toEqual({ kind: "delete" });
  });

  it("is already gone when there is nothing under the app's name", () => {
    expect(classifyActivityLogRemoval({ kind: "absent" }, record, "s1")).toEqual({ kind: "already-gone" });
  });

  it("refuses without a record for this subscription, or with another rule", () => {
    const none = classifyActivityLogRemoval({ kind: "found", setting: setting() }, null, "s1");
    expect(none.kind).toBe("not-proven");
    expect(none.kind === "not-proven" && none.detail).toContain("this app has no record of creating it on this subscription");
    const elsewhere = classifyActivityLogRemoval({ kind: "found", setting: setting() }, { ...record, subscriptionId: "s2" }, "s1");
    expect(elsewhere.kind).toBe("not-proven");
    const moved = classifyActivityLogRemoval({ kind: "found", setting: setting({ ruleId: `${RULE}2` }) }, record, "s1");
    expect(moved.kind === "not-proven" && moved.detail).toContain(`it now sends with rule ${RULE}2, not the rule this app wrote`);
  });
});
