/**
 * Contract tests for the integrate-arc module (the single-page Integrate
 * flagship's pure model - legacy-flow-analysis.md ADOPTED decision):
 *   - section metadata: seven sections numbered 1..7 in page order, the
 *     built/not-built split matches the MVP scope, shippedInUnit lives only on
 *     the not-built sections, no emojis in any copy
 *   - the full 2^5 input matrix: at most one 'current' across the page, built
 *     sections are always navigable (never 'coming-soon'), the not-built
 *     sections are ALWAYS 'coming-soon' regardless of inputs
 *   - blocked discipline: only Deploy is ever 'blocked', only when a built
 *     prerequisite is missing, and it always carries a reason naming one thing
 *   - readiness pills: the three content pills are always 'coming-soon' (never
 *     false-ok), the three operable pills track their inputs
 *   - canDeploy honors ONLY the built prerequisites (the MVP-transition rule):
 *     the not-yet-built prerequisites never block the native-table deploy
 *   - read-ahead invariants: a later blocked section never hides or blocks an
 *     earlier one; filling Cribl Config ahead of a committed scope is
 *     'available', never 'blocked'
 */
import { describe, expect, it } from "vitest";
import {
  INTEGRATE_SECTIONS,
  canDeploy,
  deriveReadinessPills,
  deriveSectionStatus,
  deriveSectionStatuses,
  integrateSection,
} from "../../index";
import type {
  IntegratePillId,
  IntegrateSectionId,
  SectionInputs,
  SectionStatus,
} from "../../index";

/** The fully-unsatisfied baseline; tests override the signals under exercise. */
function inputs(overrides: Partial<SectionInputs> = {}): SectionInputs {
  return {
    solutionSelected: false,
    scopeCommitted: false,
    workerGroupSelected: false,
    packNameSet: false,
    deployCompleted: false,
    samplesProvided: false,
    ...overrides,
  };
}

const BOOLS: readonly boolean[] = [true, false];

/** All 2^6 = 64 input records. */
function everyInputCombination(): SectionInputs[] {
  const combos: SectionInputs[] = [];
  for (const solutionSelected of BOOLS) {
    for (const scopeCommitted of BOOLS) {
      for (const workerGroupSelected of BOOLS) {
        for (const packNameSet of BOOLS) {
          for (const deployCompleted of BOOLS) {
            for (const samplesProvided of BOOLS) {
              combos.push({
                solutionSelected,
                scopeCommitted,
                workerGroupSelected,
                packNameSet,
                deployCompleted,
                samplesProvided,
              });
            }
          }
        }
      }
    }
  }
  return combos;
}

const BUILT_IDS: readonly IntegrateSectionId[] = [
  "solution",
  "sample-data",
  "azure-resources",
  "cribl-config",
  "deploy",
];
const NOT_BUILT_IDS: readonly IntegrateSectionId[] = [
  "gap-analysis",
  "rule-coverage",
];

function statusOf(id: IntegrateSectionId, i: SectionInputs): SectionStatus {
  return deriveSectionStatus(integrateSection(id), i).status;
}

// ---------------------------------------------------------------------------
// Section metadata
// ---------------------------------------------------------------------------

