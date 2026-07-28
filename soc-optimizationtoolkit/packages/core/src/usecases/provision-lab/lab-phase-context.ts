/**
 * LabPhaseContext - the ONE seam every lab phase module runs behind. The
 * sequencer (provision-lab.ts) builds it once per run: the ports, the
 * resolved retry/poll knobs, the shared mutable result/errors, and the
 * step-bookkeeping functions (setStep persists to the JobStore and fires
 * onProgress; skipSteps applies a reason across the remaining names).
 *
 * Phases NEVER finish the job - they record outcomes and push errors; only
 * the sequencer decides when the run is over. The one exception is the
 * foundation phase, whose contract (a boolean return) lets it abort the
 * whole run - the TTL mandate.
 */

import type { AzureManagement } from "../../ports/azure-management";
import type { JobStep } from "../../ports/job-store";
import type { Logger } from "../../ports/logger";
import type { ProvisionLabInput, ProvisionLabResult } from "./provision-lab-types";

/** Everything a phase module needs, built once by the sequencer. */
export interface LabPhaseContext {
  azure: AzureManagement;
  input: ProvisionLabInput;
  /** The shared result phases write their outcome slices into. */
  result: ProvisionLabResult;
  /** The shared failure list; result.ok is derived from it at finish. */
  errors: string[];
  /** input.subscriptionId (every ARM path needs it). */
  sub: string;
  /** input.resourceGroupName (every ARM path needs it). */
  rg: string;
  /** Resolved retry bound (attempts, never wall-clock). */
  maxAttempts: number;
  /** Resolved delay handed to the injected sleep hook. */
  delayMs: number;
  /** Resolved LONG poll bound (ADX / VPN gateway / VMs). */
  longPollAttempts: number;
  /** The SHELL-injected sleep hook (no-op default in the sequencer). */
  sleep: (ms: number) => Promise<void>;
  /** Update one step (persists to the JobStore, fires onProgress). */
  setStep: (
    name: string,
    status: JobStep["status"],
    detail?: string,
  ) => Promise<void>;
  /** Mark the given steps skipped (only those present on this run). */
  skipSteps: (names: readonly string[], reason: string) => Promise<void>;
  /** True when the step is part of this run's derived step list. */
  hasStep: (name: string) => boolean;
  /** The step names from `name` (inclusive) to the end of the run. */
  remainingAfter: (name: string) => string[];
  /** This run's full derived step list, in execution order. */
  stepNames: string[];
  logger?: Logger;
  /** The JobStore record id when a job is being tracked. */
  jobId?: string;
  /**
   * True when the lab workspace exists after the monitoring phase (or when
   * the profile has no monitoring phase at all). The DCR phase gates on it.
   */
  workspaceReady: boolean;
}
