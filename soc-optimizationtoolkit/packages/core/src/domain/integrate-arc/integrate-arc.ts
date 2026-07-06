/**
 * Integrate arc - THE PURE MODEL OF THE SINGLE-PAGE INTEGRATE FLAGSHIP.
 *
 * legacy-flow-analysis.md (structural decision ADOPTED 2026-07-04): the
 * Integrate arc becomes ONE numbered-section page - Solution -> Sample Data ->
 * Azure Resources -> Cribl Config -> Gap Analysis -> Rule Coverage -> Deploy -
 * with a persistent deploy-readiness footer, matching the legacy Sentinel
 * Integration flagship (IS-R/pages/SentinelIntegration.tsx). This module is the
 * pure successor to that page's sectionDone / canDeploy chain, scoped to the
 * SECTIONS of the one page (the whole-app journey rail stays in journey-state;
 * this is the arc's interior).
 *
 * Two things this module makes HONEST during the MVP transition:
 *
 *   1. Five of the seven sections are BUILT NOW and operable (Solution, Sample
 *      Data, Azure Resources, Cribl Config, Deploy). Azure Resources / Cribl
 *      Config / Deploy are the native-table onboard the user validated live end
 *      to end; Sample Data joined them when Unit 11 shipped and Solution when
 *      Unit 14 shipped. The other two are NOT-YET-BUILT (Gap Analysis=U18, Rule
 *      Coverage=U23); they render 'coming-soon', never as a working teaser. The
 *      `built` flag on each section is the single source of truth for that split.
 *
 *   2. The deploy-readiness footer never shows a false green. A prerequisite
 *      whose section has not shipped renders as a 'coming-soon' pill, not an
 *      'ok' one - so "ready to deploy" means the OPERABLE path is ready, and
 *      the not-yet-built prerequisites are visibly pending, not silently
 *      satisfied.
 *
 * MVP-TRANSITION DEPLOY RULE (binding, documented on {@link canDeploy}): the
 * native-table deploy that already works needs ONLY a committed workspace
 * scope, a selected worker group, and a pack name. Samples do NOT block it -
 * even though Sample Data is now built and taggable, the native-table deploy
 * the user validated never needed a sample, so canDeploy ignores samples (they
 * enrich the content flow and will gate the FULL content-driven deploy once
 * gap analysis lands). The now-built-but-non-gating Solution selection (U14)
 * and the still-not-built Mappings (U18) likewise do NOT block it. This module
 * encodes that rule in exactly one place so it cannot drift.
 *
 * UNIT 14 (solution browser): the Solution section is now BUILT - the lazy
 * GitHub solution browser is its content. Its completion signal
 * (`solutionSelected`) is ADDITIVE and NON-GATING, exactly like samples: it
 * completes the Solution section and lights the Solution readiness pill, but it
 * does NOT participate in {@link canDeploy} (the native-table deploy the user
 * validated never needed a selected solution). While unselected the Solution
 * pill stays muted 'coming-soon' (never a blocking 'missing').
 *
 * READ-AHEAD contract (user decision, binding - shared with journey-state):
 * every section of the page is visible and navigable; gating happens ONLY at
 * commit actions that already live inside the composed screens (Use this
 * target, Run/Deploy). A 'blocked' status therefore means "this section's
 * commit is gated - here is the single unlock condition", NOT "you cannot look
 * at it or fill it in". Sections you can fill ahead (Cribl Config before a
 * scope is committed) are 'available', never 'blocked'.
 *
 * Pure: no IO, no fetch, no React, no Date, no crypto.
 */

/** The seven numbered sections of the single-page Integrate arc, by id. */
export type IntegrateSectionId =
  | "solution"
  | "sample-data"
  | "azure-resources"
  | "cribl-config"
  | "gap-analysis"
  | "rule-coverage"
  | "deploy";

/**
 * Which live connection a section needs to do its real work:
 *   azure - a live Azure connection (subscription/workspace/DCR APIs).
 *   cribl - a live Cribl connection (worker groups, pack install).
 *   both  - both live connections.
 *   none  - neither (content acquisition from GitHub, local sample entry).
 * This is descriptive metadata for the section header; the derivation logic
 * gates on `built` + the completion inputs, not on this field.
 */
