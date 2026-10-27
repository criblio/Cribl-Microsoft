import { describe, expect, it } from "vitest";
import type { CoverageSelection } from "../coverage-model/coverage-selection";
import type { StepVerdict } from "../onboarding-howto/check-kinds";
import {
  emptyProgress,
  withCriblSource,
  withPlanValues,
  withSourceChosen,
  withSourceMode,
  withTick,
  type OnboardingProgress,
} from "../onboarding-howto/progress-document";
import { ONBOARDING_SOURCES, type OnboardingSourceId } from "../onboarding-howto/sources";
import { stepsFor } from "../onboarding-howto-steps/steps";
import { checkKey } from "../../usecases/validate-azure-onboarding/validate-azure-onboarding";
import type { LaneFlowState } from "../onboarding-flow/flow-state";
import {
  arrivalText,
  buildOnboardingLanes,
  isLaneChosen,
  laneCheckKey,
  laneMode,
  type BuildOnboardingLanesInput,
  type DataflowPerspective,
} from "./index";

const SELECTION_NONE: CoverageSelection = { mode: "Centralized", enabled: [], subSelections: {} };

function plan(p: OnboardingProgress): OnboardingProgress {
  return withPlanValues(p, {
    ...p.planValues,
    subscriptionId: "sub1",
    resourceGroup: "rg1",
    namespace: "ns1",
    hubName: "defender-hub",
    storageAccount: "flowacct",
    queueName: "flowq",
  });
}

function manual(p: OnboardingProgress, ...ids: OnboardingSourceId[]): OnboardingProgress {
  let out = p;
  for (const id of ids) out = withSourceMode(withSourceChosen(out, id, true), id, "manual");
  return out;
}

function input(over: Partial<BuildOnboardingLanesInput>): BuildOnboardingLanesInput {
  return {
    selection: SELECTION_NONE,
    progress: plan(emptyProgress()),
    stepsFor,
    verdicts: null,
    arrival: null,
    criblSide: null,
    flow: null,
    perspective: "end-to-end",
    ...over,
  };
}

const RECORD_EH = { groupId: "g1", inputId: "azure_onb_eh_ns1_entraId", inputType: "eventhub" as const, secretId: "s1" };
const FLOWING: LaneFlowState = { kind: "flowing", events: 12 };
const IDLE: LaneFlowState = { kind: "idle", seenInLookback: false };

function card(lanes: ReturnType<typeof buildOnboardingLanes>, sourceId: string, kind: string) {
  const lane = lanes.lanes.find((l) => l.sourceId === sourceId);
  return lane?.cards.find((c) => c.kind === kind);
}

describe("chosen sources (D2)", () => {
  it("an Automated source is chosen only by the AZR-18 selection; How-to sources by progress", () => {
    const p = plan(emptyProgress());
    expect(laneMode(p, "defenderExport")).toBe("automate");
    expect(isLaneChosen(SELECTION_NONE, p, "defenderExport")).toBe(false);
    expect(isLaneChosen({ ...SELECTION_NONE, enabled: ["defenderExport"] }, p, "defenderExport")).toBe(true);
    // Not automatable: the selection does not choose it, progress does.
    expect(isLaneChosen({ ...SELECTION_NONE, enabled: ["entraId"] }, p, "entraId")).toBe(false);
    expect(isLaneChosen(SELECTION_NONE, manual(p, "entraId"), "entraId")).toBe(true);
    // A How-to Defender ignores the selection.
    const howto = withSourceMode(p, "defenderExport", "manual");
    expect(isLaneChosen({ ...SELECTION_NONE, enabled: ["defenderExport"] }, howto, "defenderExport")).toBe(false);
  });

  it("the verdict key is the Validate usecase's checkKey", () => {
    expect(laneCheckKey("entraId", "eh-namespace", "eh-namespace")).toBe(
      checkKey("entraId", "eh-namespace", "eh-namespace"),
    );
  });
});

