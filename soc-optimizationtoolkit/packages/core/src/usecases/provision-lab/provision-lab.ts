/**
 * provision-lab - roadmap Phase 5: the phased lab deployment engine (LAB-01
 * orchestration; ALL ten legacy phases implemented). This module is the
 * SEQUENCER and the public facade: it derives the step list, builds the
 * {@link LabPhaseContext} seam, runs the phase modules in the legacy
 * execution order, and finishes the job record. The phases themselves live
 * one module each (foundation/storage/networking/monitoring/analytics/
 * flowlogs/compute/dcr/cribl/gateway-phase.ts) over the ARM resource
 * toolkit (arm-resource.ts); the public types are in provision-lab-types.ts
 * and re-exported here unchanged.
 *
 * Legacy execution order (the same isLabPhaseRequired gating the legacy
 * orchestrator used): Foundation always; Storage BEFORE Networking;
 * Monitoring (+ Private Link in private mode); Analytics; Flow Logs;
 * Compute; Data Collection; Integration; Gateway.
 *
 * Failure semantics (the first-class 'skipped' convention):
 * - A resource-group failure skips EVERYTHING behind it.
 * - A TTL watchdog/grant failure skips all later phases: the TTL mandate
 *   means the app never creates billable lab resources without a working
 *   self-destruct. (Foundation is the ONE phase that can abort the run.)
 * - A storage-account failure skips the dependent storage sub-steps but the
 *   independent networking phase still runs (legacy phases were isolated).
 * - Sub-steps not requested by the profile report 'skipped' with the
 *   reason; phases the profile does not require contribute NO steps at all
 *   (see {@link provisionLabStepsFor}).
 *
 * SHELL OWNS TIME, IDS, AND RANDOMNESS: nowIso (TTL math),
 * mintAssignmentName (role-assignment GUID), and mintStorageSuffix
 * (collision retry) are injected; retries/polls are attempt-bounded and
 * paced only by the injected sleep hook.
 *
 * Pure orchestration over AzureManagement (and optional JobStore/Logger);
 * zero IO of its own. Never rejects for ARM failures - the outcome carries
 * them; it can still reject if the optional JobStore itself fails.
 */

import type { JobRecord, JobStep } from "../../ports/job-store";
import { labTtlInstants, ttlLogicAppName } from "../../domain/labs/lab-foundation";
import type { LabPhaseContext } from "./lab-phase-context";
import {
  DEFAULT_LAB_LONG_POLL_ATTEMPTS,
  DEFAULT_LAB_RETRY_ATTEMPTS,
  DEFAULT_LAB_RETRY_DELAY_MS,
  PROVISION_LAB_JOB_KIND,
  provisionLabStepsFor,
  type ProvisionLabInput,
  type ProvisionLabPorts,
  type ProvisionLabResult,
} from "./provision-lab-types";
import { PREREQUISITE_FAILED } from "./provision-lab-types";
import { runFoundationPhase } from "./foundation-phase";
import { runStoragePhase } from "./storage-phase";
import { runNetworkingPhase } from "./networking-phase";
import { runMonitoringPhase } from "./monitoring-phase";
import { runAnalyticsPhase } from "./analytics-phase";
import { runFlowLogsPhase } from "./flowlogs-phase";
import { runComputePhase } from "./compute-phase";
import { runDcrPhase } from "./dcr-phase";
import { runCriblPhase } from "./cribl-phase";
import { runGatewayPhase } from "./gateway-phase";

// The public interface of the engine, unchanged across the decomposition.
export * from "./provision-lab-types";

/**
 * Run the lab deployment: foundation always, then every phase the profile
 * requires in the legacy execution order. See the module doc for the
 * failure/skip semantics.
 */
