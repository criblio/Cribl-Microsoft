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
 * Pure: no IO, no React.
 */

import { verdictFor } from "@soc/core";
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
 * The honest line for an empty inventory.
 *
 * `noun` is plural and lowercase ("workspaces", "tables", "data collection
 * rules") - it is interpolated into all four wordings.
 *
 * Four answers, never collapsed. `unknown` is its own case and must not read as
 * either "none" or "denied": the audit runs on connection change, so an
 * unaudited-but-healthy connection is common and deserves a hedge rather than an
 * accusation.
 */
export function emptyInventoryMessage(
  noun: string,
  capability: Capability,
  capabilities: CapabilitySet,
  context: CapabilityContext,
): EmptyInventoryMessage {
  switch (verdictFor(capability, capabilities, context)) {
    case "granted":
      // The ONLY case that may claim a zero - permission was measured.
      return { text: `No ${noun} found`, verified: true };
    case "denied":
      return {
        text: `Cannot list ${noun} - the connected identity does not have permission to read them`,
        verified: false,
      };
    case "unreachable":
      return {
        text: `Cannot list ${noun} - no Azure connection`,
        verified: false,
      };
    case "unknown":
      return {
        text: `Cannot confirm there are no ${noun} - run the permission check to find out`,
        verified: false,
      };
  }
}
