/**
 * Phase 9 - Integration (lab-cribl): the Cribl config bundle assembled
 * PURELY into the result (the screen downloads it via the ArtifactSink).
 * No ARM calls - this phase cannot fail.
 */

import {
  DEFAULT_LAB_ADX_DATABASE,
} from "../../domain/labs/lab-analytics";
import { buildLabCriblBundle } from "../../domain/labs/lab-cribl";
import { DEFAULT_LAB_EVENT_HUBS } from "../../domain/labs/lab-naming";
import type { LabPhaseContext } from "./lab-phase-context";

/** Run the Cribl-config assembly phase (the sequencer guards on hasStep). */
export async function runCriblPhase(ctx: LabPhaseContext): Promise<void> {
  const { input, result } = ctx;
  await ctx.setStep("cribl-configs", "running");
  const bundle = buildLabCriblBundle({
    flags: input.flags,
    tenantId: input.tenantId ?? "",
    clientId: input.clientId ?? "",
    storageAccountName: result.storage?.accountName ?? input.names.storageAccount,
    eventHubNamespace: input.names.eventHubNamespace,
    eventHubs: input.labEventHubs ?? DEFAULT_LAB_EVENT_HUBS,
    adxClusterName: input.names.adxCluster,
    adxClusterUri: result.analytics?.adxClusterUri ?? "",
    adxDatabase: (input.adxDatabase ?? DEFAULT_LAB_ADX_DATABASE).name,
    dcrs: (result.dcrs ?? []).filter((d) => d.error === undefined),
  });
  result.criblConfigs = bundle;
  await ctx.setStep(
    "cribl-configs",
    "succeeded",
    `${bundle.adxDestinations.length} destination(s), ` +
      `${bundle.eventHubSources.length + bundle.blobSources.length} source(s), ` +
      `${bundle.requiredSecrets.length} required secret(s)`,
  );
}
