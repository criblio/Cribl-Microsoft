/**
 * Pins for the How-to pure state (AZR-31, ADR 0007 D1/D2/D5). Each pin names
 * the behaviour it holds; the mutation checks run against this file are
 * recorded in the unit's output.
 */

import { describe, expect, it } from "vitest";
import {
  ONBOARDING_PROGRESS_KIND,
  ONBOARDING_PROGRESS_VERSION,
  ONBOARDING_SOURCES,
  copyCheckTexts,
  emptyProgress,
  encodeProgress,
  howToStep,
  isAutomatable,
  otherNameAlsoFound,
  withPlanValues,
  withSourceChosen,
  withSourceMode,
  withTick,
} from "@soc/core";
import type {
  CoverageSelection,
  KvDocumentLoad,
  OnboardingProgress,
  ValidationResult,
} from "@soc/core";
import { findHistoryInCopy, describeViolations } from "../../../components/copy-rules";
import type { CopyEntry } from "../../../components/copy-rules";
import {
  AGGREGATE_VERDICT_WORD,
  AUTOMATE_LOCKED_REASON,
  MODE_CHOICE_NOT_CARRIED,
  PROGRESS_FAILED_REASON,
  PROGRESS_LOADING_REASON,
  UNVERIFIED_TAG,
  applyPlanValues,
  canWriteProgress,
  chooserRows,
  chosenSourceIds,
  progressBanners,
  progressBlockedReason,
  progressLoadStateFrom,
  progressSummary,
  setChosen,
  setMode,
  stepDialogView,
  stepRows,
  toggleTick,
  withSavedProgress,
} from "./howto-state";
import type { ProgressLoadState } from "./howto-state";

const SELECTION: CoverageSelection = {
  mode: "Centralized",
  enabled: [],
  subSelections: {},
};

function valueLoad(progress: OnboardingProgress): KvDocumentLoad {
  return { kind: "value", value: JSON.parse(encodeProgress(progress)) };
}

function ready(progress: OnboardingProgress): ProgressLoadState {
  return progressLoadStateFrom(valueLoad(progress));
}

const VALUES = {
  ...emptyProgress().planValues,
  subscriptionId: "sub-1",
  resourceGroup: "rg-1",
  namespace: "ns1",
  region: "eastus",
};

function manualEntra(): OnboardingProgress {
  return withPlanValues(withSourceChosen(withSourceMode(emptyProgress(), "entraId", "manual"), "entraId", true), VALUES);
}

