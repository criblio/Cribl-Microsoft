// Barrel pin (AZR-18): the names the Azure onboarding screen imports from
// @soc/core must reach the package entry point. A module never added to the
// barrel otherwise fails only when a screen tries to import from it. Each name
// is asserted by type AND by identity with its source module.
//
// What this pin does NOT catch: two `export *` modules defining the same name.
// Native ESM excludes the ambiguous binding, but vitest's transform resolves it
// first-wins, so this test still passes (mutation-checked 2026-10-21). That
// case is caught by typecheck instead - tsc reports TS2308 on the barrel line -
// so `npm run typecheck` is the other half of this pin.

import { describe, expect, it } from "vitest";

import * as core from "./index";
import * as usecases from "./usecases";
import * as testing from "./testing";
import * as eventHubArm from "./domain/eventhub-arm";
import * as defenderDomain from "./domain/defender-export";
import * as onboardingSections from "./domain/onboarding-sections";
import * as coverageModel from "./domain/coverage-model";
import * as discoverEventHubs from "./usecases/discover-event-hubs";
import * as eventHubTarget from "./usecases/eventhub-target";
import * as defenderUsecase from "./usecases/defender-export";
import * as fakeKvDocumentStore from "./testing/fake-kv-document-store";
import * as onboardingHowto from "./domain/onboarding-howto";
import * as onboardingHowtoSteps from "./domain/onboarding-howto-steps";
import * as onboardingValidation from "./domain/onboarding-validation";
import * as criblOnboardingSource from "./domain/cribl-onboarding-source";
import * as onboardingFlow from "./domain/onboarding-flow";
import * as onboardingDataflow from "./domain/onboarding-dataflow";
import * as entraDiagnostics from "./domain/entra-diagnostics";
import * as createCriblSource from "./usecases/create-cribl-source";
import * as validateAzureOnboarding from "./usecases/validate-azure-onboarding";
import * as readSourceFlow from "./usecases/read-source-flow";
import * as onboardBatch from "./usecases/onboard-batch";
import * as kitMetricsQuery from "./kit/metrics/metricsQuery";

type Entry = readonly [name: string, source: Record<string, unknown>, kind: string];

const ROOT_NAMES: readonly Entry[] = [
  ["discoverEventHubNamespaces", discoverEventHubs, "function"],
  ["listNamespaceHubs", eventHubTarget, "function"],
  ["listNamespaceAuthRules", eventHubTarget, "function"],
  ["readDefenderState", defenderUsecase, "function"],
  ["deployDefenderExport", defenderUsecase, "function"],
  ["DEFENDER_EXPORT_ITEM_ID", defenderUsecase, "string"],
  ["ONBOARDING_SECTIONS", onboardingSections, "object"],
  ["itemAvailability", onboardingSections, "function"],
  ["readCoverageDocument", coverageModel, "function"],
  ["buildNamespaceListKeysRequest", eventHubArm, "function"],
  ["ruleCanSend", eventHubArm, "function"],
  ["EVENTHUB_ARM_API_VERSION", eventHubArm, "string"],
  ["DEFENDER_EXPORT_NAME", defenderDomain, "string"],
  ["parsePricings", defenderDomain, "function"],
  ["FakeKvDocumentStore", fakeKvDocumentStore, "function"],
];

