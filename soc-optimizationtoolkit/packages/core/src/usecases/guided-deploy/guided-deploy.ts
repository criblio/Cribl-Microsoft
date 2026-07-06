/**
 * guidedDeploy - the multi-SOURCE guided deploy orchestrator (porting-plan Unit
 * 20, the culmination of the deploy chain; ENG-10, ENG-35 deltas, ENG-39 full
 * multi-source orchestrator, GUI-13/14/15/16).
 *
 * This GENERALIZES onboardTable/onboard-batch to a multi-source OUTER LOOP. It
 * does NOT re-implement the per-table deploy - it COMPOSES it: the Azure DCR +
 * Cribl destination work per source is delegated to an injected `deploySource`
 * collaborator (the production binding closes over onboardBatch), and the pack
 * assembly to `buildSourcePack` (closes over pack-assembly). The orchestrator
 * owns exactly the concerns the outer loop adds:
 *
 *   - FAILURE ISOLATION: one source failing never stops the others; the parent
 *     job finishes 'failed' with a count summary when any source failed, else
 *     'succeeded'.
 *   - IDEMPOTENT SKIP RULES (skip-rules.ts, tested there): azure-dcrs skip when
 *     every destination already exists; per-mode Azure/Cribl skips.
 *   - SINGLE-FLIGHT: a second guidedDeploy for the SAME deploy key while one is
 *     still 'running' is rejected (GuidedDeployBusyError) rather than racing.
 *   - RESUMABILITY that SURVIVES RELOAD: per-source progress is persisted to the
 *     JobStore after EVERY step, and a re-run of the same deploy key SKIPS the
 *     sources a prior run already completed (zero collaborator calls for them).
 *   - MODE GATING (workflow-state.ts): air-gapped/azure-only/cribl-only skip the
 *     relevant halves; partial/air-gapped modes ALSO export the artifact set as
 *     one archive via ArtifactSink (air-gap-export.ts).
 *
 * The flow STOPS at deploy-complete. The KQL validate/monitor stage is Unit
 * 10/21 (deferred): a `validate` step is deliberately NOT emitted here - the
 * seam is documented, not stubbed, so the flow never blocks on Unit 10.
 *
 * Pure orchestration over the ports and injected collaborators; no IO of its own
 * beyond the JobStore/ArtifactSink ports, no Date/crypto (the archive mtime is
 * an injected deterministic value).
 */

import type { ArtifactSink } from "../../ports/artifact-sink";
import type { JobRecord, JobStatus, JobStep, JobStore } from "../../ports/job-store";
import type { Logger } from "../../ports/logger";
import type { SentinelDestinationConfig } from "../../domain/sentinel-destination";
import type { CollectedArmRequest } from "../onboard-batch";
import { buildAirGapArchive } from "./air-gap-export";
import {
  canWireSource,
  deployModeGating,
  type DeployMode,
  type ModeGating,
} from "./workflow-state";
import { decideDcrsStep } from "./skip-rules";
import { memoizeVendorResearch } from "./vendor-research-memo";

/** JobStore `kind` for records created by {@link guidedDeploy}. */
export const GUIDED_DEPLOY_JOB_KIND = "guided-deploy";

/** MIME type for the single air-gap archive delivered via ArtifactSink. */
export const AIR_GAP_ARCHIVE_MIME = "application/gzip";

/** Prefix of per-source step names on the parent record. */
export const GUIDED_DEPLOY_STEP_PREFIX = "source:";

/** One source (vendor/solution) to deploy. */
export interface GuidedDeploySource {
  /** Stable source id (the Cribl input id and the resume key per source). */
  id: string;
  /** Vendor/solution name (research key, FDR-breaker gate, pack naming). */
  vendor: string;
  /** The pack name built and installed for this source. */
  packName: string;
  /** Destination Sentinel tables this source feeds. */
  tables: string[];
}

/** The Azure scope every source deploys into. */
export interface GuidedDeployScope {
  subscriptionId: string;
  resourceGroup: string;
  workspaceName: string;
  location?: string;
}

/** Context handed to each injected collaborator. */
export interface GuidedDeployContext {
  scope: GuidedDeployScope;
  workerGroups: string[];
  mode: DeployMode;
  gating: ModeGating;
  /** The parent job id (child linkage / logging). */
  jobId: string;
}