export type SectionRequirement = "azure" | "cribl" | "both" | "none";

/** One numbered section of the Integrate page. */
export interface IntegrateSection {
  id: IntegrateSectionId;
  /** 1..7, the visible step-badge number, in page order. */
  number: number;
  /** The section title, verbatim vocabulary from the legacy flagship. */
  title: string;
  /** Concise point-of-decision help, mined from the reference. No emojis. */
  infoTip: string;
  /** The live connection the section needs (descriptive; see the type). */
  requires: SectionRequirement;
  /**
   * TRUE when the section's surface is BUILT NOW and operable in the MVP.
   * FALSE marks a not-yet-built section that renders 'coming-soon'. This is
   * the single source of truth for the built/not-built split - flip it (and
   * drop the section's coming-soon copy) when its unit lands.
   */
  built: boolean;
  /**
   * The roadmap unit that ships (or will ship) the not-yet-built section.
   * Present ONLY on not-yet-built sections; omitted on the operable three,
   * which are already here.
   */
  shippedInUnit?: number;
}

/**
 * The seven sections in page order (numbers 1..7). BUILT NOW: solution,
 * sample-data, azure-resources, cribl-config, deploy. NOT-YET-BUILT
 * (coming-soon): gap-analysis (U18), rule-coverage (U23). Order and numbering
 * match the ADOPTED single-page decision in legacy-flow-analysis.md.
 */
export const INTEGRATE_SECTIONS: readonly IntegrateSection[] = [
  {
    id: "solution",
    number: 1,
    title: "Sentinel Solution",
    infoTip:
      "Search and select a Sentinel solution. Selecting one lazily fetches " +
      "that solution's content from GitHub (never a bulk mirror) and scopes " +
      "which tables, samples, and analytics rules the rest of the page works " +
      "with. Deprecated solutions are badged with the reason.",
    requires: "none",
    built: true,
  },
  {
    id: "sample-data",
    number: 2,
    title: "Sample Data",
    infoTip:
      "Provide representative events per log type - paste a sample and name " +
      "its log type, or upload one or more files. The format is detected from " +
      "the content (Cribl capture events are unwrapped to their inner _raw), " +
      "and the discovered fields drive the gap analysis and pipeline " +
      "generation. Browsing a solution's samples arrives with the content " +
      "browser (Unit 16).",
    requires: "none",
    built: true,
  },
  {
    id: "azure-resources",
    number: 3,
    title: "Azure Resources",
    infoTip:
      "Choose the subscription, Log Analytics workspace, resource group, and " +
      "location. A live permission preflight checks DCE creation, metrics " +
      "publishing, and role assignment before any deploy.",
    requires: "azure",
    built: true,
  },
  {
    id: "cribl-config",
    number: 4,
    title: "Cribl Configuration",
    infoTip:
      "Select the Cribl worker group(s) that will run the pipelines and name " +
      "the pack that will be built and installed. The pack name is prefilled " +
      "from the solution and stays editable.",
    requires: "cribl",
    built: true,
  },
  {
    id: "gap-analysis",
    number: 5,
    title: "DCR Gap Analysis",
    infoTip:
      "Per log type, compare source fields to destination columns - " +
      "passthrough, DCR handles, Cribl handles (renames and coercions), and " +
      "overflow. Approval is required before the pack is built; Auto-Approve " +
      "All is the one-click escape hatch.",
    requires: "both",
    // BUILT NOW (Unit 18): the mapping review screen renders real content. Its
    // completion (mappingsApproved) is ADDITIVE and NON-GATING for the native
    // deploy - exactly like samples/solution - so it never regresses the MVP
    // quick-onboard path (see canDeploy vs canDeployContentPath).
    built: true,
  },
  {
    id: "rule-coverage",
    number: 6,
    title: "Analytics Rule Coverage",
    infoTip:
      "Analytics rule coverage: fully, partially, and uncovered rule counts, " +
      "per-rule severity and coverage %, and missing fields by frequency. " +
      "Upload custom YAML rules to extend coverage.",
    requires: "azure",
    built: false,
    shippedInUnit: 23,
  },
  {
    id: "deploy",
    number: 7,
    title: "Deploy",
    infoTip:
      "Review the readiness pills - Solution, Samples, Mappings, Workspace, " +
      "Worker Groups, Pack Name - then deploy every log type. Each step is " +
      "independently re-runnable.",
    requires: "both",
    built: true,
  },
];