describe("progress load gate", () => {
  it("null load is loading and blocks writes", () => {
    const s = progressLoadStateFrom(null);
    expect(s.status).toBe("loading");
    expect(canWriteProgress(s)).toBe(false);
  });

  it("absent and ours-readable allow writes", () => {
    expect(canWriteProgress(progressLoadStateFrom({ kind: "absent", why: "not-found" }))).toBe(true);
    expect(canWriteProgress(ready(emptyProgress()))).toBe(true);
  });

  it("read-unknown, foreign and unreadable block writes, and every transition returns null", () => {
    const states: ProgressLoadState[] = [
      progressLoadStateFrom({ kind: "unknown", reason: "HTTP 403" }),
      progressLoadStateFrom({ kind: "value", value: { kind: "azure-coverage-selection", version: 1 } }),
      progressLoadStateFrom({ kind: "value", value: { kind: ONBOARDING_PROGRESS_KIND, version: 2 } }),
    ];
    expect(states.map((s) => s.status)).toEqual(["read-unknown", "doc-foreign", "doc-unreadable"]);
    for (const s of states) {
      expect(canWriteProgress(s)).toBe(false);
      expect(toggleTick(s, "eh-namespace", true)).toBeNull();
      expect(setMode(s, SELECTION, "entraId", "manual")).toBeNull();
      expect(applyPlanValues(s, VALUES)).toBeNull();
      expect(setChosen(s, SELECTION, "entraId", true).kind).toBe("blocked");
      const banners = progressBanners(s);
      expect(banners).toHaveLength(1);
      expect(banners[0].tone).toBe("error");
      expect(banners[0].text).toContain("turned off");
    }
  });

  it("a blocked load disables every step checkbox with a visible reason", () => {
    const rows = stepRows(manualEntra(), SELECTION, { canWrite: false });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.tickDisabled).toBe(true);
      expect(r.tickDisabledReason).not.toBeNull();
    }
    expect(stepRows(manualEntra(), SELECTION, { canWrite: true }).every((r) => !r.tickDisabled)).toBe(true);
  });

  it("a pending load is described as loading, never as failed", () => {
    expect(PROGRESS_LOADING_REASON).not.toBe(PROGRESS_FAILED_REASON);
    const loading = progressLoadStateFrom(null);
    expect(progressBlockedReason(loading)).toBe(PROGRESS_LOADING_REASON);
    const blocked = setChosen(loading, SELECTION, "entraId", true);
    expect(blocked.kind === "blocked" ? blocked.reason : null).toBe(PROGRESS_LOADING_REASON);
    for (const s of [
      progressLoadStateFrom({ kind: "unknown", reason: "HTTP 403" }),
      progressLoadStateFrom({ kind: "value", value: { kind: "x", version: 1 } }),
      progressLoadStateFrom({ kind: "value", value: { kind: ONBOARDING_PROGRESS_KIND, version: 9 } }),
    ]) {
      expect(progressBlockedReason(s)).toBe(PROGRESS_FAILED_REASON);
      const b = setChosen(s, SELECTION, "entraId", true);
      expect(b.kind === "blocked" ? b.reason : null).toBe(PROGRESS_FAILED_REASON);
    }
    expect(progressBlockedReason(ready(emptyProgress()))).toBeNull();
    const reason = progressBlockedReason(loading);
    const rows = stepRows(manualEntra(), SELECTION, { canWrite: false, blockedReason: reason });
    expect(rows.every((r) => r.tickDisabledReason === PROGRESS_LOADING_REASON)).toBe(true);
    const v = stepDialogView(rows[0].id, manualEntra(), SELECTION, { canWrite: false, blockedReason: reason })!;
    expect(v.tickDisabledReason).toBe(PROGRESS_LOADING_REASON);
  });

  it("dropped ids are reported as a warning", () => {
    const s = progressLoadStateFrom({
      kind: "value",
      value: { kind: ONBOARDING_PROGRESS_KIND, version: ONBOARDING_PROGRESS_VERSION, sources: { gone: { chosen: true, mode: "manual" } } },
    });
    const b = progressBanners(s);
    expect(b).toHaveLength(1);
    expect(b[0].tone).toBe("warning");
    expect(b[0].text).toContain("sources.gone");
  });

  it("withSavedProgress turns absent into ready with the saved progress", () => {
    const p = manualEntra();
    const s = withSavedProgress(progressLoadStateFrom({ kind: "absent", why: "not-found" }), p);
    expect(s.status).toBe("ready");
    expect(s.status === "ready" ? s.progress : null).toBe(p);
  });
});