/** What {@link GuidedDeployCollaborators.deploySource} returns for one source. */
export interface DeploySourceResult {
  /** Destination configs created (connected) or with placeholders (air-gap). */
  destinations: SentinelDestinationConfig[];
  /** Collected ARM request bodies (air-gap / templateOnly), else empty. */
  armRequests: CollectedArmRequest[];
  /** Human-readable summary for the step line. */
  detail?: string;
}

/** What {@link GuidedDeployCollaborators.buildSourcePack} returns. */
export interface BuildSourcePackResult {
  /** The assembled .crbl bytes. */
  crbl: Uint8Array;
  /** The pack version that was built (from bumpPackVersion). */
  version: string;
}

/** What {@link GuidedDeployCollaborators.publishPack} returns. */
export interface PublishPackResult {
  /** Worker groups the pack was uploaded to. */
  uploadedGroups: string[];
  /** Human-readable summary for the step line. */
  detail?: string;
}

/**
 * The heavy collaborators the orchestrator composes. Production bindings close
 * over onboardBatch / pack-assembly / the Cribl publish helpers; tests inject
 * stubs so the OUTER-LOOP behavior is exercised in isolation.
 */
export interface GuidedDeployCollaborators {
  /**
   * Vendor research (Unit 15 engine deferred for the MVP). Optional; when
   * present it is MEMOIZED per normalized vendor key so it runs at most once per
   * distinct vendor across the whole deploy (the legacy called it thrice).
   */
  research?: (vendor: string) => Promise<unknown>;
  /**
   * The table names that already have a deployed destination in this scope
   * (optional live probe). Feeds the azure-dcrs idempotent skip rule: when EVERY
   * table already has a destination, the azure step is marked 'skipped'. Absent
   * probe = treat as none existing (the per-table skip inside deploySource, via
   * onboardBatch's skipExistingDCRs, is then the authoritative one).
   */
  listExistingDestinations?: (ctx: GuidedDeployContext) => Promise<string[]>;
  /**
   * Deploy a source's Azure resources and create its Cribl destinations
   * (connected), or COLLECT its ARM bodies + placeholder destinations
   * (air-gap). Composes onboardBatch + the shared sentinel-destination builder.
   */
  deploySource: (
    source: GuidedDeploySource,
    ctx: GuidedDeployContext,
  ) => Promise<DeploySourceResult>;
  /** Build the source's pack in memory (scaffold + buildCrbl). */
  buildSourcePack: (
    source: GuidedDeploySource,
    ctx: GuidedDeployContext,
  ) => Promise<BuildSourcePackResult>;
  /**
   * Publish the built pack to Cribl (ensure-secret, FDR breaker, two-step
   * upload). Called only when Cribl is not skipped and worker groups exist.
   */
  publishPack?: (
    source: GuidedDeploySource,
    ctx: GuidedDeployContext,
    built: BuildSourcePackResult,
  ) => Promise<PublishPackResult>;
}

/** The ports {@link guidedDeploy} uses directly (collaborators own the rest). */
export interface GuidedDeployPorts {
  jobs: JobStore;
  /** REQUIRED for the air-gap archive delivery in partial/air-gapped modes. */
  artifacts?: ArtifactSink;
  logger?: Logger;
}

/** Input for {@link guidedDeploy}. */
export interface GuidedDeployInput {
  sources: GuidedDeploySource[];
  mode: DeployMode;
  scope: GuidedDeployScope;
  workerGroups: string[];
  /** Deterministic epoch-seconds mtime for the air-gap archive (never Date). */
  mtimeSec: number;
  /** Fired with a copy of each parent step after every step-state change. */
  onProgress?: (step: JobStep) => void;
}

/** Per-source result embedded in the parent job result. */
export interface GuidedDeploySourceResult {
  sourceId: string;
  vendor: string;
  status: "succeeded" | "failed" | "skipped";
  detail?: string;
  /** Set when status is 'skipped' by the resume scan. */
  reason?: "already-completed";
  /**
   * The Azure scope this source's destinations were produced UNDER (task item
   * 7, the stale-data hazard). Tagging the record with its producing scope lets
   * a consumer detect a stale destination when the active profile/scope later
   * changes - the legacy destination files carried no scope and silently went
   * stale. Present on every processed source (absent only on resume-skips,
   * which did no work).
   */
  scope?: GuidedDeployScope;
  /** Archive file name when an air-gap export was produced. */
  archiveName?: string;
  error?: string;
}

