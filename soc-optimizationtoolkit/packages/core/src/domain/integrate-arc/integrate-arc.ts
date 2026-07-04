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
 *   1. Only three of the seven sections are BUILT NOW and operable
 *      (Azure Resources, Cribl Config, Deploy - the native-table onboard the
 *      user validated live end to end). The other four are NOT-YET-BUILT
 *      (Solution=U14, Sample Data=U11, Gap Analysis=U18, Rule Coverage=U23);
 *      they render 'coming-soon', never as a working teaser. The `built` flag
 *      on each section is the single source of truth for that split.
 *
 *   2. The deploy-readiness footer never shows a false green. A prerequisite
 *      whose section has not shipped renders as a 'coming-soon' pill, not an
 *      'ok' one - so "ready to deploy" means the OPERABLE path is ready, and
 *      the not-yet-built prerequisites are visibly pending, not silently
 *      satisfied.
 *
 * MVP-TRANSITION DEPLOY RULE (binding, documented on {@link canDeploy}): the
 * native-table deploy that already works needs ONLY the built prerequisites -
 * a committed workspace scope, a selected worker group, and a pack name. The
 * not-yet-built prerequisites (samples, mappings, solution) do NOT block it;
 * they will gate the FULL content-driven deploy once Units 11/14/18 land, but
 * gating on them today would break the flow the user already validated. This
 * module encodes that rule in exactly one place so it cannot drift.
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
 * The seven sections in page order (numbers 1..7). BUILT NOW: azure-resources,
 * cribl-config, deploy. NOT-YET-BUILT (coming-soon): solution (U14),
 * sample-data (U11), gap-analysis (U18), rule-coverage (U23). Order and
 * numbering match the ADOPTED single-page decision in legacy-flow-analysis.md.
 */
export const INTEGRATE_SECTIONS: readonly IntegrateSection[] = [
  {
    id: "solution",
    number: 1,
    title: "Sentinel Solution",
    infoTip:
      "Search and select a Sentinel solution (452 active / 97 deprecated). " +
      "The chosen solution scopes which tables, samples, and analytics rules " +
      "the rest of the page works with.",
    requires: "none",
    built: false,
    shippedInUnit: 14,
  },
  {
    id: "sample-data",
    number: 2,
    title: "Sample Data",
    infoTip:
      "Provide representative events per log type - paste, upload, or browse " +
      "the solution's samples. Sample fields drive the gap analysis and " +
      "pipeline generation. Select a solution first.",
    requires: "none",
    built: false,
    shippedInUnit: 11,
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
    built: false,
    shippedInUnit: 18,
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
  /** A target scope (subscription + resource group + workspace) is committed. */
  scopeCommitted: boolean;
  /** At least one Cribl worker group is selected. */
  workerGroupSelected: boolean;
  /** A non-empty pack name is set. */
  packNameSet: boolean;
  /** At least one deploy run has completed successfully. */
  deployCompleted: boolean;
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
  solution:
    "Solution search and selection ships with the GitHub content browser (Unit 14).",
  "sample-data":
    "Sample intake (paste, upload, browse) ships with the sample parser (Unit 11).",
  "azure-resources": "",
  "cribl-config": "",
  "gap-analysis":
    "DCR gap analysis and the mapping-approval gate ship with the field matcher (Unit 18).",
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
    case "azure-resources":
      return inputs.scopeCommitted;
    case "cribl-config":
      return inputs.workerGroupSelected && inputs.packNameSet;
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
 * (SentinelIntegration.tsx 3255-3273). The three content prerequisites map to
 * not-yet-built sections and are therefore 'coming-soon' (honest, never
 * false-ok); the three operable prerequisites are 'ok' / 'missing' per inputs.
 *
 * canDeploy honors ONLY the operable three (see its docs) - the coming-soon
 * pills are visible-but-not-blocking during the MVP transition.
 */
export function deriveReadinessPills(inputs: SectionInputs): ReadinessPill[] {
  return [
    {
      id: "solution",
      label: "Solution",
      state: "coming-soon",
      hint: "Solution selection ships with the content browser (Unit 14).",
    },
    {
      id: "samples",
      label: "Samples",
      state: "coming-soon",
      hint: "Sample intake ships with the sample parser (Unit 11).",
    },
    {
      id: "mappings",
      label: "Mappings",
      state: "coming-soon",
      hint: "Field-mapping approval ships with the gap analysis (Unit 18).",
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
 * MVP-TRANSITION RULE (binding): true exactly when the three BUILT
 * prerequisites are met - a committed workspace scope, a selected worker
 * group, and a pack name. The not-yet-built prerequisites (Solution, Samples,
 * Mappings) do NOT participate: the native-table onboard the user validated
 * live end to end never needed them, and gating on them today would regress a
 * working flow. When Units 11/14/18 land, their sections flip to built and
 * their pills flip from 'coming-soon' to 'ok'/'missing'; only then does the
 * FULL content-driven deploy gate on them. This is the ONE place that rule
 * lives, so canDeploy and the readiness footer can never disagree.
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