describe("chooser rows (D2)", () => {
  it("one row per source in catalog order; modeLocked equals !isAutomatable for every id", () => {
    const rows = chooserRows(emptyProgress(), SELECTION);
    expect(rows.map((r) => r.id)).toEqual(ONBOARDING_SOURCES.map((s) => s.id));
    for (const r of rows) {
      expect(r.modeLocked).toBe(!isAutomatable(r.id));
      expect(r.modeLockedReason).toBe(r.modeLocked ? AUTOMATE_LOCKED_REASON : null);
    }
  });

  it("the Entra row is locked to How-to with its reason", () => {
    const entra = chooserRows(emptyProgress(), SELECTION).find((r) => r.id === "entraId")!;
    expect(entra.modeLocked).toBe(true);
    expect(entra.mode).toBe("manual");
    expect(entra.modeLockedReason).toBe(AUTOMATE_LOCKED_REASON);
  });

  it("the Defender row's chosen state follows its mode", () => {
    const withDefender: CoverageSelection = { ...SELECTION, enabled: ["defenderExport"] };
    // Automated (default for an automatable source): chosen comes from the selection.
    let row = chooserRows(emptyProgress(), withDefender).find((r) => r.id === "defenderExport")!;
    expect(row.mode).toBe("automate");
    expect(row.chosenBy).toBe("selection");
    expect(row.chosen).toBe(true);
    expect(chooserRows(emptyProgress(), SELECTION).find((r) => r.id === "defenderExport")!.chosen).toBe(false);
    // How-to: the selection no longer decides; the progress document does.
    const manual = withSourceMode(emptyProgress(), "defenderExport", "manual");
    row = chooserRows(manual, withDefender).find((r) => r.id === "defenderExport")!;
    expect(row.chosenBy).toBe("progress");
    expect(row.chosen).toBe(false);
    row = chooserRows(withSourceChosen(manual, "defenderExport", true), SELECTION).find(
      (r) => r.id === "defenderExport",
    )!;
    expect(row.chosen).toBe(true);
  });

  it("setMode refuses automate on a non-automatable source and carries chosen into How-to", () => {
    const s = ready(emptyProgress());
    expect(setMode(s, SELECTION, "entraId", "automate")).toBeNull();
    const withDefender: CoverageSelection = { ...SELECTION, enabled: ["defenderExport"] };
    const p = setMode(s, withDefender, "defenderExport", "manual")!;
    expect(p.progress.sources.defenderExport).toEqual({ chosen: true, mode: "manual" });
    expect(p.selection).toBeNull();
  });

  it("setMode How-to -> Automated carries a How-to choice back into a staged selection", () => {
    const manualChosen = withSourceChosen(withSourceMode(emptyProgress(), "defenderExport", "manual"), "defenderExport", true);
    const s = ready(manualChosen);
    const change = setMode(s, SELECTION, "defenderExport", "automate")!;
    expect(change.progress.sources.defenderExport?.mode).toBe("automate");
    expect(change.selection?.enabled).toEqual(["defenderExport"]);
    expect(change.notice).toBeNull();
    // The staged selection keeps the row chosen once the screen stages it.
    const row = chooserRows(change.progress, change.selection).find((r) => r.id === "defenderExport")!;
    expect(row.chosen).toBe(true);
    // An unchosen How-to source stays unchosen.
    const unchosen = setMode(ready(withSourceMode(emptyProgress(), "defenderExport", "manual")), SELECTION, "defenderExport", "automate")!;
    expect(unchosen.selection?.enabled).toEqual([]);
    // Without a loaded selection the choice cannot be carried, and it says so.
    const noSel = setMode(s, null, "defenderExport", "automate")!;
    expect(noSel.selection).toBeNull();
    expect(noSel.notice).toBe(MODE_CHOICE_NOT_CARRIED);
  });

  it("setChosen writes progress for How-to and the selection for Automated", () => {
    const s = ready(emptyProgress());
    const howto = setChosen(s, SELECTION, "vnetFlowLogs", true);
    expect(howto.kind).toBe("progress");
    expect(howto.kind === "progress" ? howto.progress.sources.vnetFlowLogs?.chosen : null).toBe(true);
    const auto = setChosen(s, SELECTION, "defenderExport", true);
    expect(auto.kind).toBe("selection");
    expect(auto.kind === "selection" ? auto.selection.enabled : null).toEqual(["defenderExport"]);
    expect(setChosen(s, null, "defenderExport", true).kind).toBe("blocked");
  });

  it("chosenSourceIds combines both modes in catalog order", () => {
    const p = withSourceChosen(emptyProgress(), "vnetFlowLogs", true);
    expect(chosenSourceIds(p, { ...SELECTION, enabled: ["defenderExport"] })).toEqual([
      "defenderExport",
      "vnetFlowLogs",
    ]);
  });
});