/** Look up a section by id (throws on an unknown id - the ids are a closed set). */
export function integrateSection(id: IntegrateSectionId): IntegrateSection {
  const found = INTEGRATE_SECTIONS.find((s) => s.id === id);
  if (found === undefined) {
    throw new Error(`unknown integrate section: ${id}`);
  }
  return found;
}

/**
 * The completion facts a shell supplies about the BUILT sections. Kept small
 * and boolean-only (the read-ahead model needs completion signals, not the
 * underlying values). The not-yet-built sections contribute no signal - they
 * are 'coming-soon' regardless of any input.
 *
 * Signal -> section:
 *   scopeCommitted      -> Azure Resources complete (subscription + RG +
 *                          workspace committed via Use this target).
 *   workerGroupSelected -> Cribl Config, worker-group half satisfied.
 *   packNameSet         -> Cribl Config, pack-name half satisfied.
 *   deployCompleted     -> Deploy complete (>= 1 deploy run finished
 *                          successfully; re-running is still allowed).
 */
export interface SectionInputs {
  /**
   * A Sentinel solution has been selected in the Solution browser (Unit 14).
   * Additive and NON-GATING: it completes the now-built Solution section and
   * lights the Solution readiness pill, but - like {@link samplesProvided} - it
   * deliberately does NOT participate in {@link canDeploy}. While false, Solution
   * reads as incomplete and its pill stays a muted 'coming-soon', never 'missing'.
   */
  solutionSelected: boolean;
  /** A target scope (subscription + resource group + workspace) is committed. */
  scopeCommitted: boolean;
  /** At least one Cribl worker group is selected. */
  workerGroupSelected: boolean;
  /** A non-empty pack name is set. */
  packNameSet: boolean;
  /** At least one deploy run has completed successfully. */
  deployCompleted: boolean;
  /**
   * At least one sample has been tagged to a log type (Unit 11 sample intake).
   * Added additively: it completes the now-built Sample Data section and lights
   * the Samples readiness pill, but it deliberately does NOT participate in
   * {@link canDeploy} - the native-table deploy still runs with no samples (the
   * MVP-transition rule). While false, Sample Data reads as incomplete and the
   * Samples pill stays 'coming-soon' - never a false green.
   */
  samplesProvided: boolean;
  /**
   * Every table with mappings has been approved in the DCR Gap Analysis section
   * AND that analysis is not stale (Unit 18 mapping review; the shell derives
   * it from the content-path gate deriveMappingReviewGate().ready). ADDITIVE and
   * NON-GATING for the native deploy - exactly like {@link samplesProvided} and
   * {@link solutionSelected}: it completes the now-built Gap Analysis section
   * and lights the Mappings pill, but it deliberately does NOT participate in
   * {@link canDeploy}. It DOES gate the CONTENT path via
   * {@link canDeployContentPath}. Optional so callers that never open the
   * content flow can omit it (treated as false); while false, Gap Analysis reads
   * as incomplete and the Mappings pill stays a muted 'coming-soon', never
   * 'missing'.
   */
  mappingsApproved?: boolean;
}

/**
 * A section's status on the page:
 *
 *   complete    - the section's outcome is satisfied by the inputs.
 *   current     - the single next section to act on (at most one across the
 *                 whole page; the earliest incomplete, actionable, built one).
 *   available   - navigable and fillable now (read-ahead), just not the
 *                 current focus and not gated.
 *   blocked     - navigable, but its COMMIT is gated by a missing
 *                 prerequisite; reason names the single unlock condition.
 *   coming-soon - the section's surface has not shipped yet (built === false);
 *                 reason is the honest not-shipped note.
 */
export type SectionStatus =
  | "complete"
  | "current"
  | "available"
  | "blocked"
  | "coming-soon";

/** A section's resolved status plus a reason for 'blocked' / 'coming-soon'. */
export interface SectionState {
  status: SectionStatus;
  /** Single unlock condition (blocked) or honest not-shipped note (coming-soon). */
  reason?: string;
}

