/**
 * Empty-inventory messaging - docs/inventory-standard.md, BINDING.
 *
 * > An empty result may only be reported as "there are none" when the caller has
 * > VERIFIED it had permission to see them.
 *
 * Shared by every lister rather than written per screen, because the failure it
 * prevents is a CONFIDENT WRONG ANSWER and those are exactly what drifts when
 * eight screens each phrase it themselves.
 *
 * WHY A CAPABILITY CHECK RATHER THAN ERROR HANDLING. Azure ARM list operations
 * return 200 OK with an empty `value` array when RBAC filters the caller out -
 * RBAC scopes what a list RETURNS rather than denying the call. A caller with no
 * access and a caller looking at a genuinely empty subscription get identical
 * responses, so there is nothing to catch and the distinction cannot come from
 * the response. It comes from the audit.
 *
 * A VERDICT IS EVIDENCE ONLY ABOUT THE SCOPE IT WAS MEASURED AT, which is why
 * {@link EmptyInventoryInput.scope} is required. `runAzurePreflight` builds ONE
 * ARM scope from the COMMITTED target and evaluates everything there, so
 * `workspace.read: granted` means "this identity can read workspaces in the
 * committed subscription" - it says nothing about a subscription the operator
 * is merely browsing. Reusing it there would reproduce the original bug one
 * scope over, which is the same confident wrong answer wearing a permission
 * check as cover.
 *
 * Pure: no IO, no React.
 */

import { isAzureCapability, verdictFor } from "@soc/core";
import type { Capability, CapabilityContext, CapabilitySet } from "@soc/core";

/** What an empty list means, and whether it is safe to call it a zero. */
export interface EmptyInventoryMessage {
  /** The line to render in place of "none found". */
  text: string;
  /**
   * Whether this is a REAL zero (the permission was verified). False whenever
   * the emptiness is unexplained - callers may use it to decide whether to
   * offer "create one", which is actively harmful when we simply cannot see.
   */
  verified: boolean;
}

/**
 * Whether the audit measured THE SCOPE THIS LIST COVERS.
 *
 * Every lister must state this, because a screen that browses is the normal
 * case here, not the exception: Azure targeting exists to look at subscriptions
 * other than the committed one, and the DCR inventory says so in its own hint.
 */
export interface AuditedScope {
  /** True when the listed scope IS the scope the audit measured. */
  matchesAudit: boolean;
  /**
   * What kind of scope, for the wording: "subscription", "resource group",
   * "workspace". Only read when {@link matchesAudit} is false.
   */
  label: string;
}

/** For a lister that only ever lists the committed target - the common case. */
export const AUDITED_SCOPE: AuditedScope = Object.freeze({
  matchesAudit: true,
  label: "",
});

/** What {@link emptyInventoryMessage} needs to answer honestly. */
export interface EmptyInventoryInput {
  /**
   * Plural and lowercase ("workspaces", "tables", "data collection rules") - it
   * is interpolated into every wording.
   */
  noun: string;
  /** The capability that would establish the read. */
  capability: Capability;
  /** The measured capabilities for the active connection. */
  capabilities: CapabilitySet;
  /** Connection facts, for resolving anything unmeasured. */
  context: CapabilityContext;
  /** Whether the audit covers the scope being listed. {@link AUDITED_SCOPE} when it always does. */
  scope: AuditedScope;
}

/**
 * The honest line for an empty inventory.
 *
 * Five answers, never collapsed. Only a MEASURED grant AT THE LISTED SCOPE may
 * claim a zero.
 *
 * `unknown` is its own case and must not read as either "none" or "denied": the
 * audit runs on connection change, so an unaudited-but-healthy connection is
 * common and deserves a hedge rather than an accusation. An off-scope list gets
 * the same hedge for a different reason, and the text says which - "we have not
 * measured here" is not "we have not measured at all", and an operator who has
 * just run a permission check would be right to distrust a message claiming
 * otherwise.
 */