describe("step rows and stale ticks (D5)", () => {
  it("only chosen How-to sources contribute steps", () => {
    expect(stepRows(emptyProgress(), SELECTION, { canWrite: true })).toEqual([]);
    // Automated Defender contributes nothing even though it is chosen.
    expect(stepRows(emptyProgress(), { ...SELECTION, enabled: ["defenderExport"] }, { canWrite: true })).toEqual([]);
    const ids = stepRows(manualEntra(), SELECTION, { canWrite: true }).map((r) => r.id);
    expect(ids).toContain("eh-namespace");
    expect(ids).toContain("entra-setting");
  });

  it("a tick goes stale only when a dependsOn key changes, names it, and does not count", () => {
    const step = howToStep("eh-namespace")!;
    const ticked = toggleTick(ready(manualEntra()), "eh-namespace", true)!;
    let row = stepRows(ticked, SELECTION, { canWrite: true }).find((r) => r.id === "eh-namespace")!;
    expect(row.done).toBe(true);
    expect(row.staleNote).toBeNull();

    // A key the step does NOT depend on changes: still done.
    expect(step.dependsOnValues).not.toContain("storageAccount");
    const unrelated = withPlanValues(ticked, { ...ticked.planValues, storageAccount: "acct" });
    row = stepRows(unrelated, SELECTION, { canWrite: true }).find((r) => r.id === "eh-namespace")!;
    expect(row.done).toBe(true);

    // A dependsOn key changes: stale, named, not done.
    const changed = withPlanValues(ticked, { ...ticked.planValues, namespace: "ns2" });
    row = stepRows(changed, SELECTION, { canWrite: true }).find((r) => r.id === "eh-namespace")!;
    expect(row.done).toBe(false);
    expect(row.tick.status).toBe("stale");
    expect(row.staleNote).toContain("Event Hub namespace");
    expect(row.staleNote).not.toContain("Region");

    const summary = progressSummary(stepRows(changed, SELECTION, { canWrite: true }));
    expect(summary.done).toBe(0);
    expect(summary.stale).toBe(1);
    expect(summary.text).toContain("0 of");
  });

  it("unticking removes the tick", () => {
    const ticked = toggleTick(ready(manualEntra()), "eh-namespace", true)!;
    const unticked = toggleTick(ready(ticked), "eh-namespace", false)!;
    expect(unticked.ticks["eh-namespace"]).toBeUndefined();
    expect(toggleTick(ready(ticked), "no-such-step", true)).toBeNull();
  });

  it("verdict words: not checked yet, as expected, could not be read", () => {
    const p = manualEntra();
    const word = (result: ValidationResult | null) =>
      stepRows(p, SELECTION, { canWrite: true, result }).find((r) => r.id === "eh-namespace")!.verdictWord;
    expect(word(null)).toBe("not checked yet");
    const base = { verdicts: {}, measuredHubs: [], arrival: {}, cancelled: false };
    const check = (verdict: ValidationResult["checks"][number]["verdict"]) => ({
      ...base,
      checks: [{ key: "k", sourceId: "entraId" as const, stepId: "eh-namespace", kind: "eh-namespace" as const, verdict }],
    });
    expect(word(check({ kind: "as-expected" }))).toBe("as expected");
    expect(word(check({ kind: "unknown", reason: "denied", detail: "403" }))).toBe("could not be read");
    expect(word(check({ kind: "absent" }))).toBe("not found");
    expect(word(check({ kind: "unknown", reason: "missing-value", detail: "" }))).toBe(
      "not checked: values missing",
    );
    const diffs = [{ field: "sku", expected: "Standard", actual: "Basic" }];
    expect(word(check({ kind: "present-differs", diffs }))).toBe("present but different");
    expect(word(check({ kind: "present-other-name", name: "OldExport", diffs: [] }))).toBe(
      "exists under another name: OldExport",
    );
    // DBT-189: the step word counts the others too, in core's shared words
    // and the check's own unit, as Validate and the lane do.
    const counted = (kind: "eh-namespace" | "entra-setting") => ({
      ...base,
      checks: [
        { key: "k0", sourceId: "entraId" as const, stepId: "eh-namespace", kind: "eh-namespace" as const, verdict: { kind: "as-expected" as const } },
        {
          key: "k1",
          sourceId: "entraId" as const,
          stepId: "eh-namespace",
          kind,
          verdict: { kind: "present-other-name" as const, name: "OldExport", diffs: [], alsoFound: 3 },
        },
      ],
    });
    expect(otherNameAlsoFound(3, "entra-setting")).toBe("3 other diagnostic settings like it were also found");
    expect(word(counted("entra-setting"))).toBe(
      "exists under another name: OldExport; 3 other diagnostic settings like it were also found",
    );
    expect(word(counted("eh-namespace"))).toBe(
      "exists under another name: OldExport; 3 other objects like it were also found",
    );
    const words = Object.values(AGGREGATE_VERDICT_WORD);
    expect(words).toHaveLength(4);
    expect(new Set(words).size).toBe(4);
  });

  it("inferred steps carry the visible unconfirmed tag", () => {
    const p = withSourceChosen(emptyProgress(), "vnetFlowLogs", true);
    const rows = stepRows(p, SELECTION, { canWrite: true });
    const inferred = rows.filter((r) => r.provenance === "inferred");
    expect(inferred.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.tag).toBe(r.provenance === "inferred" ? UNVERIFIED_TAG : null);
  });
});

