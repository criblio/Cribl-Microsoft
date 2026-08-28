/**
 * Onboarding selection - THE ADDITIVE-ONLY CONTRACT.
 *
 * backlog.md#6h, decided by the user 2026-08-12 and binding: the Azure native
 * source onboarding checkboxes only ever DEPLOY. Unticking a box removes it
 * from the desired selection and does NOTHING to Azure. Teardown lives in an
 * explicit, separately confirmed Remove action. **No checkbox may ever destroy
 * anything.**
 *
 * WHY IT IS SHAPED THIS WAY. The obvious implementation of a checkbox screen
 * is a reconcile: diff desired against actual, add what appeared, remove what
 * vanished. That is what every infrastructure tool does, and here it would be a
 * data-loss bug with a friendly UI - an operator unticking a box to tidy the
 * list would silently tear down a diagnostic setting that is someone's only
 * copy of an audit trail. So the diff is deliberately HALF a diff.
 *
 * The contract is carried by the TYPES, not only by the tests. {@link DeployPlan}
 * has no removal field for {@link deployPlan} to populate - a removal is not
 * something this path declines to emit, it is something it cannot express. The
 * pins then prove the weaker, checkable thing: that no input produces one. A
 * future edit that wants to remove from a selection change has to add a field
 * to the plan type first, which is a visible act in review rather than a
 * one-line condition someone reads past.
 *
 * SELECTION AND DEPLOYMENT ARE INDEPENDENT AXES. The legacy tool conflated
 * them and so did the first draft of the screen: an unticked box read as "not
 * there", which is the confident-wrong-answer shape item 4 of the backlog is
 * about. They are four states here, and {@link itemState} is the only thing
 * that names them. In particular `deployed-unselected` is a REAL, reachable,
 * stable state - it is what unticking produces - and the UI has to say so,
 * because it is the state in which an operator most needs to be told that the
 * thing is still running in Azure and that Remove is where it goes away.
 *
 * The mirror image of that is `pending`: selected but not yet deployed. Neither
 * may render as the other, and neither may render as plain "off".
 *
 * This module models the CONTRACT. It does not model the catalog of what can be
 * selected - that is AZR-0, which ports `resource-coverage.json` - and it does
 * not model prerequisite ordering between sections, which backlog.md#6h flags as
 * real and mostly implicit and which nothing here addresses yet.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto.
 */

/** Opaque id of a selectable onboarding item; the caller owns the vocabulary. */
export type OnboardingItemId = string;

/**
 * The four states of a selectable item. Selection and deployment are
 * independent, so the cross product is four, not two:
 *
 *   unselected           not selected, not deployed. Nothing exists, nothing
 *                        is planned. The only state that is plainly "off".
 *   pending              selected, not deployed. The next deploy adds it.
 *   deployed             selected and deployed. Steady state.
 *   deployed-unselected  DEPLOYED, then unticked. Still running in Azure.
 *                        Unticking moved it here and did nothing else. Only the
 *                        Remove action changes it, and only with confirmation.
 *
 * `deployed-unselected` is the state this whole module exists to keep
 * distinguishable. Rendering it as `unselected` is the data-loss bug wearing a
 * checkbox: the operator believes the thing is gone while it is still emitting.
 */
export type ItemState = "unselected" | "pending" | "deployed" | "deployed-unselected";

/**
 * What a deploy will do. There is NO removal field, on purpose - see the module
 * docblock. Adding one is the single edit that would break the contract, which
 * is exactly why it has to be an edit to this type.
 */
export interface DeployPlan {
  /** Items to create, in the order given by `desired`. Never contains a duplicate. */
  readonly add: readonly OnboardingItemId[];
  /**
   * Already deployed and still selected: nothing to do. Reported so a screen
   * can say "12 already in place" rather than showing an empty plan and
   * implying nothing is deployed.
   */
  readonly unchanged: readonly OnboardingItemId[];
  /**
   * Deployed but no longer selected. LEFT ALONE. Present so the screen can say
   * what unticking did NOT do, which is the sentence that stops someone
   * assuming a teardown happened.
   */
  readonly leftInPlace: readonly OnboardingItemId[];
}