describe("verdict states", () => {
  it("no verdicts reads 'not checked yet'; a denied read reads 'cannot check: no permission'", () => {
    const progress = manual(plan(emptyProgress()), "entraId");
    const before = buildOnboardingLanes(input({ progress }));
    expect(card(before, "entraId", "transport")?.status.label).toBe("not checked yet");
    expect(card(before, "entraId", "emitter")?.status.label).toBe("not checked yet");

    const denied: StepVerdict = { kind: "unknown", reason: "denied", detail: "403" };
    const ok: StepVerdict = { kind: "as-expected" };
    const verdicts: Record<string, StepVerdict> = {
      [laneCheckKey("entraId", "eh-namespace", "eh-namespace")]: ok,
      [laneCheckKey("entraId", "eh-consumer-group-auto", "eh-hub")]: denied,
      [laneCheckKey("entraId", "entra-setting", "entra-setting")]: ok,
    };
    const after = buildOnboardingLanes(input({ progress, verdicts }));
    expect(card(after, "entraId", "transport")?.status).toEqual({
      kind: "unknown",
      label: "cannot check: no permission",
    });
    expect(card(after, "entraId", "emitter")?.status.label).toBe("configured as expected");
  });

  it("present-other-name shows 'exists (named <name>)'", () => {
    const progress = manual(plan(emptyProgress()), "defenderExport");
    const verdicts = {
      [laneCheckKey("defenderExport", "defender-export", "defender-export")]: {
        kind: "present-other-name",
        name: "LegacyExport",
        diffs: [],
      } as StepVerdict,
    };
    const lanes = buildOnboardingLanes(input({ progress, verdicts, perspective: "azure" }));
    const step = lanes.lanes[0].cards.find((c) => c.stepId === "defender-export");
    expect(step?.status.label).toBe("exists (named LegacyExport)");
  });
});

describe("partly checked groups (inventory honesty)", () => {
  // One as-expected verdict among several expected checks: the unchecked ones
  // were never read, so no card may read "configured as expected".
  const progress = withCriblSource(manual(plan(emptyProgress()), "entraId"), "entraId", RECORD_EH);
  const verdicts: Record<string, StepVerdict> = {
    [laneCheckKey("entraId", "eh-namespace", "eh-namespace")]: { kind: "as-expected" },
  };
  const expectedChecks = stepsFor("entraId").reduce((n, s) => n + s.checkKinds.length, 0);

  it("the fixture really leaves checks unread", () => {
    expect(expectedChecks).toBeGreaterThan(1);
  });

  it("azure-folded reads 'partly checked (1 of N)', not 'configured as expected'", () => {
    const lanes = buildOnboardingLanes(input({ progress, verdicts, perspective: "cribl" }));
    expect(card(lanes, "entraId", "azure-folded")?.status).toEqual({
      kind: "partly-checked",
      label: `partly checked (1 of ${expectedChecks}): the rest were not checked in the last run`,
    });
  });

  it("the transport card and the shared namespace are partly checked", () => {
    const lanes = buildOnboardingLanes(input({ progress, verdicts }));
    expect(card(lanes, "entraId", "transport")?.status.kind).toBe("partly-checked");
    expect(lanes.shared[0].status.kind).toBe("partly-checked");
  });

  it("an emitter whose one check is unread is 'not checked yet', never as expected", () => {
    const lanes = buildOnboardingLanes(input({ progress, verdicts }));
    expect(card(lanes, "entraId", "emitter")?.status.kind).toBe("not-checked");
  });

  it("a step card with an unread check is not as expected", () => {
    const step = stepsFor("entraId").find((s) => s.checkKinds.length > 1);
    if (!step) throw new Error("fixture: a step with two checks");
    const one: Record<string, StepVerdict> = {
      [laneCheckKey("entraId", step.id, step.checkKinds[0])]: { kind: "as-expected" },
    };
    const lanes = buildOnboardingLanes(input({ progress, verdicts: one, perspective: "azure" }));
    const c = lanes.lanes[0].cards.find((x) => x.stepId === step.id);
    expect(c?.status.kind).toBe("partly-checked");
  });

  it("an unread check never hides a worse verdict that was read", () => {
    const worse: Record<string, StepVerdict> = {
      [laneCheckKey("entraId", "eh-namespace", "eh-namespace")]: { kind: "absent" },
    };
    const lanes = buildOnboardingLanes(input({ progress, verdicts: worse, perspective: "cribl" }));
    expect(card(lanes, "entraId", "azure-folded")?.status.kind).toBe("absent");
  });

  it("a fully checked group still reads as expected", () => {
    const all: Record<string, StepVerdict> = {};
    for (const s of stepsFor("entraId")) for (const k of s.checkKinds) all[laneCheckKey("entraId", s.id, k)] = { kind: "as-expected" };
    const lanes = buildOnboardingLanes(input({ progress, verdicts: all, perspective: "cribl" }));
    expect(card(lanes, "entraId", "azure-folded")?.status.label).toBe("configured as expected");
  });
});

