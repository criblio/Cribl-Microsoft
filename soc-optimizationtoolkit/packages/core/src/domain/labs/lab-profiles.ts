/**
 * Lab profiles and phase model - roadmap Phase 5 (LAB-01 presets + phase
 * gating).
 *
 * Ported from the legacy UnifiedLab:
 * - The 8 lab presets and their component flags, VERBATIM from
 *   Menu-Framework.ps1 Get-LabDeploymentConfig (219-310), including the
 *   private-mode conditionals and each preset's ResourceGroupSuffix.
 * - The 10-phase model and its gating, VERBATIM from Run-AzureUnifiedLab.ps1
 *   Test-PhaseRequired (384-443) - note the legacy execution-order quirk that
 *   Storage is phase 2 and Networking phase 3 (the Flow Logs dependency).
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

/** The 8 legacy lab preset identifiers, verbatim. */
export const LAB_TYPES = [
  "CompleteLab",
  "SentinelLab",
  "ADXLab",
  "FlowLogLab",
  "EventHubLab",
  "BlobQueueLab",
  "BlobCollectorLab",
  "BasicInfrastructure",
] as const;

/** One of the 8 legacy lab presets. */
export type LabType = (typeof LAB_TYPES)[number];

/** Public (internet-reachable endpoints) vs private (Private Link) lab. */
export type LabMode = "public" | "private";

/** Infrastructure component flags (legacy Infrastructure hashtable). */
export interface LabInfrastructureFlags {
  deployVNet: boolean;
  deployNSGs: boolean;
  deployVPN: boolean;
}

/** Storage component flags (legacy Storage hashtable). */
export interface LabStorageFlags {
  deploy: boolean;
  deployContainers: boolean;
  deployQueues: boolean;
  deployEventGrid: boolean;
  deployPrivateEndpoints: boolean;
  /** BlobCollectorLab only; the legacy flag was never wired to a generator. */
  generateSampleData?: boolean;
}

/** Monitoring component flags (legacy Monitoring hashtable). */
export interface LabMonitoringFlags {
  deployLogAnalytics: boolean;
  deploySentinel: boolean;
  deployFlowLogs: boolean;
  deployPrivateLink: boolean;
  deployDCRs: boolean;
}

/** Analytics component flags (legacy Analytics hashtable). */
export interface LabAnalyticsFlags {
  deployEventHub: boolean;
  deployADX: boolean;
  deployPrivateEndpoints: boolean;
}

/** The full component-flag set one preset resolves to. */
export interface LabComponentFlags {
  /** Appended to the resource-group prefix (legacy ResourceGroupSuffix). */
  resourceGroupSuffix: string;
  infrastructure: LabInfrastructureFlags;
  storage: LabStorageFlags;
  monitoring: LabMonitoringFlags;
  analytics: LabAnalyticsFlags;
  virtualMachines: { deployVMs: boolean };
}

/**
 * Resolve a preset + mode to its component flags (legacy
 * Get-LabDeploymentConfig, verbatim - including which flags follow
 * private mode).
 */