// AZR-30..34 (ADR 0007): the How-to, Validate, dataflow, live-flow and Cribl
// source surface the onboarding screen imports from @soc/core.
const HOWTO_ROOT_NAMES: readonly Entry[] = [
  ["ONBOARDING_SOURCES", onboardingHowto, "object"],
  ["isAutomatable", onboardingHowto, "function"],
  ["readProgressDocument", onboardingHowto, "function"],
  ["ONBOARDING_PROGRESS_KEY", onboardingHowto, "string"],
  ["stepsFor", onboardingHowtoSteps, "function"],
  ["renderStep", onboardingHowtoSteps, "function"],
  ["classifyCheck", onboardingValidation, "function"],
  ["classifyArrival", onboardingValidation, "function"],
  ["requestsFor", onboardingValidation, "function"],
  ["ruleCanListen", eventHubArm, "function"],
  ["namespaceSupportsKafka", eventHubArm, "function"],
  ["classifyExportForPlan", defenderDomain, "function"],
  ["listSettingsRequest", entraDiagnostics, "function"],
  ["buildEventHubInputBody", criblOnboardingSource, "function"],
  ["parseEventHubConnectionString", criblOnboardingSource, "function"],
  ["checkPastedCredential", criblOnboardingSource, "function"],
  ["classifyLaneFlow", onboardingFlow, "function"],
  ["nextFlowQuery", onboardingFlow, "function"],
  ["buildOnboardingLanes", onboardingDataflow, "function"],
  ["planCriblSource", createCriblSource, "function"],
  ["applyCriblSource", createCriblSource, "function"],
  ["validateAzureOnboarding", validateAzureOnboarding, "function"],
  ["readSourceFlow", readSourceFlow, "function"],
  ["readOnboardingCriblSide", readSourceFlow, "function"],
  ["paceAzureManagement", onboardBatch, "function"],
  ["describeMetricsRequest", kitMetricsQuery, "function"],
];

describe("@soc/core entry point exports the Azure onboarding surface", () => {
  it.each(ROOT_NAMES)("%s is exported from the package root", (name, source, kind) => {
    const value = (core as Record<string, unknown>)[name];
    expect(typeof value).toBe(kind);
    expect(value).toBe(source[name]);
  });

  it("ONBOARDING_SECTIONS reaches the root as a non-empty array", () => {
    expect(Array.isArray(core.ONBOARDING_SECTIONS)).toBe(true);
    expect(core.ONBOARDING_SECTIONS.length).toBeGreaterThan(0);
  });

  it("the usecases barrel carries the two new usecases and the namespaces-only discovery", () => {
    expect(usecases.discoverEventHubNamespaces).toBe(discoverEventHubs.discoverEventHubNamespaces);
    expect(usecases.listNamespaceHubs).toBe(eventHubTarget.listNamespaceHubs);
    expect(usecases.listNamespaceAuthRules).toBe(eventHubTarget.listNamespaceAuthRules);
    expect(usecases.readDefenderState).toBe(defenderUsecase.readDefenderState);
    expect(usecases.deployDefenderExport).toBe(defenderUsecase.deployDefenderExport);
  });

  it("the testing barrel carries FakeKvDocumentStore and it constructs", () => {
    expect(testing.FakeKvDocumentStore).toBe(fakeKvDocumentStore.FakeKvDocumentStore);
    expect(new core.FakeKvDocumentStore()).toBeInstanceOf(fakeKvDocumentStore.FakeKvDocumentStore);
  });

  it.each(HOWTO_ROOT_NAMES)("%s (onboarding How-to surface) is exported from the package root", (name, source, kind) => {
    const value = (core as Record<string, unknown>)[name];
    expect(typeof value).toBe(kind);
    expect(value).toBe(source[name]);
  });

  it("the usecases barrel carries the three onboarding usecases", () => {
    expect(usecases.planCriblSource).toBe(createCriblSource.planCriblSource);
    expect(usecases.applyCriblSource).toBe(createCriblSource.applyCriblSource);
    expect(usecases.validateAzureOnboarding).toBe(validateAzureOnboarding.validateAzureOnboarding);
    expect(usecases.readSourceFlow).toBe(readSourceFlow.readSourceFlow);
    expect(usecases.readOnboardingCriblSide).toBe(readSourceFlow.readOnboardingCriblSide);
  });

  it("the kit is never re-exported wholesale: no clock and no kit transport reach the root", () => {
    const keys = Object.keys(core);
    for (const name of ["systemClock", "commitAndDeploy", "readModifyWrite", "queryMetrics", "isOk", "abortError"]) {
      expect(keys).not.toContain(name);
    }
  });
});