/** An explicit, confirmed teardown request. Never produced by a selection change. */
export interface RemovalRequest {
  /** Exactly what to tear down. An empty list is a no-op, not "everything". */
  readonly items: readonly OnboardingItemId[];
  /**
   * Must be `true`. A separate flag rather than an implicit consequence of
   * calling {@link removalPlan}, so the confirmation is a value that has to be
   * threaded from a real user action and shows up in a test as a literal.
   */
  readonly confirmed: boolean;
}

/** The outcome of asking for a teardown. */
export interface RemovalPlan {
  /** Items that will be torn down. Empty whenever the request was refused. */
  readonly remove: readonly OnboardingItemId[];
  /**
   * Requested but not currently deployed, so not removable. Reported rather
   * than silently dropped - a request naming something that is not there means
   * the caller's picture disagrees with reality, and that is worth saying.
   */
  readonly notDeployed: readonly OnboardingItemId[];
  /** Set when nothing will be removed and why. `null` when the plan will run. */
  readonly refusedReason: string | null;
}

/** Distinct ids, first occurrence wins, input order preserved. */
function distinct(ids: readonly OnboardingItemId[]): OnboardingItemId[] {
  const seen = new Set<OnboardingItemId>();
  const out: OnboardingItemId[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Name the state of one item from the two independent facts.
 *
 * @param id       the item
 * @param desired  what is currently ticked
 * @param deployed what is currently in Azure
 */
export function itemState(
  id: OnboardingItemId,
  desired: readonly OnboardingItemId[],
  deployed: readonly OnboardingItemId[],
): ItemState {
  const isSelected = desired.includes(id);
  const isDeployed = deployed.includes(id);
  if (isSelected && isDeployed) return "deployed";
  if (isSelected) return "pending";
  if (isDeployed) return "deployed-unselected";
  return "unselected";
}

/**
 * Turn a selection into a deploy plan. ADDITIVE ONLY.
 *
 * Everything selected and not yet deployed is added. Everything deployed is
 * left exactly as it is, whether or not it is still selected - so unticking a
 * box moves it to `leftInPlace` and changes nothing in Azure.
 *
 * @param desired  what is currently ticked
 * @param deployed what is currently in Azure
 */
export function deployPlan(
  desired: readonly OnboardingItemId[],
  deployed: readonly OnboardingItemId[],
): DeployPlan {
  const deployedSet = new Set(deployed);
  const desiredSet = new Set(desired);
  const wanted = distinct(desired);

  return {
    add: wanted.filter((id) => !deployedSet.has(id)),
    unchanged: wanted.filter((id) => deployedSet.has(id)),
    leftInPlace: distinct(deployed).filter((id) => !desiredSet.has(id)),
  };
}

/**
 * Turn an EXPLICIT, CONFIRMED request into a teardown plan.
 *
 * This is the only function in the module that can remove anything, and it
 * cannot be reached from a selection: it takes the ids to tear down directly,
 * so a caller has to name them. An unconfirmed request removes nothing and says
 * why, rather than throwing - the screen needs to render the refusal.
 *
 * @param request  the ids to tear down, plus the confirmation
 * @param deployed what is currently in Azure
 */
export function removalPlan(
  request: RemovalRequest,
  deployed: readonly OnboardingItemId[],
): RemovalPlan {
  const asked = distinct(request.items);
  const deployedSet = new Set(deployed);
  const notDeployed = asked.filter((id) => !deployedSet.has(id));
  const removable = asked.filter((id) => deployedSet.has(id));

  if (!request.confirmed) {
    return {
      remove: [],
      notDeployed,
      refusedReason: "Removal was not confirmed. Teardown never happens implicitly.",
    };
  }
  if (asked.length === 0) {
    return {
      remove: [],
      notDeployed,
      // An empty list means "remove nothing". Reading it as "remove everything"
      // is the classic shape of this bug, so it is named rather than assumed.
      refusedReason: "No items were named for removal.",
    };
  }
  if (removable.length === 0) {
    return {
      remove: [],
      notDeployed,
      refusedReason: "None of the named items are deployed.",
    };
  }
  return { remove: removable, notDeployed, refusedReason: null };
}