export function labDeploymentConfig(
  labType: LabType,
  labMode: LabMode,
): LabComponentFlags {
  const isPrivate = labMode === "private";
  switch (labType) {
    case "CompleteLab":
      return {
        resourceGroupSuffix: "CompleteLab",
        infrastructure: { deployVNet: true, deployNSGs: true, deployVPN: true },
        storage: {
          deploy: true,
          deployContainers: true,
          deployQueues: true,
          deployEventGrid: true,
          deployPrivateEndpoints: isPrivate,
        },
        monitoring: {
          deployLogAnalytics: true,
          deploySentinel: true,
          deployFlowLogs: true,
          deployPrivateLink: isPrivate,
          deployDCRs: true,
        },
        analytics: {
          deployEventHub: true,
          deployADX: true,
          deployPrivateEndpoints: isPrivate,
        },
        virtualMachines: { deployVMs: true },
      };
    case "SentinelLab":
      return {
        resourceGroupSuffix: "SentinelLab",
        infrastructure: {
          deployVNet: isPrivate,
          deployNSGs: isPrivate,
          deployVPN: isPrivate,
        },
        storage: {
          deploy: false,
          deployContainers: false,
          deployQueues: false,
          deployEventGrid: false,
          deployPrivateEndpoints: false,
        },
        monitoring: {
          deployLogAnalytics: true,
          deploySentinel: true,
          deployFlowLogs: false,
          deployPrivateLink: isPrivate,
          deployDCRs: true,
        },
        analytics: {
          deployEventHub: false,
          deployADX: false,
          deployPrivateEndpoints: false,
        },
        virtualMachines: { deployVMs: false },
      };
    case "ADXLab":
      return {
        resourceGroupSuffix: "ADXLab",
        infrastructure: {
          deployVNet: isPrivate,
          deployNSGs: isPrivate,
          deployVPN: isPrivate,
        },
        storage: {
          deploy: isPrivate,
          deployContainers: isPrivate,
          deployQueues: false,
          deployEventGrid: false,
          deployPrivateEndpoints: isPrivate,
        },
        monitoring: {
          deployLogAnalytics: false,
          deploySentinel: false,
          deployFlowLogs: false,
          deployPrivateLink: false,
          deployDCRs: false,
        },
        analytics: {
          deployEventHub: false,
          deployADX: true,
          deployPrivateEndpoints: isPrivate,
        },
        virtualMachines: { deployVMs: false },
      };
    case "FlowLogLab":
      return {
        resourceGroupSuffix: "FlowLogLab",
        infrastructure: { deployVNet: true, deployNSGs: true, deployVPN: false },
        storage: {
          deploy: true,
          deployContainers: false,
          deployQueues: false,
          deployEventGrid: false,
          deployPrivateEndpoints: isPrivate,
        },
        monitoring: {
          deployLogAnalytics: false,
          deploySentinel: false,
          deployFlowLogs: true,
          deployPrivateLink: false,
          deployDCRs: false,
        },
        analytics: {
          deployEventHub: false,
          deployADX: false,
          deployPrivateEndpoints: false,
        },
        virtualMachines: { deployVMs: true },
      };
    case "EventHubLab":
      return {
        resourceGroupSuffix: "EventHubLab",
        infrastructure: {
          deployVNet: isPrivate,
          deployNSGs: isPrivate,
          deployVPN: isPrivate,
        },
        storage: {
          deploy: false,
          deployContainers: false,
          deployQueues: false,
          deployEventGrid: false,
          deployPrivateEndpoints: false,
        },
        monitoring: {
          deployLogAnalytics: false,
          deploySentinel: false,
          deployFlowLogs: false,
          deployPrivateLink: false,
          deployDCRs: false,
        },
        analytics: {
          deployEventHub: true,
          deployADX: false,
          deployPrivateEndpoints: isPrivate,
        },
        virtualMachines: { deployVMs: false },
      };
    case "BlobQueueLab":
      return {
        resourceGroupSuffix: "BlobQueueLab",
        infrastructure: {
          deployVNet: isPrivate,
          deployNSGs: isPrivate,
          deployVPN: isPrivate,
        },
        storage: {
          deploy: true,
          deployContainers: true,
          deployQueues: true,
          deployEventGrid: true,
          deployPrivateEndpoints: isPrivate,
        },
        monitoring: {
          deployLogAnalytics: false,
          deploySentinel: false,
          deployFlowLogs: false,
          deployPrivateLink: false,
          deployDCRs: false,
        },
        analytics: {
          deployEventHub: false,
          deployADX: false,
          deployPrivateEndpoints: false,
        },
        virtualMachines: { deployVMs: false },
      };
    case "BlobCollectorLab":
      return {
        resourceGroupSuffix: "BlobCollectorLab",
        infrastructure: {
          deployVNet: isPrivate,
          deployNSGs: isPrivate,
          deployVPN: isPrivate,
        },
        storage: {
          deploy: true,
          deployContainers: true,
          deployQueues: false,
          deployEventGrid: false,
          deployPrivateEndpoints: isPrivate,
          generateSampleData: true,
        },
        monitoring: {
          deployLogAnalytics: false,
          deploySentinel: false,
          deployFlowLogs: false,
          deployPrivateLink: false,
          deployDCRs: false,
        },
        analytics: {
          deployEventHub: false,
          deployADX: false,
          deployPrivateEndpoints: false,
        },
        virtualMachines: { deployVMs: false },
      };
    case "BasicInfrastructure":
      return {
        resourceGroupSuffix: "BasicInfrastructure",
        infrastructure: { deployVNet: true, deployNSGs: true, deployVPN: true },
        storage: {
          deploy: false,
          deployContainers: false,
          deployQueues: false,
          deployEventGrid: false,
          deployPrivateEndpoints: false,
        },
        monitoring: {
          deployLogAnalytics: false,
          deploySentinel: false,
          deployFlowLogs: false,
          deployPrivateLink: false,
          deployDCRs: false,
        },
        analytics: {
          deployEventHub: false,
          deployADX: false,
          deployPrivateEndpoints: false,
        },
        virtualMachines: { deployVMs: false },
      };
  }
}

/** Display metadata for one lab preset (menu copy condensed). */
export interface LabProfileMeta {
  id: LabType;
  label: string;
  description: string;
}