export function emptyInventoryMessage(input: EmptyInventoryInput): EmptyInventoryMessage {
  const { noun, capability, capabilities, context, scope } = input;
  const verdict = verdictFor(capability, capabilities, context);

  // Checked before the scope rule: with no connection at all there is nowhere
  // to send the request, which is true of every scope at once and is a more
  // useful thing to say than "we measured somewhere else".
  //
  // NOT REACHABLE FROM ANY SHIPPING CALLER as of 2026-08-31 (DBT-57), and KEPT
  // DELIBERATELY - see the note below. All three call sites exclude it, for two
  // different reasons, neither of which is a simple missing wire:
  //
  //   1. Azure targeting (azure-targeting-screen.tsx) - `unreachable` and the
  //      screen's `offline` branch are THE SAME BOOLEAN. App.tsx passes
  //      `offline={!capabilityAudit.context.azureIdentityPresent}` alongside the
  //      context itself, and the screen early-returns its offline panel long
  //      before the JSX that renders this text. Exactly when the verdict would
  //      be `unreachable`, the message is not on screen to say so.
  //   2. DCR inventory and the workspace-table listing - the message is only
  //      COMPUTED once a list call has SUCCEEDED (`entries !== null`,
  //      `loaded === true`); a failed or unauthenticated call renders the error
  //      instead. A 200 from ARM is itself proof the connection was reachable,
  //      so arriving here already refutes the verdict. (Both also default a
  //      missing context to `azureIdentityPresent: true`, which would suppress
  //      it independently.)
  //
  // Reason 2 is the interesting one: it says this branch answers a question
  // that is settled EARLIER than the one this function exists for. The function
  // asks "the list came back empty - may I call that a zero?"; `unreachable`
  // answers "could I even ask?", which is decided before there is an empty list
  // to describe. So the branch is misplaced rather than merely unwired, and the
  // honest fix is a product decision rather than a plumbing one - it fires only
  // for a lister that DECLINES to call and returns empty (or a screen that
  // renders the inventory area while disconnected instead of an offline panel).
  // Deleting it instead would quietly retire a degrade docs/inventory-standard.md
  // credits as binding, so it stays until someone decides which.
  if (verdict === "unreachable") {
    return {
      text: `Cannot list ${noun} - no ${isAzureCapability(capability) ? "Azure" : "Cribl"} connection`,
      verified: false,
    };
  }

  // Measured elsewhere is not measured here. Applies to a DENIAL too: being
  // refused in the committed subscription is no evidence about this one.
  if (!scope.matchesAudit) {
    return {
      text:
        `Cannot confirm there are no ${noun} in this ${scope.label} - ` +
        `the permission check measured a different ${scope.label}`,
      verified: false,
    };
  }

  switch (verdict) {
    case "granted":
      // The ONLY case that may claim a zero - permission was measured, here.
      return { text: `No ${noun} found`, verified: true };
    case "denied":
      return {
        text: `Cannot list ${noun} - the connected identity does not have permission to read them`,
        verified: false,
      };
    case "unknown":
      // No `unreachable` case: it returned above, and the compiler has narrowed
      // it out of this switch - which is the check that the early return and
      // this switch between them still cover all four verdicts.
      return {
        text: `Cannot confirm there are no ${noun} - run the permission check to find out`,
        verified: false,
      };
  }
}

/**
 * The honest line for an empty inventory in a scope NOTHING has measured yet.
 *
 * DELIBERATELY DIFFERENT WORDING from {@link emptyInventoryMessage}'s off-scope
 * branch, and the difference is the point. That branch knows an audit exists
 * and says "the permission check measured a different subscription" - true when
 * the operator has committed a target and is browsing elsewhere. The setup
 * wizard is the other case: it runs BEFORE any audit, and its whole job is
 * browsing subscriptions to choose one. Telling that operator we measured a
 * different subscription would describe a check they have not run.
 *
 * So this is not a synonym to be folded into the other one. They state two
 * different facts, and the module's contract is that the text says WHICH -
 * collapsing them would put an operator in one situation while reading the
 * other.
 *
 * No capability set is taken, because there is nothing to consult: the caller
 * knows structurally that the scope is unmeasured. Passing an empty set to
 * reach a particular branch would be plumbing that works by accident of
 * ordering rather than by saying what is true.
 */
export function unauditedScopeInventoryMessage(
  noun: string,
  scopeLabel: string,
): EmptyInventoryMessage {
  return {
    text:
      `Cannot confirm there are no ${noun} in this ${scopeLabel} - ` +
      "no permission check has measured it",
    verified: false,
  };
}

/**
 * The honest line for an empty inventory NO CAPABILITY COVERS.
 *
 * The settled taxonomy has no capability for listing subscriptions, resource
 * groups, Resource Graph results, or Cribl worker groups, and the standing rule
 * is not to quietly reuse a neighbouring one - mapping a subscription list onto
 * `workspace.read` would misreport what was actually checked.
 *
 * So the answer is the hedge, worded WITHOUT pointing at the permission check:
 * telling an operator to run a check that does not measure this list sends them
 * to do work that cannot settle the question, and they will read the result as
 * confirmation. Two honest ways out of this state, both bigger decisions than a
 * message: add the capability and a probe for it, or leave these lists
 * unmeasured and say so. This is the second, said out loud.
 */
export function unmeasuredInventoryMessage(noun: string): EmptyInventoryMessage {
  return {
    text: `Cannot confirm there are no ${noun} - no permission check covers this list`,
    verified: false,
  };
}