// The deploy gate mirrors the operable native-table Run gate and names exactly
// one missing thing, in dependency order (scope, then worker group, then pack).
const DEPLOY_NEEDS_SCOPE_REASON =
  "Commit an Azure target (subscription, resource group, and workspace) in " +
  "Azure Resources first.";
const DEPLOY_NEEDS_WORKER_GROUP_REASON =
  "Select a Cribl worker group in Cribl Configuration first.";
const DEPLOY_NEEDS_PACK_NAME_REASON =
  "Set a pack name in Cribl Configuration first.";

/** Honest coming-soon note per not-yet-built section (built === false). */
const COMING_SOON_REASONS: Readonly<Record<IntegrateSectionId, string>> = {
  // solution is BUILT NOW (Unit 14); it is never coming-soon.
  solution: "",
  // sample-data is BUILT NOW (Unit 11); it is never coming-soon.
  "sample-data": "",
  "azure-resources": "",
  "cribl-config": "",
  // gap-analysis is BUILT NOW (Unit 18); it is never coming-soon.
  "gap-analysis": "",
  "rule-coverage":
    "Analytics rule coverage ships with the rule-coverage analyzer (Unit 23).",
  deploy: "",
};

/** Whether a BUILT section's outcome is satisfied. Not-built sections: false. */
function sectionComplete(
  section: IntegrateSection,
  inputs: SectionInputs,
): boolean {
  if (!section.built) {
    return false;
  }
  switch (section.id) {
    case "solution":
      return inputs.solutionSelected;
    case "sample-data":
      return inputs.samplesProvided;
    case "azure-resources":
      return inputs.scopeCommitted;
    case "cribl-config":
      return inputs.workerGroupSelected && inputs.packNameSet;
    case "gap-analysis":
      // Complete when the content-path review is done (every table with
      // mappings approved and the analysis fresh). Additive: a native-only
      // operator who never engages the content flow leaves this false, which
      // never blocks canDeploy (only canDeployContentPath).
      return inputs.mappingsApproved === true;
    case "deploy":
      return inputs.deployCompleted;
    default:
      return false;
  }
}

/**
 * The Deploy commit's blocked reason, or null when its prerequisites are met.
 * Cascade order matches {@link canDeploy}: scope, then worker group, then pack
 * name. This is the ONLY built section with a gated commit - Azure Resources
 * and Cribl Config have no upstream prerequisite (they can be filled anytime).
 */
function deployBlockedReason(inputs: SectionInputs): string | null {
  if (!inputs.scopeCommitted) {
    return DEPLOY_NEEDS_SCOPE_REASON;
  }
  if (!inputs.workerGroupSelected) {
    return DEPLOY_NEEDS_WORKER_GROUP_REASON;
  }
  if (!inputs.packNameSet) {
    return DEPLOY_NEEDS_PACK_NAME_REASON;
  }
  return null;
}

/**
 * Whether a built, incomplete section is ACTIONABLE right now (its commit is
 * not gated). Azure Resources and Cribl Config are always actionable
 * (read-ahead); Deploy is actionable only when its prerequisites are met.
 */
function sectionActionable(
  section: IntegrateSection,
  inputs: SectionInputs,
): boolean {
  if (!section.built || sectionComplete(section, inputs)) {
    return false;
  }
  if (section.id === "deploy") {
    return deployBlockedReason(inputs) === null;
  }
  return true;
}

/**
 * The id of the single 'current' section, or null when nothing is actionable
 * (every built section complete, or - impossibly today - none actionable).
 * The current section is the EARLIEST (lowest number) built section that is
 * incomplete AND actionable; later incomplete-actionable sections are
 * 'available' (read-ahead), and gated ones are 'blocked'.
 */
function currentSectionId(inputs: SectionInputs): IntegrateSectionId | null {
  for (const section of INTEGRATE_SECTIONS) {
    if (sectionActionable(section, inputs)) {
      return section.id;
    }
  }
  return null;
}

