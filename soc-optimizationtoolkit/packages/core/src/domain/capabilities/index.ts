/**
 * Capability model (docs/capability-model-plan.md) - what the connected
 * identity can actually do, replacing app modes as the thing the product gates
 * on. Not yet wired into the frame; see the plan's sequencing.
 */
export type {
  AzureCapability,
  Capability,
  CapabilityContext,
  CapabilitySet,
  CapabilityVerdict,
  CriblCapability,
} from "./capabilities";
export {
  AZURE_CAPABILITIES,
  CRIBL_CAPABILITIES,
  can,
  emptyCapabilitySet,
  isAttemptable,
  isAzureCapability,
  isSetForConnection,
  unavailableReason,
  verdictFor,
} from "./capabilities";