export async function provisionLab(
  ports: ProvisionLabPorts,
  input: ProvisionLabInput,
): Promise<ProvisionLabResult> {
  const { azure, jobs, logger } = ports;
  const retry = input.retry ?? {};
  const maxAttempts = retry.maxAttempts ?? DEFAULT_LAB_RETRY_ATTEMPTS;
  const delayMs = retry.delayMs ?? DEFAULT_LAB_RETRY_DELAY_MS;
  const sleep = retry.sleep ?? (async () => {});
  const sub = input.subscriptionId;
  const rg = input.resourceGroupName;

  const stepNames = provisionLabStepsFor(input.flags);
  const steps: JobStep[] = stepNames.map((name) => ({ name, status: "pending" }));
  const hasStep = (name: string): boolean => stepNames.includes(name);

  let job: JobRecord | null = null;
  if (jobs !== undefined) {
    job = await jobs.create(PROVISION_LAB_JOB_KIND, {
      subscriptionId: sub,
      resourceGroupName: rg,
      location: input.location,
      baseObjectName: input.baseObjectName,
      rgMode: input.rgMode,
      ttl: input.ttl,
      flags: input.flags,
    });
    await jobs.update(job.id, {
      status: "running",
      steps: steps.map((s) => ({ ...s })),
    });
  }

  logger?.info(
    "provision-lab: started",
    { resourceGroup: rg, rgMode: input.rgMode, steps: stepNames.length },
    job?.id,
  );

  const setStep = async (
    name: string,
    status: JobStep["status"],
    detail?: string,
  ): Promise<void> => {
    const step = steps.find((candidate) => candidate.name === name);
    if (step === undefined) {
      throw new Error(`unknown step '${name}'`);
    }
    step.status = status;
    if (detail !== undefined) {
      step.detail = detail;
    }
    if (job !== null && jobs !== undefined) {
      await jobs.update(job.id, { steps: steps.map((s) => ({ ...s })) });
    }
    input.onProgress?.({ ...step });
  };

  const skipSteps = async (names: readonly string[], reason: string): Promise<void> => {
    for (const name of names) {
      if (hasStep(name)) {
        await setStep(name, "skipped", reason);
      }
    }
  };

  const instants = labTtlInstants(input.ttl, input.nowIso);
  const result: ProvisionLabResult = {
    resourceGroupId: `/subscriptions/${sub}/resourceGroups/${rg}`,
    resourceGroupCreated: false,
    ttlExpiresAt: instants.expirationTime,
    logicAppName: ttlLogicAppName(input.baseObjectName),
    logicAppCreated: false,
    principalId: "",
    roleAssigned: false,
    roleAlreadyAssigned: false,
    ok: false,
  };
  const errors: string[] = [];

  const finish = async (): Promise<ProvisionLabResult> => {
    result.ok = errors.length === 0;
    if (job !== null && jobs !== undefined) {
      await jobs.update(job.id, {
        status: result.ok ? "succeeded" : "failed",
        ...(result.ok ? {} : { error: errors[0] }),
        result,
      });
    }
    if (result.ok) {
      logger?.info("provision-lab: succeeded", { resourceGroup: rg }, job?.id);
    } else {
      logger?.error(
        "provision-lab: finished with failures",
        { failures: errors.length, first: errors[0] },
        job?.id,
      );
    }
    return result;
  };

  const ctx: LabPhaseContext = {
    azure,
    input,
    result,
    errors,
    sub,
    rg,
    maxAttempts,
    delayMs,
    longPollAttempts: input.longPollAttempts ?? DEFAULT_LAB_LONG_POLL_ATTEMPTS,
    sleep,
    setStep,
    skipSteps,
    hasStep,
    remainingAfter: (name) => stepNames.slice(stepNames.indexOf(name)),
    stepNames,
    logger,
    jobId: job?.id,
    // True when the profile has no monitoring phase at all; the DCR phase
    // gates on it (DCRs target the lab workspace).
    workspaceReady: !hasStep("log-analytics"),
  };

  // Phase 1 is the ONE phase that can abort the whole run (TTL mandate).
  if (!(await runFoundationPhase(ctx))) {
    return finish();
  }
  if (hasStep("storage-account")) {
    await runStoragePhase(ctx);
  }
  if (hasStep("virtual-network")) {
    await runNetworkingPhase(ctx);
  }
  if (hasStep("log-analytics")) {
    await runMonitoringPhase(ctx);
  }
  if (hasStep("event-hub")) {
    await runAnalyticsPhase(ctx);
  }
  if (hasStep("flow-logs")) {
    await runFlowLogsPhase(ctx);
  }
  if (hasStep("virtual-machines")) {
    await runComputePhase(ctx);
  }
  if (hasStep("data-collection-rules")) {
    if (!ctx.workspaceReady) {
      await skipSteps(["data-collection-rules"], PREREQUISITE_FAILED);
    } else {
      await runDcrPhase(ctx);
    }
  }
  if (hasStep("cribl-configs")) {
    await runCriblPhase(ctx);
  }
  if (hasStep("vpn-gateway")) {
    await runGatewayPhase(ctx);
  }

  return finish();
}