/**
 * Derive one section's status from the completion inputs.
 *
 * Rules (read-ahead, honest):
 *   - not-built section  -> 'coming-soon' with its honest note, ALWAYS,
 *     regardless of inputs (a coming-soon section is never a working teaser).
 *   - built + complete   -> 'complete'.
 *   - built + incomplete + gated commit (Deploy only) -> 'blocked' with the
 *     single missing prerequisite.
 *   - built + incomplete + actionable + earliest such -> 'current'.
 *   - built + incomplete + actionable but not earliest -> 'available'.
 */
export function deriveSectionStatus(
  section: IntegrateSection,
  inputs: SectionInputs,
): SectionState {
  if (!section.built) {
    return { status: "coming-soon", reason: COMING_SOON_REASONS[section.id] };
  }
  if (sectionComplete(section, inputs)) {
    return { status: "complete" };
  }
  if (section.id === "deploy") {
    const reason = deployBlockedReason(inputs);
    if (reason !== null) {
      return { status: "blocked", reason };
    }
  }
  if (currentSectionId(inputs) === section.id) {
    return { status: "current" };
  }
  return { status: "available" };
}

/** One resolved section: its metadata plus its derived state. */
export interface ResolvedSection extends SectionState {
  section: IntegrateSection;
}

/**
 * Resolve every section in page order - the whole-page projection the shell
 * renders. Guarantees (pinned by tests): at most one 'current' across all
 * seven; exactly the not-built sections are 'coming-soon'; the built sections
 * are always navigable (never 'coming-soon').
 */
export function deriveSectionStatuses(
  inputs: SectionInputs,
): ResolvedSection[] {
  return INTEGRATE_SECTIONS.map((section) => ({
    section,
    ...deriveSectionStatus(section, inputs),
  }));
}

/** Which prerequisite a deploy-readiness pill tracks. */
export type IntegratePillId =
  | "solution"
  | "samples"
  | "mappings"
  | "workspace"
  | "worker-groups"
  | "pack-name";

/**
 * A pill's state in the readiness footer:
 *   ok          - the prerequisite is satisfied.
 *   missing     - the prerequisite's built section exists but is unsatisfied.
 *   coming-soon - the prerequisite's section has not shipped; the pill is
 *                 honestly pending, NEVER a false 'ok'.
 */
export type PillState = "ok" | "missing" | "coming-soon";

/** One deploy-readiness pill. */
export interface ReadinessPill {
  id: IntegratePillId;
  label: string;
  state: PillState;
  /** One short sentence of point-of-commitment help. */
  hint: string;
}

/**
 * The deploy-readiness footer - one pill per prerequisite, in the legacy
 * order: Solution, Samples, Mappings, Workspace, Worker Groups, Pack Name
 * (SentinelIntegration.tsx 3255-3273). Solution (Unit 14) and Samples (Unit 11)
 * are now built and track their inputs, each lighting 'ok' when satisfied and
 * staying a muted 'coming-soon' otherwise - never 'missing', because neither
 * gates the native deploy. Mappings maps to the still-not-built gap analysis
 * (Unit 18) and is always 'coming-soon' (honest, never false-ok). The three
 * operable prerequisites are 'ok' / 'missing' per inputs.
 *
 * canDeploy honors ONLY the operable three (see its docs) - the Samples and
 * still-not-built pills are visible-but-not-blocking during the MVP transition.
 */