describe("live flow edges", () => {
  const perspectives: DataflowPerspective[] = ["azure", "cribl", "end-to-end"];
  for (const perspective of perspectives) {
    it(`exactly one animated edge per flowing lane (${perspective})`, () => {
      let progress = manual(plan(emptyProgress()), "entraId", "activityLog");
      progress = withCriblSource(progress, "entraId", RECORD_EH);
      progress = withCriblSource(progress, "activityLog", { ...RECORD_EH, inputId: "azure_onb_eh_ns1_activityLog" });
      const lanes = buildOnboardingLanes(
        input({ progress, perspective, flow: { entraId: FLOWING, activityLog: IDLE } }),
      );
      const entra = lanes.lanes.find((l) => l.sourceId === "entraId");
      const activity = lanes.lanes.find((l) => l.sourceId === "activityLog");
      expect(entra?.edges.filter((e) => e.animated)).toHaveLength(1);
      expect(entra?.edges.filter((e) => e.flow.kind === "measured")).toHaveLength(1);
      expect(activity?.edges.filter((e) => e.animated)).toHaveLength(0);
      // Every other edge is "no counter".
      for (const e of entra?.edges ?? []) {
        if (e.flow.kind === "not-measured") expect(e.flow.label).toBe("not measured: no counter");
      }
    });
  }

  it("a lane with no Cribl source is not measured (no source), never idle, and does not animate", () => {
    const progress = manual(plan(emptyProgress()), "entraId");
    const lanes = buildOnboardingLanes(input({ progress, flow: { entraId: FLOWING } }));
    expect(lanes.lanes[0].flow).toMatchObject({ kind: "not-measured", reason: "no-source" });
    expect(lanes.lanes[0].edges.some((e) => e.animated)).toBe(false);
  });
});

describe("perspective folding (D14)", () => {
  const progress = manual(plan(emptyProgress()), "entraId");
  const kinds = (p: DataflowPerspective) =>
    new Set(buildOnboardingLanes(input({ progress, perspective: p })).lanes[0].cards.map((c) => c.kind));

  it("the Azure side folds Cribl into one card and shows the steps", () => {
    const k = kinds("azure");
    expect(k.has("cribl-folded")).toBe(true);
    expect(k.has("step")).toBe(true);
    for (const gone of ["cribl-source", "route", "destination", "azure-folded"]) expect(k.has(gone as never)).toBe(false);
  });

  it("the Cribl side folds Azure into one card", () => {
    const lanes = buildOnboardingLanes(input({ progress, perspective: "cribl" }));
    const k = new Set(lanes.lanes[0].cards.map((c) => c.kind));
    expect([...k].sort()).toEqual(["azure-folded", "cribl-source", "destination", "route"]);
    expect(lanes.lanes[0].cards.filter((c) => c.kind === "azure-folded")).toHaveLength(1);
  });

  it("end to end shows every card except steps and folds", () => {
    expect([...kinds("end-to-end")].sort()).toEqual(["cribl-source", "destination", "emitter", "route", "transport"]);
  });

  it("every edge stays inside its lane", () => {
    for (const p of ["azure", "cribl", "end-to-end"] as const) {
      for (const lane of buildOnboardingLanes(input({ progress, perspective: p })).lanes) {
        const ids = new Set(lane.cards.map((c) => c.id));
        for (const e of lane.edges) {
          expect(ids.has(e.from)).toBe(true);
          expect(ids.has(e.to)).toBe(true);
        }
      }
    }
  });
});

describe("shared objects", () => {
  it("a shared namespace is computed once and referenced by both lanes", () => {
    const progress = manual(plan(emptyProgress()), "entraId", "activityLog");
    const verdicts = {
      [laneCheckKey("entraId", "eh-namespace", "eh-namespace")]: { kind: "as-expected" } as StepVerdict,
      [laneCheckKey("activityLog", "eh-namespace", "eh-namespace")]: {
        kind: "present-differs",
        diffs: [{ field: "sku", expected: "Standard", actual: "Basic" }],
      } as StepVerdict,
    };
    const lanes = buildOnboardingLanes(input({ progress, verdicts }));
    const eh = lanes.shared.filter((s) => s.kind === "eventhub-namespace");
    expect(eh).toHaveLength(1);
    expect(eh[0].sourceIds).toEqual(["activityLog", "entraId"]);
    const a = card(lanes, "entraId", "transport");
    const b = card(lanes, "activityLog", "transport");
    expect(a?.sharedId).toBe(eh[0].id);
    expect(b?.sharedId).toBe(eh[0].id);
    // One status object, the worst across both lanes.
    expect(a?.status).toBe(eh[0].status);
    expect(b?.status).toBe(eh[0].status);
    expect(eh[0].status.label).toBe("present but different (sku)");
  });
});