/** The preset list in legacy menu order (options 1-8). */
export const LAB_PROFILES: readonly LabProfileMeta[] = [
  {
    id: "CompleteLab",
    label: "Complete Lab",
    description:
      "Everything: VNet, NSGs, VPN gateway, storage with containers/queues/Event Grid, Log Analytics with Sentinel, flow logs, DCRs, Event Hub, ADX, and test VMs.",
  },
  {
    id: "SentinelLab",
    label: "Sentinel Lab",
    description:
      "Log Analytics workspace with Microsoft Sentinel and DCRs. Networking and Private Link deploy only in private mode.",
  },
  {
    id: "ADXLab",
    label: "ADX Lab",
    description:
      "Azure Data Explorer cluster for Cribl ADX destination testing. Storage and networking deploy only in private mode.",
  },
  {
    id: "FlowLogLab",
    label: "vNet Flow Log Lab",
    description:
      "VNet with NSGs, storage, vNet flow logs, and traffic-generating test VMs - the source side of Cribl flow-log collection.",
  },
  {
    id: "EventHubLab",
    label: "Event Hub Lab",
    description:
      "Event Hub namespace with logs/metrics/events hubs and consumer groups for Cribl Event Hub source testing.",
  },
  {
    id: "BlobQueueLab",
    label: "Blob Queue Lab",
    description:
      "Storage with containers, queues, and Event Grid blob notifications - the queue-based discovery pattern for the Cribl azure_blob source.",
  },
  {
    id: "BlobCollectorLab",
    label: "Blob Collector Lab",
    description:
      "Storage with the criblblobcollector container for the scheduled-polling Cribl blob collector pattern.",
  },
  {
    id: "BasicInfrastructure",
    label: "Basic Infrastructure",
    description: "VNet, NSGs, and VPN gateway only - a networking foundation.",
  },
] as const;

// ---------------------------------------------------------------------------
// Phase model (Start-PhaseDeployment order + Test-PhaseRequired gating)
// ---------------------------------------------------------------------------

/** One deployment phase (legacy execution order; Storage BEFORE Networking). */
export interface LabPhase {
  /** The legacy phase number (also the -Phase flag value). */
  number: number;
  title: string;
  /** The sub-steps the legacy orchestrator runs inside the phase. */
  steps: readonly string[];
}

/** The 10 phases in legacy execution order, verbatim titles and steps. */
export const LAB_PHASES: readonly LabPhase[] = [
  { number: 1, title: "Foundation", steps: ["Resource group", "TTL self-destruct"] },
  {
    number: 2,
    title: "Storage",
    steps: ["Storage account", "Blob containers", "Storage queues", "Event Grid"],
  },
  { number: 3, title: "Networking", steps: ["Virtual network", "Network security groups"] },
  {
    number: 4,
    title: "Monitoring",
    steps: ["Log Analytics", "Microsoft Sentinel", "Private Link"],
  },
  { number: 5, title: "Analytics", steps: ["Event Hub", "Azure Data Explorer"] },
  { number: 6, title: "Network Monitoring", steps: ["vNet flow logs"] },
  { number: 7, title: "Compute", steps: ["Test virtual machines"] },
  { number: 8, title: "Data Collection", steps: ["Data collection rules"] },
  { number: 9, title: "Integration", steps: ["Cribl configurations"] },
  { number: 10, title: "Gateway", steps: ["VPN gateway", "VPN connection"] },
] as const;

/**
 * Whether a phase runs for the given component flags (legacy
 * Test-PhaseRequired, verbatim): phase 1 always runs; a `specificPhase`
 * greater than zero runs exactly that phase; null flags run everything (the
 * legacy non-interactive fallback).
 */
export function isLabPhaseRequired(
  phase: number,
  flags: LabComponentFlags | null,
  specificPhase = 0,
): boolean {
  if (specificPhase > 0) {
    return phase === specificPhase;
  }
  if (flags === null) {
    return true;
  }
  if (phase === 1) {
    return true;
  }
  switch (phase) {
    case 2:
      return flags.storage.deploy;
    case 3:
      return flags.infrastructure.deployVNet;
    case 4:
      return (
        flags.monitoring.deployLogAnalytics ||
        flags.monitoring.deploySentinel ||
        flags.monitoring.deployPrivateLink
      );
    case 5:
      return flags.analytics.deployEventHub || flags.analytics.deployADX;
    case 6:
      return flags.monitoring.deployFlowLogs;
    case 7:
      return flags.virtualMachines.deployVMs;
    case 8:
      return flags.monitoring.deployDCRs;
    case 9:
      return (
        flags.storage.deploy ||
        flags.monitoring.deployLogAnalytics ||
        flags.monitoring.deploySentinel ||
        flags.analytics.deployEventHub ||
        flags.analytics.deployADX
      );
    case 10:
      return flags.infrastructure.deployVPN;
    default:
      return true;
  }
}

/** The phases a flag set requires, in legacy execution order. */
export function requiredLabPhases(flags: LabComponentFlags): LabPhase[] {
  return LAB_PHASES.filter((phase) => isLabPhaseRequired(phase.number, flags));
}
