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

type Entry = readonly [name: string, source: Record<string, unknown>, kind: string];

const ROOT_NAMES: readonly Entry[] = [
  ["discoverEventHubNamespaces", discoverEventHubs, "function"],
  ["listNamespaceHubs", eventHubTarget, "function"],
  ["listNamespaceAuthRules", eventHubTarget, "function"],
  ["readDefenderState", defenderUsecase, "function"],
  ["deployDefenderExport", defenderUsecase, "function"],
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
});