describe("INTEGRATE_SECTIONS metadata", () => {
  it("has seven sections numbered 1..7 in page order", () => {
    expect(INTEGRATE_SECTIONS.map((s) => s.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(INTEGRATE_SECTIONS.map((s) => s.id)).toEqual([
      "solution",
      "sample-data",
      "azure-resources",
      "cribl-config",
      "gap-analysis",
      "rule-coverage",
      "deploy",
    ]);
  });

  it("has unique ids and unique numbers", () => {
    const ids = new Set(INTEGRATE_SECTIONS.map((s) => s.id));
    const numbers = new Set(INTEGRATE_SECTIONS.map((s) => s.number));
    expect(ids.size).toBe(INTEGRATE_SECTIONS.length);
    expect(numbers.size).toBe(INTEGRATE_SECTIONS.length);
  });

  it("marks exactly solution, sample-data, azure-resources, cribl-config, deploy as built", () => {
    const built = INTEGRATE_SECTIONS.filter((s) => s.built).map((s) => s.id);
    expect(built.sort()).toEqual([...BUILT_IDS].sort());
  });

  it("puts shippedInUnit ONLY on the not-built sections, with the right units", () => {
    const unitById = new Map(
      INTEGRATE_SECTIONS.map((s) => [s.id, s.shippedInUnit]),
    );
    // built sections omit it (solution lost its shippedInUnit when Unit 14
    // landed, as sample-data did when Unit 11 landed)
    for (const id of BUILT_IDS) {
      expect(unitById.get(id)).toBeUndefined();
    }
    // not-built sections carry their roadmap unit
    expect(unitById.get("gap-analysis")).toBe(18);
    expect(unitById.get("rule-coverage")).toBe(23);
  });

  it("declares a valid requires for every section", () => {
    const valid = new Set(["azure", "cribl", "both", "none"]);
    for (const section of INTEGRATE_SECTIONS) {
      expect(valid.has(section.requires)).toBe(true);
    }
    // the operable Azure/Cribl/Deploy sections need the live connections
    expect(integrateSection("azure-resources").requires).toBe("azure");
    expect(integrateSection("cribl-config").requires).toBe("cribl");
    expect(integrateSection("deploy").requires).toBe("both");
  });

  it("gives every section a non-empty title and infoTip with no emojis", () => {
    // A broad emoji sweep across the pictographic + symbol ranges.
    // U+FE0F (variation selector) is matched via alternation, not inside the
    // class: a lone combining mark in a character class trips
    // no-misleading-character-class.
    const emoji =
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]|\u{FE0F}/u;
    for (const section of INTEGRATE_SECTIONS) {
      expect(section.title.length).toBeGreaterThan(0);
      expect(section.infoTip.length).toBeGreaterThan(0);
      expect(emoji.test(section.title)).toBe(false);
      expect(emoji.test(section.infoTip)).toBe(false);
    }
  });

  it("integrateSection round-trips and throws on an unknown id", () => {
    for (const section of INTEGRATE_SECTIONS) {
      expect(integrateSection(section.id)).toBe(section);
    }
    expect(() =>
      integrateSection("nope" as IntegrateSectionId),
    ).toThrow(/unknown integrate section/);
  });
});

// ---------------------------------------------------------------------------
// coming-soon: not-built sections, always, regardless of inputs
// ---------------------------------------------------------------------------

describe("not-built sections are always coming-soon", () => {
  it("renders coming-soon for every not-built section across the whole matrix", () => {
    for (const i of everyInputCombination()) {
      for (const id of NOT_BUILT_IDS) {
        const state = deriveSectionStatus(integrateSection(id), i);
        expect(state.status).toBe("coming-soon");
        // honest not-shipped note present and mentioning the roadmap unit
        expect(state.reason).toBeTruthy();
        expect(state.reason).toMatch(/Unit \d+/);
      }
    }
  });

  it("never renders a built section as coming-soon", () => {
    for (const i of everyInputCombination()) {
      for (const id of BUILT_IDS) {
        expect(statusOf(id, i)).not.toBe("coming-soon");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The status matrix for the built sections
// ---------------------------------------------------------------------------

describe("built-section status matrix", () => {
  it("solution: current at the page start, complete once a solution is selected", () => {
    // Solution (1) is now BUILT - it is the earliest built, incomplete,
    // actionable section, so it is the page's entry point.
    expect(statusOf("solution", inputs())).toBe("current");
    expect(
      statusOf("solution", inputs({ solutionSelected: true })),
    ).toBe("complete");
  });

  it("sample-data: available ahead of a selected solution, current once one is selected, complete once a sample is tagged", () => {
    // With Solution still incomplete it is 'current' and Sample Data is
    // read-ahead 'available'; selecting a solution advances 'current' to it.
    expect(statusOf("sample-data", inputs())).toBe("available");
    expect(
      statusOf("sample-data", inputs({ solutionSelected: true })),
    ).toBe("current");
    expect(
      statusOf("sample-data", inputs({ samplesProvided: true })),
    ).toBe("complete");
  });

  it("azure-resources: current once solution+samples are in, complete once scope committed", () => {
    // Earlier built sections still incomplete: Azure Resources is read-ahead
    // 'available'; solution selected + a tagged sample advance 'current' to it.
    expect(statusOf("azure-resources", inputs())).toBe("available");
    expect(
      statusOf(
        "azure-resources",
        inputs({ solutionSelected: true, samplesProvided: true }),
      ),
    ).toBe("current");
    expect(
      statusOf("azure-resources", inputs({ scopeCommitted: true })),
    ).toBe("complete");
  });

  it("cribl-config: available ahead of scope, current once solution+samples+scope are committed, complete when both halves set", () => {
    // nothing committed: solution is current, cribl-config is read-ahead
    expect(statusOf("cribl-config", inputs())).toBe("available");
    // solution + samples + scope committed, cribl not yet: cribl-config current
    expect(
      statusOf(
        "cribl-config",
        inputs({
          solutionSelected: true,
          samplesProvided: true,
          scopeCommitted: true,
        }),
      ),
    ).toBe("current");
    // only one half set: still not complete
    expect(
      statusOf(
        "cribl-config",
        inputs({
          solutionSelected: true,
          samplesProvided: true,
          scopeCommitted: true,
          workerGroupSelected: true,
        }),
      ),
    ).toBe("current");
    // both halves set: complete
    expect(
      statusOf(
        "cribl-config",
        inputs({ workerGroupSelected: true, packNameSet: true }),
      ),
    ).toBe("complete");
  });

  it("deploy: blocked until every prerequisite is met, then current, then complete", () => {
    expect(statusOf("deploy", inputs())).toBe("blocked");
    expect(
      statusOf("deploy", inputs({ scopeCommitted: true })),
    ).toBe("blocked");
    expect(
      statusOf(
        "deploy",
        inputs({ scopeCommitted: true, workerGroupSelected: true }),
      ),
    ).toBe("blocked");
    // all three operable prerequisites met AND solution+samples in, not yet
    // deployed: deploy is the earliest incomplete actionable section -> current
    const ready = inputs({
      solutionSelected: true,
      samplesProvided: true,
      scopeCommitted: true,
      workerGroupSelected: true,
      packNameSet: true,
    });
    expect(statusOf("deploy", ready)).toBe("current");
    // deployed: complete
    expect(statusOf("deploy", { ...ready, deployCompleted: true })).toBe(
      "complete",
    );
  });

  it("deploy's blocked reason names exactly one missing thing in dependency order", () => {
    // scope first
    expect(
      deriveSectionStatus(integrateSection("deploy"), inputs()).reason,
    ).toMatch(/Azure target/);
    // then worker group
    expect(
      deriveSectionStatus(
        integrateSection("deploy"),
        inputs({ scopeCommitted: true }),
      ).reason,
    ).toMatch(/worker group/);
    // then pack name
    expect(
      deriveSectionStatus(
        integrateSection("deploy"),
        inputs({ scopeCommitted: true, workerGroupSelected: true }),
      ).reason,
    ).toMatch(/pack name/);
  });
});

// ---------------------------------------------------------------------------
// Whole-page invariants across the full matrix
// ---------------------------------------------------------------------------

describe("read-ahead and single-current invariants", () => {
  it("has at most one 'current' section across the page for every input", () => {
    for (const i of everyInputCombination()) {
      const currents = deriveSectionStatuses(i).filter(
        (r) => r.status === "current",
      );
      expect(currents.length).toBeLessThanOrEqual(1);
    }
  });

  it("has exactly one 'current' whenever the page is not fully deployed", () => {
    for (const i of everyInputCombination()) {
      const resolved = deriveSectionStatuses(i);
      const fullyComplete = BUILT_IDS.every(
        (id) => statusOf(id, i) === "complete",
      );
      const currents = resolved.filter((r) => r.status === "current");
      expect(currents.length).toBe(fullyComplete ? 0 : 1);
    }
  });

  it("only Deploy is ever 'blocked', and always with a reason", () => {
    for (const i of everyInputCombination()) {
      for (const r of deriveSectionStatuses(i)) {
        if (r.status === "blocked") {
          expect(r.section.id).toBe("deploy");
          expect(r.reason).toBeTruthy();
        }
      }
    }
  });

  it("read-ahead: Cribl Config is never 'blocked' - it is fillable ahead of a committed scope", () => {
    for (const i of everyInputCombination()) {
      expect(statusOf("cribl-config", i)).not.toBe("blocked");
    }
  });

  it("read-ahead: a blocked Deploy never changes the earlier sections' status", () => {
    // Solution selected, Samples in and Cribl Config complete, but scope not
    // committed: Azure Resources is current; Deploy is blocked; the block on the
    // later section does not demote or hide the earlier one.
    const i = inputs({
      solutionSelected: true,
      samplesProvided: true,
      workerGroupSelected: true,
      packNameSet: true,
    });
    expect(statusOf("solution", i)).toBe("complete");
    expect(statusOf("sample-data", i)).toBe("complete");
    expect(statusOf("azure-resources", i)).toBe("current");
    expect(statusOf("cribl-config", i)).toBe("complete");
    expect(statusOf("deploy", i)).toBe("blocked");
  });

  it("blocked/coming-soon carry a reason; complete/current/available never do", () => {
    for (const i of everyInputCombination()) {
      for (const r of deriveSectionStatuses(i)) {
        if (r.status === "blocked" || r.status === "coming-soon") {
          expect(r.reason).toBeTruthy();
        } else {
          expect(r.reason).toBeUndefined();
        }
      }
    }
  });

  it("deriveSectionStatuses preserves page order and covers all seven", () => {
    const resolved = deriveSectionStatuses(inputs());
    expect(resolved.map((r) => r.section.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Readiness pills
// ---------------------------------------------------------------------------

describe("deriveReadinessPills", () => {
  // The still-not-built content pill (mappings=U18). Solution (Unit 14) and
  // Samples (Unit 11) are now built and track their inputs, so they are tested
  // separately.
  const notBuiltContentPills: readonly IntegratePillId[] = ["mappings"];
  const operablePills: readonly IntegratePillId[] = [
    "workspace",
    "worker-groups",
    "pack-name",
  ];

  it("emits the six pills in the legacy order", () => {
    expect(deriveReadinessPills(inputs()).map((p) => p.id)).toEqual([
      "solution",
      "samples",
      "mappings",
      "workspace",
      "worker-groups",
      "pack-name",
    ]);
  });

  it("keeps the still-not-built content pills 'coming-soon' for every input - never false-ok", () => {
    for (const i of everyInputCombination()) {
      const pills = deriveReadinessPills(i);
      for (const id of notBuiltContentPills) {
        const pill = pills.find((p) => p.id === id);
        expect(pill?.state).toBe("coming-soon");
      }
    }
  });

  it("lights the Solution pill 'ok' once a solution is selected, muted 'coming-soon' otherwise - never 'missing'", () => {
    for (const i of everyInputCombination()) {
      const solution = deriveReadinessPills(i).find((p) => p.id === "solution");
      expect(solution?.state).toBe(i.solutionSelected ? "ok" : "coming-soon");
      // Solution never blocks: like Samples, it is never an amber 'missing'
      // prerequisite - it does not gate the native-table deploy.
      expect(solution?.state).not.toBe("missing");
    }
  });

  it("lights the Samples pill 'ok' once samples are provided, muted 'coming-soon' otherwise - never 'missing'", () => {
    for (const i of everyInputCombination()) {
      const samples = deriveReadinessPills(i).find((p) => p.id === "samples");
      expect(samples?.state).toBe(i.samplesProvided ? "ok" : "coming-soon");
      // Samples never blocks: it is never rendered as an amber 'missing'
      // prerequisite, unlike the operable workspace/worker-group/pack pills.
      expect(samples?.state).not.toBe("missing");
    }
  });

  it("tracks the three operable pills against their inputs (ok/missing only)", () => {
    for (const i of everyInputCombination()) {
      const pills = deriveReadinessPills(i);
      const byId = new Map(pills.map((p) => [p.id, p.state]));
      expect(byId.get("workspace")).toBe(i.scopeCommitted ? "ok" : "missing");
      expect(byId.get("worker-groups")).toBe(
        i.workerGroupSelected ? "ok" : "missing",
      );
      expect(byId.get("pack-name")).toBe(i.packNameSet ? "ok" : "missing");
      // operable pills are never 'coming-soon'
      for (const id of operablePills) {
        expect(byId.get(id)).not.toBe("coming-soon");
      }
    }
  });

  it("gives every pill a non-empty label and hint", () => {
    for (const pill of deriveReadinessPills(inputs())) {
      expect(pill.label.length).toBeGreaterThan(0);
      expect(pill.hint.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// canDeploy: the MVP-transition rule
// ---------------------------------------------------------------------------

describe("canDeploy honors only the built prerequisites", () => {
  it("is true exactly when scope + worker group + pack name are all set", () => {
    for (const i of everyInputCombination()) {
      const expected =
        i.scopeCommitted && i.workerGroupSelected && i.packNameSet;
      expect(canDeploy(i)).toBe(expected);
    }
  });

  it("ignores deployCompleted - a finished run does not disable deploying again", () => {
    const ready = inputs({
      scopeCommitted: true,
      workerGroupSelected: true,
      packNameSet: true,
    });
    expect(canDeploy(ready)).toBe(true);
    expect(canDeploy({ ...ready, deployCompleted: true })).toBe(true);
  });

  it("the content prerequisites never block deploy - samples included", () => {
    // With all operable prerequisites met, canDeploy is true whether or not
    // samples are tagged, and regardless of the still-coming-soon Solution /
    // Mappings pills. This is the MVP-transition rule: the native-table deploy
    // the user validated live does not wait on samples (U11), Solution (U14),
    // or Mappings (U18).
    const base = inputs({
      scopeCommitted: true,
      workerGroupSelected: true,
      packNameSet: true,
    });
    for (const samplesProvided of [true, false]) {
      const ready = { ...base, samplesProvided };
      const stillComingSoon = deriveReadinessPills(ready)
        .filter((p) => ["solution", "mappings"].includes(p.id))
        .every((p) => p.state === "coming-soon");
      expect(stillComingSoon).toBe(true);
      // canDeploy ignores samplesProvided entirely.
      expect(canDeploy(ready)).toBe(true);
    }
  });

  it("Deploy is blocked exactly when it is not complete and cannot deploy", () => {
    for (const i of everyInputCombination()) {
      const deployStatus = statusOf("deploy", i);
      // 'blocked' <=> the run has not completed AND the operable prerequisites
      // are unmet. (Once canDeploy is true, Deploy is 'current' or read-ahead
      // 'available' - 'available' when an earlier built section, e.g. Sample
      // Data, is still incomplete; once deployCompleted it is 'complete' - the
      // degenerate deployed-without-prereqs input, which reality never
      // produces, still resolves to 'complete', not 'blocked'.)
      expect(deployStatus === "blocked").toBe(
        !i.deployCompleted && !canDeploy(i),
      );
      // and canDeploy never coexists with a blocked Deploy
      if (canDeploy(i)) {
        expect(deployStatus).not.toBe("blocked");
      }
    }
  });
});