export function deriveReadinessPills(inputs: SectionInputs): ReadinessPill[] {
  return [
    {
      id: "solution",
      label: "Solution",
      // Solution browsing shipped (Unit 14): the pill lights green once a
      // solution is selected, and stays muted 'coming-soon' (never 'missing')
      // while none is - selecting a solution enriches the content flow but does
      // NOT gate the native-table deploy (see canDeploy), so an unselected
      // Solution pill must never read as a blocking prerequisite (same rule as
      // the Samples pill).
      state: inputs.solutionSelected ? "ok" : "coming-soon",
      hint: inputs.solutionSelected
        ? "A Sentinel solution is selected."
        : "Optional for the native-table deploy. Select a solution to scope its " +
          "tables, samples, and analytics rules for the content-driven flow.",
    },
    {
      id: "samples",
      label: "Samples",
      // Sample intake shipped (Unit 11): the pill lights green once at least
      // one sample is tagged, and stays muted 'coming-soon' (never 'missing')
      // while none are - samples enrich the content flow but do NOT gate the
      // native-table deploy (see canDeploy), so an unsatisfied Samples pill
      // must never read as a blocking prerequisite.
      state: inputs.samplesProvided ? "ok" : "coming-soon",
      hint: inputs.samplesProvided
        ? "At least one sample is tagged to a log type."
        : "Optional for the native-table deploy. Tag a sample in Sample Data to " +
          "drive the gap analysis and pipeline generation.",
    },
    {
      id: "mappings",
      label: "Mappings",
      // Gap analysis shipped (Unit 18): the pill lights green once every table
      // with mappings is approved (and the analysis is fresh), and stays muted
      // 'coming-soon' (never 'missing') otherwise - approving mappings gates the
      // CONTENT path (canDeployContentPath) but NOT the native-table deploy
      // (canDeploy), so an unapproved Mappings pill must never read as a
      // blocking prerequisite (the same rule as Samples and Solution).
      state: inputs.mappingsApproved === true ? "ok" : "coming-soon",
      hint:
        inputs.mappingsApproved === true
          ? "Every table's field mappings are approved."
          : "Optional for the native-table deploy. Approve each table's field " +
            "mappings in DCR Gap Analysis to unlock the content-driven deploy.",
    },
    {
      id: "workspace",
      label: "Workspace",
      state: inputs.scopeCommitted ? "ok" : "missing",
      hint: inputs.scopeCommitted
        ? "Target workspace scope committed."
        : "Commit a subscription, resource group, and workspace in Azure Resources.",
    },
    {
      id: "worker-groups",
      label: "Worker Groups",
      state: inputs.workerGroupSelected ? "ok" : "missing",
      hint: inputs.workerGroupSelected
        ? "At least one worker group selected."
        : "Select a Cribl worker group in Cribl Configuration.",
    },
    {
      id: "pack-name",
      label: "Pack Name",
      state: inputs.packNameSet ? "ok" : "missing",
      hint: inputs.packNameSet
        ? "Pack name set."
        : "Set a pack name in Cribl Configuration.",
    },
  ];
}

/**
 * Whether the OPERABLE native-table deploy can run.
 *
 * MVP-TRANSITION RULE (binding): true exactly when the three BUILT-AND-GATING
 * prerequisites are met - a committed workspace scope, a selected worker
 * group, and a pack name. Samples do NOT participate even though Sample Data is
 * now built (Unit 11): the native-table onboard the user validated live end to
 * end never needed a sample, so requiring one here would regress a working
 * flow. The now-built Solution selection (U14) and the still-not-built Mappings
 * (U18) do not participate either; when the content flow is complete, the FULL
 * content-driven deploy will gate on solution, samples, and mappings, but that
 * is a future usecase, not this rule. This is
 * the ONE place the native-deploy rule lives, so canDeploy and the readiness
 * footer can never disagree.
 *
 * Note: deployCompleted is intentionally NOT a factor - a finished run does
 * not disable deploying again (each step is independently re-runnable).
 */
export function canDeploy(inputs: SectionInputs): boolean {
  return (
    inputs.scopeCommitted &&
    inputs.workerGroupSelected &&
    inputs.packNameSet
  );
}

/**
 * Whether the CONTENT / mapping-driven flagship path can deploy - the ADDITIVE
 * gate Unit 18 layers on TOP of {@link canDeploy} without weakening it.
 *
 * True exactly when the native prerequisites are met (canDeploy) AND every table
 * with mappings has been approved and the analysis is fresh (mappingsApproved).
 * This is the ONLY place the content path folds mapping approval into
 * readiness; the native quick-onboard path uses {@link canDeploy}, which NEVER
 * reads mappingsApproved. The strict partition (native deploys with zero
 * approvals; the content path blocks until approved) is pinned by tests on both
 * sides - here and in the mapping-review-state gate.
 *
 * Note this is a STRICT superset condition: canDeployContentPath(i) implies
 * canDeploy(i), never the reverse. A shell chooses which gate to honor by which
 * path the operator is on; it must not require this for the native path.
 */
export function canDeployContentPath(inputs: SectionInputs): boolean {
  return canDeploy(inputs) && inputs.mappingsApproved === true;
}
