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
 * A single control-plane action the app performs, paired with a human-readable
 * label for the preflight UI.
 */
export interface RequiredAction {
  /** The exact Azure control-plane action string to check. */
  action: string;
  /** Short human-readable description shown in the preflight results. */
  label: string;
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
 *   on that RG is enough; no role assignment needed).
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
  ],
};

/** The outcome of evaluating one {@link RequiredAction} against a response. */
export interface PermissionCheckResult {
  /** The action that was checked. */
  action: string;
  /** The label carried over from the {@link RequiredAction}. */
  label: string;
  /** Whether the caller has effective permission for the action. */
  granted: boolean;
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
  return required.map((req) => ({
    action: req.action,
    label: req.label,
    granted: hasEffectiveAction(response, req.action),
  }));
}

/**
 * Whether every result in an evaluation was granted. An empty list is
 * vacuously `true`.
 *
 * @param results - The output of {@link evaluatePermissions}.
 * @returns `true` when no required action was denied.
 */
export function allGranted(results: PermissionCheckResult[]): boolean {
  return results.every((result) => result.granted);
}