describe("step ticks", () => {
  it("a tick against older values shows 'done against older values' and names the key", () => {
    let progress = manual(plan(emptyProgress()), "entraId");
    const step = stepsFor("entraId").find((s) => s.id === "eh-namespace");
    if (!step) throw new Error("fixture: eh-namespace step");
    progress = withTick(progress, step.id, step.dependsOnValues);
    const fresh = buildOnboardingLanes(input({ progress, perspective: "azure" }));
    expect(fresh.lanes[0].cards.find((c) => c.stepId === "eh-namespace")?.tickLabel).toBe("done");

    progress = withPlanValues(progress, { ...progress.planValues, namespace: "ns2" });
    const stale = buildOnboardingLanes(input({ progress, perspective: "azure" }));
    const label = stale.lanes[0].cards.find((c) => c.stepId === "eh-namespace")?.tickLabel ?? "";
    expect(label).toContain("done against older values");
    expect(label).toContain("namespace");
  });

  it("an Automated lane's steps carry no tick", () => {
    const lanes = buildOnboardingLanes(
      input({ selection: { ...SELECTION_NONE, enabled: ["defenderExport"] }, perspective: "azure" }),
    );
    const steps = lanes.lanes[0].cards.filter((c) => c.kind === "step");
    expect(steps.length).toBeGreaterThan(0);
    for (const s of steps) expect(s.tick).toBeNull();
  });
});

describe("cribl input types and order", () => {
  it("the blob source card is azure_blob and the Event Hub card is eventhub", () => {
    const progress = manual(plan(emptyProgress()), "entraId", "vnetFlowLogs");
    const lanes = buildOnboardingLanes(input({ progress }));
    expect(card(lanes, "vnetFlowLogs", "cribl-source")?.title).toBe("Cribl source (azure_blob)");
    expect(card(lanes, "entraId", "cribl-source")?.title).toBe("Cribl source (eventhub)");
    expect(lanes.lanes.find((l) => l.sourceId === "vnetFlowLogs")?.criblInputType).toBe("azure_blob");
    expect(lanes.shared.map((s) => s.kind).sort()).toEqual(["eventhub-namespace", "storage-account"]);
  });

  it("lanes follow ONBOARDING_SOURCES order", () => {
    const howtoIds = ONBOARDING_SOURCES.map((s) => s.id).filter((id) => id !== "defenderExport");
    const progress = manual(plan(emptyProgress()), ...[...howtoIds].reverse());
    const lanes = buildOnboardingLanes(
      input({ progress, selection: { ...SELECTION_NONE, enabled: ["defenderExport"] } }),
    );
    expect(lanes.lanes.map((l) => l.sourceId)).toEqual(ONBOARDING_SOURCES.map((s) => s.id));
  });
});

describe("hub arrival on the transport card", () => {
  it("a measured 0 reads 'no messages in the window', distinct from 'could not be read'", () => {
    const zero = arrivalText("h", { kind: "measured", messages: 0, window: "PT1H" });
    const unknown = arrivalText("h", { kind: "unknown", reason: "denied", detail: "403" });
    expect(zero).toBe("h: no messages in the window");
    expect(unknown).toContain("could not be read");
    expect(zero).not.toBe(unknown);
    expect(arrivalText("h", { kind: "measured", messages: 7, window: "PT1H" })).toBe("h: 7 messages in the window");
  });

  it("the transport card carries the lane's hub arrival readings", () => {
    const progress = manual(plan(emptyProgress()), "defenderExport");
    const lanes = buildOnboardingLanes(
      input({
        progress,
        arrival: { "defender-hub": { kind: "measured", messages: 0, window: "PT1H" } },
      }),
    );
    expect(card(lanes, "defenderExport", "transport")?.facts).toContain("defender-hub: no messages in the window");
  });
});

describe("Cribl side", () => {
  it("reads route and destination, and a missing read is 'not read', never absent", () => {
    const progress = withCriblSource(manual(plan(emptyProgress()), "entraId"), "entraId", RECORD_EH);
    const none = buildOnboardingLanes(input({ progress }));
    expect(card(none, "entraId", "route")?.status.kind).toBe("not-read");
    expect(card(none, "entraId", "cribl-source")?.status.kind).toBe("created");

    const lanes = buildOnboardingLanes(
      input({
        progress,
        criblSide: {
          inputs: { [RECORD_EH.inputId]: { kind: "present" } },
          routes: { [RECORD_EH.inputId]: { kind: "consumes", route: "sentinel", destination: "sentinel_out" } },
        },
      }),
    );
    expect(card(lanes, "entraId", "cribl-source")?.status.kind).toBe("present");
    expect(card(lanes, "entraId", "route")?.status.label).toBe("routed by sentinel");
    // Destinations are never read (D17): the card says what was read, the route naming it.
    expect(card(lanes, "entraId", "destination")?.status).toEqual({
      kind: "named-by-route",
      label: "named by route sentinel: sentinel_out",
    });
    expect(card(lanes, "entraId", "destination")?.facts).toEqual(["destination sentinel_out"]);
  });
});
