/**
 * Azure RBAC effective-permission evaluation - PERMISSION PREFLIGHT CONTRACT.
 *
 * The setup wizard must verify that the signed-in caller can actually perform
 * the control-plane operations a given setup path requires BEFORE it attempts
 * them. It cannot do this by inspecting role names: customers routinely use
 * custom roles, and a role named "Contributor" may be a lookalike that denies
 * the very actions we need. The only sound signal is the effective set of
 * allowed actions, which Azure exposes via the RBAC permissions API:
 *
 *   GET {scope}/providers/Microsoft.Authorization/permissions?api-version=2022-04-01
 *
 * That endpoint returns one {@link PermissionSet} element per role assignment
 * effective at {scope}. The additive/subtractive rule Azure applies is:
 *
 *   - RBAC is ADDITIVE ACROSS elements: a caller has an action if ANY element
 *     grants it. Grants from different assignments never cancel each other.
 *   - WITHIN a single element, `notActions` SUBTRACT from `actions`: the
 *     element grants an action only if some `actions` glob matches it AND no
 *     `notActions` glob in the SAME element matches it.
 *
 * Action strings use '*' wildcards that match any run of characters INCLUDING
 * '/', and matching is CASE-INSENSITIVE. This module evaluates only
 * control-plane `actions`/`notActions`; `dataActions`/`notDataActions` are
 * carried on the type for fidelity but are not consulted here.
 *
 * Pure: no IO, no fetch. The caller fetches the response and passes it in.
 */

import type { AzureSetupPath } from "../azure-config";

/**
 * One element of the RBAC permissions API response - the effective permission
 * grant contributed by a single role assignment at the queried scope.
 *
 * `actions`/`notActions` are control-plane (management) operations;
 * `dataActions`/`notDataActions` are data-plane operations. Every field is an
 * array of action-pattern strings that may contain '*' wildcards.
 */
export interface PermissionSet {
  /** Control-plane operations this assignment allows (may contain '*'). */
  actions: string[];
  /** Control-plane operations subtracted from {@link PermissionSet.actions}. */
  notActions: string[];
  /** Data-plane operations this assignment allows (not evaluated here). */
  dataActions: string[];
  /** Data-plane operations subtracted from {@link PermissionSet.dataActions}. */
  notDataActions: string[];
}

/**
 * The full body returned by the RBAC permissions API. `value` holds one
 * {@link PermissionSet} per role assignment effective at the queried scope.
 */
export interface PermissionsResponse {
  value: PermissionSet[];
}

/** Regex metacharacters that must be escaped when building a glob matcher. */
const REGEX_METACHARACTERS = /[.+?^${}()|[\]\\]/g;

/** Escape every regex metacharacter in a literal so it matches itself. */
function escapeRegExp(literal: string): string {
  return literal.replace(REGEX_METACHARACTERS, "\\$&");
}

/**
 * Test whether an Azure action-pattern glob matches a concrete action.
 *
 * The match is ANCHORED (full-string): the glob must account for the entire
 * action, not a prefix or substring. Every '*' expands to `.*`, which matches
 * any run of characters INCLUDING '/', so `Microsoft.Insights/*` matches
 * `Microsoft.Insights/dataCollectionRules/read`. All other characters are
 * treated literally (regex metacharacters are escaped). Matching is
 * CASE-INSENSITIVE, so a `notActions` entry of `Microsoft.Authorization/../Write`
 * still denies a lowercased `.../write`.
 *
 * @param glob - An action pattern such as `*`, a trailing-read glob, or `Microsoft.Insights/*`.
 * @param action - A concrete action string to test, e.g. `Microsoft.Insights/dataCollectionRules/write`.
 * @returns `true` when the glob matches the entire action string.
 */
export function actionMatchesGlob(glob: string, action: string): boolean {
  const pattern = `^${glob.split("*").map(escapeRegExp).join(".*")}$`;
  return new RegExp(pattern, "i").test(action);
}

/**
 * Determine whether a caller has effective control-plane permission for an
 * action, applying Azure's additive-across / subtractive-within rule.
 *
 * Returns `true` iff there EXISTS an element in `response.value` where some
 * `actions` glob matches `action` AND no `notActions` glob in that SAME
 * element matches `action`. A grant in one element is never cancelled by a
 * `notActions` entry in a different element (RBAC is additive across
 * assignments).
 *
 * @param response - The RBAC permissions API body for the relevant scope.
 * @param action - The concrete control-plane action to check.
 * @returns `true` when at least one element grants the action net of its own denials.
 */
export function hasEffectiveAction(
  response: PermissionsResponse,
  action: string,
): boolean {
  return response.value.some((element) => {
    const allowed = element.actions.some((glob) =>
      actionMatchesGlob(glob, action),
    );
    if (!allowed) {
      return false;
    }
    const denied = element.notActions.some((glob) =>
      actionMatchesGlob(glob, action),
    );
    return !denied;
  });
}