/** `result` recorded on the parent job (persisted after every step). */
export interface GuidedDeployOutcome {
  sources: GuidedDeploySourceResult[];
  succeeded: number;
  failed: number;
  skipped: number;
  /** True once every source has been processed (deploy-complete reached). */
  deployComplete: boolean;
  /** Whether source wiring is unlocked (deploy complete AND Cribl not skipped). */
  wiringUnlocked: boolean;
}

/** Thrown by the single-flight guard when a same-key deploy is already running. */
export class GuidedDeployBusyError extends Error {
  /** The id of the already-running job. */
  readonly runningJobId: string;

  constructor(message: string, runningJobId: string) {
    super(message);
    this.name = "GuidedDeployBusyError";
    this.runningJobId = runningJobId;
  }
}

/** Per-source step name on the parent record. */
export function guidedDeployStepName(
  sourceId: string,
  step: "research" | "azure" | "build-pack" | "cribl" | "air-gap",
): string {
  return `${GUIDED_DEPLOY_STEP_PREFIX}${sourceId}:${step}`;
}

/**
 * The ordered PARENT step names a deploy for these sources/mode will carry (UIs
 * seed step lines from this). Cribl-publish steps are ABSENT when Cribl is
 * skipped; air-gap steps are PRESENT only in partial/air-gapped modes.
 */
export function guidedDeployStepsFor(
  sources: readonly GuidedDeploySource[],
  mode: DeployMode,
): string[] {
  const gating = deployModeGating(mode);
  const steps: string[] = [];
  for (const source of sources) {
    steps.push(guidedDeployStepName(source.id, "research"));
    steps.push(guidedDeployStepName(source.id, "azure"));
    steps.push(guidedDeployStepName(source.id, "build-pack"));
    if (!gating.skipCribl) {
      steps.push(guidedDeployStepName(source.id, "cribl"));
    }
    if (gating.skipAzure || gating.skipCribl) {
      steps.push(guidedDeployStepName(source.id, "air-gap"));
    }
  }
  return steps;
}

/**
 * The resume/single-flight identity of a deploy: same sources (in order) against
 * the same scope, worker groups, and mode is the SAME deploy. Persisted on the
 * parent record's input as `deployKey`. Exported so shells (and tests) can find
 * an in-flight run.
 */
export function guidedDeployKey(input: GuidedDeployInput): string {
  return JSON.stringify({
    subscriptionId: input.scope.subscriptionId,
    resourceGroup: input.scope.resourceGroup,
    workspaceName: input.scope.workspaceName,
    workerGroups: input.workerGroups,
    mode: input.mode,
    sources: input.sources.map((source) => source.id),
  });
}