describe("step dialog view", () => {
  it("shows <key> placeholders for unset values and names them", () => {
    const p = withSourceChosen(emptyProgress(), "entraId", true);
    const v = stepDialogView("eh-namespace", p, SELECTION, { canWrite: true })!;
    expect(v.rendered.cli).toContain("<namespace>");
    expect(v.rendered.cli).not.toContain("undefined");
    expect(v.missingNote).toContain("Event Hub namespace");
    expect(v.doneLabel).toBe("Mark as done");
    expect(v.checked).toBe(false);
  });

  it("with values set there is no missing note and the value is filled in", () => {
    const v = stepDialogView("eh-namespace", manualEntra(), SELECTION, { canWrite: true })!;
    expect(v.rendered.cli).toContain("ns1");
    expect(v.missingNote).toBeNull();
  });

  it("unknown step id is null", () => {
    expect(stepDialogView("nope", emptyProgress(), SELECTION, { canWrite: true })).toBeNull();
  });
});

describe("visible copy carries no history", () => {
  it("findHistoryInCopy finds nothing in any produced string", () => {
    const entries: CopyEntry[] = [];
    const add = (where: string, text: string | null | undefined) => {
      if (text) entries.push({ where, text });
    };
    const allChosen = ONBOARDING_SOURCES.reduce(
      (p, s) => withSourceChosen(withSourceMode(p, s.id, "manual"), s.id, true),
      withPlanValues(emptyProgress(), VALUES),
    );
    const ticked = withTick(allChosen, "eh-namespace", ["namespace"]);
    const stale = withPlanValues(ticked, { ...ticked.planValues, namespace: "other" });
    for (const s of [
      progressLoadStateFrom({ kind: "unknown", reason: "HTTP 403" }),
      progressLoadStateFrom({ kind: "value", value: { kind: "x", version: 1 } }),
      progressLoadStateFrom({ kind: "value", value: { kind: ONBOARDING_PROGRESS_KIND, version: 9 } }),
      progressLoadStateFrom({ kind: "value", value: { kind: ONBOARDING_PROGRESS_KIND, version: 1, extra: 1 } }),
    ]) {
      for (const b of progressBanners(s)) add(`banner ${s.status}`, b.text);
    }
    for (const r of chooserRows(stale, SELECTION)) {
      add(`chooser ${r.id}`, r.title);
      add(`chooser ${r.id}`, r.transportLabel);
      add(`chooser ${r.id}`, r.modeLockedReason);
      add(`chooser ${r.id}`, r.info);
    }
    const rows = [
      ...stepRows(stale, SELECTION, { canWrite: true }),
      ...stepRows(stale, SELECTION, { canWrite: false }),
    ];
    for (const r of rows) {
      for (const t of [r.title, r.tag, r.staleNote, r.verdictWord, r.tickDisabledReason, ...r.sourceTitles]) {
        add(`step ${r.id}`, t);
      }
      const v = stepDialogView(r.id, stale, SELECTION, { canWrite: false })!;
      for (const t of copyCheckTexts(v.rendered)) add(`dialog ${r.id}`, t);
      for (const t of [v.doneLabel, v.staleNote, v.tag, v.missingNote, v.tickDisabledReason]) add(`dialog ${r.id}`, t);
    }
    add("summary", progressSummary(rows).text);
    add("summary empty", progressSummary([]).text);
    const blocked = setChosen(progressLoadStateFrom(null), SELECTION, "entraId", true);
    if (blocked.kind === "blocked") add("setChosen", blocked.reason);
    add("blocked failed", PROGRESS_FAILED_REASON);
    add("mode notice", MODE_CHOICE_NOT_CARRIED);
    for (const w of Object.values(AGGREGATE_VERDICT_WORD)) add("verdict word", w);
    expect(entries.length).toBeGreaterThan(50);
    const violations = findHistoryInCopy(entries);
    expect(violations, describeViolations(violations)).toEqual([]);
  });
});