/**
 * How much a checked action carries.
 *
 *   core    - the setup path cannot do its primary job without it. These are
 *             what {@link coreGranted} - and therefore deploy readiness - turns
 *             on.
 *   feature - one named capability is unavailable without it; the path still
 *             works. Measured and REPORTED, never gating.
 *
 * The split exists because deploy readiness is a single boolean over the whole
 * list. Without it, adding a check for anything short of essential would report
 * "not ready" to an operator who can deploy perfectly well - turning a precise
 * signal into a blunt one, and making the check itself the thing that had to be
 * left out. Same vocabulary as the change-request ticket's [core]/[feature]
 * tags, deliberately: an operator reading both should see one distinction.
 */
export type PermissionNecessity = "core" | "feature";

/**
 * A single control-plane action the app performs, paired with a human-readable
 * label for the preflight UI.
 */
export interface RequiredAction {
  /** The exact Azure control-plane action string to check. */
  action: string;
  /** Short human-readable description shown in the preflight results. */
  label: string;
  /**
   * Whether a denial blocks the path or only costs one capability. OPTIONAL,
   * defaulting to `core`.
   *
   * Optional because core is both the common case and the CONSERVATIVE one: an
   * action added without thought gates deploy readiness, which over-reports a
   * blocker rather than hiding one. Only a deliberately-optional action carries
   * the tag, so the annotation appears exactly where the judgement was made
   * (see the lab action list, which is core throughout and says so once).
   */
  necessity?: PermissionNecessity;
}

/**
 * The setup paths the wizard offers. Each maps to the distinct set of
 * control-plane actions that path exercises, evaluated at the scope that path
 * operates on (subscription vs. resource group).
 */
export type SetupPath =
  | "existing-subscription"
  | "existing-rg"
  | "lab-new-rg-subscription"
  | "lab-byo-rg";

/**
 * The control-plane actions each setup path requires, keyed by {@link SetupPath}.
 *
 * These are the operations the app itself performs on the customer's behalf,
 * so the preflight checks EXACTLY these rather than trusting any role name:
 *
 * - `existing-subscription` - discovery only, evaluated at the subscription
 *   scope (Reader breadth is sufficient).
 * - `existing-rg` - the writes the DCR automation performs against an existing
 *   workspace resource group.
 * - `lab-new-rg-subscription` - create-new-resource-group lab mode, evaluated
 *   at the subscription scope. Note `roleAssignments/write`: plain Contributor
 *   denies it, so this path additionally requires RBAC Administrator (or Owner)
 *   to provision the lab's TTL identity.
 * - `lab-byo-rg` - bring-your-own pre-created lab resource group (Contributor
 *   on that RG covers the deploy itself).
 *
 * Entries with no `necessity` are core and gate deploy readiness; `feature`
 * entries are measured and reported without gating. Every action listed is one
 * the app actually calls - the list is not aspirational, and an action nothing
 * calls does not belong here.
 */
export const REQUIRED_ACTIONS: Record<SetupPath, RequiredAction[]> = {
  "existing-subscription": [
    {
      action: "Microsoft.Insights/dataCollectionRules/read",
      label: "Read DCRs",
    },
    {
      action: "Microsoft.OperationalInsights/workspaces/read",
      label: "Read workspaces",
    },
  ],
  "existing-rg": [
    {
      action: "Microsoft.Insights/dataCollectionRules/write",
      label: "Create/update DCRs",
    },
    {
      action: "Microsoft.OperationalInsights/workspaces/tables/write",
      label: "Create custom tables",
    },
    {
      action: "Microsoft.Resources/deployments/write",
      label: "Deploy ARM templates",
    },
    // The three below were added 2026-08-11 by the architecture audit. The
    // app-registration ticket asks for Microsoft Sentinel Contributor and RBAC
    // Administrator on this path, and NOTHING measured them - so an identity
    // holding neither passed the preflight clean and then failed at content
    // install and at the DCR grant. Ask and audit now cover the same ground.
    {
      action: "Microsoft.SecurityInsights/alertRules/write",
      label: "Install Sentinel analytic rules (Microsoft Sentinel Contributor)",
      necessity: "feature",
    },
    {
      action: "Microsoft.SecurityInsights/onboardingStates/write",
      label: "Onboard the workspace to Sentinel (Microsoft Sentinel Contributor)",
      necessity: "feature",
    },
    {
      action: "Microsoft.Authorization/roleAssignments/write",
      label: "Grant Cribl's identity access to each DCR (RBAC Administrator)",
      necessity: "feature",
    },
  ],
  "lab-new-rg-subscription": [
    {
      action: "Microsoft.Resources/subscriptions/resourceGroups/write",
      label: "Create resource groups",
    },
    {
      action: "Microsoft.Resources/deployments/write",
      label: "Deploy ARM templates",
    },
    {
      action: "Microsoft.Authorization/roleAssignments/write",
      label: "Assign roles (RBAC Administrator, for the lab TTL identity)",
      // Stays CORE on this path: without it the lab has no TTL self-destruct
      // and becomes orphaned cost, which is a reason not to deploy at all.
    },
  ],
  "lab-byo-rg": [
    {
      action: "Microsoft.Resources/deployments/write",
      label: "Deploy ARM templates",
    },
    {
      action: "Microsoft.OperationalInsights/workspaces/write",
      label: "Create workspace",
    },
    // Contributor on the lab RG cannot assign roles at any scope, which is why
    // this path's own role plan says the app cannot do it. Checked so the
    // operator learns that before deploying, not after data fails to flow.
    {
      action: "Microsoft.Authorization/roleAssignments/write",
      label: "Grant Cribl's identity access to each DCR (RBAC Administrator)",
      necessity: "feature",
    },
  ],
};