/** Read a property of an unknown value, or undefined when not an object. */
function prop(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

/** A prior-run source entry that counts as COMPLETED for resume purposes. */
function isCompletedSource(entry: unknown): boolean {
  const status = prop(entry, "status");
  return status === "succeeded" || status === "skipped";
}

/**
 * Run the guided deploy. Never rejects for a source's failure (failure
 * isolation - the parent record carries the outcome). It DOES reject on a
 * single-flight conflict ({@link GuidedDeployBusyError}), when the JobStore
 * itself fails, or when a partial/air-gapped mode is missing the ArtifactSink.
 */
export async function guidedDeploy(
  ports: GuidedDeployPorts,
  input: GuidedDeployInput,
  collaborators: GuidedDeployCollaborators,
): Promise<JobRecord> {
  const { jobs, logger } = ports;
  const gating = deployModeGating(input.mode);
  const wantsArchive = gating.skipAzure || gating.skipCribl;
  if (wantsArchive && ports.artifacts === undefined) {
    throw new Error(
      `guidedDeploy: mode '${input.mode}' requires an ArtifactSink to deliver ` +
        "the air-gap archive, but none was provided",
    );
  }
  const deployKey = guidedDeployKey(input);

  // ---- Single-flight guard: reject if a same-key deploy is still running.
  const prior = await jobs.list(GUIDED_DEPLOY_JOB_KIND);
  for (const record of prior) {
    if (
      record.status === "running" &&
      prop(record.input, "deployKey") === deployKey
    ) {
      throw new GuidedDeployBusyError(
        `a guided deploy for this target is already running (job ${record.id})`,
        record.id,
      );
    }
  }

  // ---- Resume scan: which sources did a previous run of THIS key finish?
  const completed = new Set<string>();
  for (const record of prior) {
    if (prop(record.input, "deployKey") !== deployKey) {
      continue;
    }
    const priorSources = prop(record.result, "sources");
    if (!Array.isArray(priorSources)) {
      continue;
    }
    for (const entry of priorSources) {
      const sourceId = prop(entry, "sourceId");
      if (typeof sourceId === "string" && isCompletedSource(entry)) {
        completed.add(sourceId);
      }
    }
  }

  const job = await jobs.create(GUIDED_DEPLOY_JOB_KIND, {
    deployKey,
    mode: input.mode,
    scope: input.scope,
    workerGroups: input.workerGroups,
    sources: input.sources.map((source) => ({
      id: source.id,
      vendor: source.vendor,
      packName: source.packName,
      tables: source.tables,
    })),
    resumedSources: [...completed],
  });

  logger?.info(
    "guided-deploy: job started",
    {
      sources: input.sources.length,
      mode: input.mode,
      skipAzure: gating.skipAzure,
      skipCribl: gating.skipCribl,
      resumed: completed.size,
    },
    job.id,
  );

  const steps: JobStep[] = guidedDeployStepsFor(input.sources, input.mode).map(
    (name) => ({ name, status: "pending" as JobStatus }),
  );
  const research =
    collaborators.research !== undefined
      ? memoizeVendorResearch(collaborators.research)
      : undefined;

  const pushSteps = async (): Promise<void> => {
    await jobs.update(job.id, { steps: steps.map((step) => ({ ...step })) });
  };
  const setStep = async (
    name: string,
    status: JobStatus,
    detail?: string,
  ): Promise<void> => {
    const step = steps.find((candidate) => candidate.name === name);
    if (step === undefined) {
      // A step name that mode gating did not emit (e.g. cribl when skipCribl):
      // silently ignore so the flow stays declarative.
      return;
    }
    step.status = status;
    if (detail !== undefined) {
      step.detail = detail;
    }
    await pushSteps();
    input.onProgress?.({ ...step });
  };

  await jobs.update(job.id, { status: "running" });
  await pushSteps();

  const results: GuidedDeploySourceResult[] = [];
  const outcomeSoFar = (deployComplete: boolean): GuidedDeployOutcome => ({
    sources: results.map((result) => ({ ...result })),
    succeeded: results.filter((r) => r.status === "succeeded").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    deployComplete,
    wiringUnlocked:
      deployComplete && canWireSource(true, input.mode) && !gating.skipCribl,
  });
  const persist = async (deployComplete: boolean): Promise<void> => {
    await jobs.update(job.id, { result: outcomeSoFar(deployComplete) });
  };

  const ctx: GuidedDeployContext = {
    scope: input.scope,
    workerGroups: input.workerGroups,
    mode: input.mode,
    gating,
    jobId: job.id,
  };

  for (const source of input.sources) {
    // RESUME: a source a prior run finished is skipped with ZERO collaborator
    // calls (persisted, so it survives reload).
    if (completed.has(source.id)) {
      await setStep(guidedDeployStepName(source.id, "research"), "skipped");
      await setStep(guidedDeployStepName(source.id, "azure"), "skipped");
      await setStep(guidedDeployStepName(source.id, "build-pack"), "skipped");
      await setStep(guidedDeployStepName(source.id, "cribl"), "skipped");
      await setStep(guidedDeployStepName(source.id, "air-gap"), "skipped");
      results.push({
        sourceId: source.id,
        vendor: source.vendor,
        status: "skipped",
        reason: "already-completed",
        detail: "already completed by a previous run",
      });
      await persist(false);
      continue;
    }

    try {
      // ---- research (memoized) --------------------------------------------
      const researchStep = guidedDeployStepName(source.id, "research");
      if (research === undefined) {
        await setStep(researchStep, "skipped", "no research provider");
      } else {
        await setStep(researchStep, "running");
        await research(source.vendor);
        await setStep(researchStep, "succeeded");
      }

      // ---- azure (deploy or collect templates) ----------------------------
      const azureStep = guidedDeployStepName(source.id, "azure");
      let deployResult: DeploySourceResult;
      if (gating.skipAzure) {
        // Offline: still COLLECT ARM bodies + placeholder destinations for the
        // archive; no ARM writes happen (the collaborator honors gating).
        await setStep(azureStep, "running", "collecting templates (offline)");
        deployResult = await collaborators.deploySource(source, ctx);
        await setStep(
          azureStep,
          "succeeded",
          deployResult.detail ?? "templates collected",
        );
      } else {
        const existingTables =
          collaborators.listExistingDestinations !== undefined
            ? await collaborators.listExistingDestinations(ctx)
            : [];
        const decision = decideDcrsStep(source.tables, existingTables, {
          skipAzure: false,
        });
        if (decision.kind === "skip") {
          await setStep(azureStep, "skipped", decision.detail);
          deployResult = await collaborators.deploySource(source, ctx);
        } else {
          await setStep(azureStep, "running", decision.detail);
          deployResult = await collaborators.deploySource(source, ctx);
          await setStep(
            azureStep,
            "succeeded",
            deployResult.detail ?? "DCRs deployed",
          );
        }
      }

      // ---- build pack -----------------------------------------------------
      const buildStep = guidedDeployStepName(source.id, "build-pack");
      await setStep(buildStep, "running");
      const built = await collaborators.buildSourcePack(source, ctx);
      await setStep(buildStep, "succeeded", `version ${built.version}`);

      // ---- cribl publish (skipped when Cribl skipped or no groups) --------
      const criblStep = guidedDeployStepName(source.id, "cribl");
      if (gating.skipCribl) {
        // No cribl step exists in this mode; setStep is a no-op.
        await setStep(criblStep, "skipped");
      } else if (input.workerGroups.length === 0) {
        await setStep(criblStep, "skipped", "no worker groups selected");
      } else if (collaborators.publishPack === undefined) {
        await setStep(criblStep, "skipped", "no publish provider");
      } else {
        await setStep(criblStep, "running");
        const published = await collaborators.publishPack(source, ctx, built);
        await setStep(
          criblStep,
          "succeeded",
          published.detail ??
            `uploaded to ${published.uploadedGroups.length} group(s)`,
        );
      }

      // ---- air-gap export (partial / air-gapped modes) --------------------
      let archiveName: string | undefined;
      if (wantsArchive) {
        const airGapStep = guidedDeployStepName(source.id, "air-gap");
        await setStep(airGapStep, "running");
        const archive = buildAirGapArchive({
          solutionName: source.vendor,
          packName: source.packName,
          crbl: built.crbl,
          armRequests: deployResult.armRequests,
          destinations: deployResult.destinations,
          sourceId: source.id,
          mtimeSec: input.mtimeSec,
        });
        archiveName = `${source.packName}-artifacts.tgz`;
        // ports.artifacts is guaranteed present (checked at entry).
        await ports.artifacts!.save(
          archiveName,
          AIR_GAP_ARCHIVE_MIME,
          archive.archive,
        );
        await setStep(
          airGapStep,
          "succeeded",
          `${archive.fileNames.length} artifact(s) in ${archiveName}`,
        );
      }

      results.push({
        sourceId: source.id,
        vendor: source.vendor,
        status: "succeeded",
        detail: `${source.tables.length} table(s); pack ${source.packName}`,
        scope: input.scope,
        archiveName,
      });
      logger?.info("guided-deploy: source succeeded", { source: source.id }, job.id);
    } catch (err) {
      // FAILURE ISOLATION: record and continue with the next source.
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        sourceId: source.id,
        vendor: source.vendor,
        status: "failed",
        scope: input.scope,
        error: message,
      });
      logger?.error(
        "guided-deploy: source failed",
        { source: source.id },
        job.id,
      );
    }
    await persist(false);
  }

  const anyFailed = results.some((r) => r.status === "failed");
  await jobs.update(job.id, {
    status: anyFailed ? "failed" : "succeeded",
    result: outcomeSoFar(true),
    error: anyFailed
      ? `${results.filter((r) => r.status === "failed").length} source(s) failed`
      : undefined,
  });
  const finalRecord = await jobs.get(job.id);
  // Unreachable: we just created and updated this id.
  if (finalRecord === null) {
    throw new Error(`guidedDeploy: job ${job.id} vanished from the store`);
  }
  return finalRecord;
}