/**
 * The preflight path a configured setup path defaults to.
 *
 * The two taxonomies differ on purpose: {@link AzureSetupPath} is what the
 * operator chose, while {@link SetupPath} names a scope to evaluate at, and the
 * `existing` choice can be checked at either subscription (reads) or resource
 * group (writes). This picks the WRITE path, because deploy readiness is what
 * the preflight exists to answer; the panel lets the operator switch.
 *
 * Lives here rather than in a shell because both shells had their own identical
 * copy, and a mapping that exists twice is a mapping that can disagree twice.
 */
export function preflightPathForSetupPath(path: AzureSetupPath): SetupPath {
  switch (path) {
    case "existing":
      return "existing-rg";
    case "lab-new-rg":
      return "lab-new-rg-subscription";
    case "lab-byo-rg":
      return "lab-byo-rg";
  }
}

/**
 * Build one result from an action and a verdict - THE ONE PLACE the
 * `necessity ?? "core"` default is applied.
 *
 * Every site that turns a {@link RequiredAction} into a
 * {@link PermissionCheckResult} goes through here: the evaluator, the
 * permissions-unread fallback, the lab check, and the panel's error seed. Those
 * four had started to spell the default out individually, which is how a
 * "denied" list ends up grouping its rows differently from a measured one over
 * the same actions.
 */
export function checkResult(
  action: RequiredAction,
  granted: boolean,
): PermissionCheckResult {
  return {
    action: action.action,
    label: action.label,
    granted,
    necessity: action.necessity ?? "core",
  };
}

/** The outcome of evaluating one {@link RequiredAction} against a response. */
export interface PermissionCheckResult {
  /** The action that was checked. */
  action: string;
  /** The label carried over from the {@link RequiredAction}. */
  label: string;
  /** Whether the caller has effective permission for the action. */
  granted: boolean;
  /** Carried over from the {@link RequiredAction}, so renderers can group. */
  necessity: PermissionNecessity;
}

/**
 * Evaluate a list of required actions against an RBAC permissions response,
 * returning one result per required action (order preserved).
 *
 * @param response - The RBAC permissions API body for the relevant scope.
 * @param required - The actions the chosen setup path requires.
 * @returns One {@link PermissionCheckResult} per entry in `required`.
 */
export function evaluatePermissions(
  response: PermissionsResponse,
  required: RequiredAction[],
): PermissionCheckResult[] {
  return required.map((req) => checkResult(req, hasEffectiveAction(response, req.action)));
}

/**
 * Whether every result in an evaluation was granted, `feature` ones included.
 * An empty list is vacuously `true`.
 *
 * NOT the deploy gate - see {@link coreGranted}. This answers the narrower
 * question "is anything at all missing?", which is what a summary line needs to
 * distinguish "fully granted" from "granted, with optional gaps".
 *
 * @param results - The output of {@link evaluatePermissions}.
 * @returns `true` when no checked action was denied.
 */
export function allGranted(results: PermissionCheckResult[]): boolean {
  return results.every((result) => result.granted);
}

/**
 * Whether every CORE result was granted - the deploy-readiness predicate.
 *
 * `feature` denials are deliberately ignored here. An operator who can deploy
 * DCRs but cannot install Sentinel content is ready to deploy DCRs, and
 * reporting otherwise would be the blunt answer that kept those checks out of
 * the list in the first place. They are still measured, and still shown.
 *
 * @param results - The output of {@link evaluatePermissions}.
 * @returns `true` when no core action was denied.
 */
export function coreGranted(results: PermissionCheckResult[]): boolean {
  return results.every(
    (result) => result.necessity !== "core" || result.granted,
  );
}

/** The `feature` results that were denied, in list order. */
export function missingFeatureActions(
  results: PermissionCheckResult[],
): PermissionCheckResult[] {
  return results.filter(
    (result) => result.necessity === "feature" && !result.granted,
  );
}
