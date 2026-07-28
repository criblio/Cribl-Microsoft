/**
 * Phase 5 - Analytics (lab-analytics): Event Hub namespace/hubs/consumer
 * groups; ADX cluster (LONG poll) + CriblLogs database + the
 * CommonSecurityLog table via the ARM script resource.
 */

import {
  DEFAULT_LAB_ADX_CLUSTER,
  DEFAULT_LAB_ADX_DATABASE,
  DEFAULT_LAB_EVENTHUB_NAMESPACE,
  DEFAULT_LAB_CONSUMER_GROUPS,
  LAB_ADX_COMMONSECURITYLOG_SCHEMA,
  buildAdxClusterGetRequest,
  buildAdxClusterPutRequest,
  buildAdxDatabaseGetRequest,
  buildAdxDatabasePutRequest,
  buildAdxScriptGetRequest,
  buildAdxScriptPutRequest,
  buildConsumerGroupGetRequest,
  buildConsumerGroupPutRequest,
  buildEventHubGetRequest,
  buildEventHubNamespaceGetRequest,
  buildEventHubNamespacePutRequest,
  buildEventHubPutRequest,
  parseAdxClusterUri,
} from "../../domain/labs/lab-analytics";
import { DEFAULT_LAB_EVENT_HUBS } from "../../domain/labs/lab-naming";
import {
  armProvisioningState,
  ensureResource,
  pollProvisioningState,
} from "./arm-resource";
import type { LabPhaseContext } from "./lab-phase-context";
import { NOT_REQUESTED, type LabAnalyticsOutcome } from "./provision-lab-types";

/** Run the analytics phase (the sequencer guards on hasStep). */
export async function runAnalyticsPhase(ctx: LabPhaseContext): Promise<void> {
  const { azure, input, result, errors, sub, rg } = ctx;
  const analytics: LabAnalyticsOutcome = result.analytics ?? {};
  result.analytics = analytics;

  if (!input.flags.analytics.deployEventHub) {
    await ctx.skipSteps(["event-hub"], NOT_REQUESTED);
  } else {
    await ctx.setStep("event-hub", "running");
    const nsName = input.names.eventHubNamespace;
    analytics.namespaceName = nsName;
    analytics.hubs = [];
    let ehError = "";

    const ensuredNs = await ensureResource({
      get: () => azure.request(buildEventHubNamespaceGetRequest(sub, rg, nsName)),
      put: () =>
        azure.request(
          buildEventHubNamespacePutRequest(
            sub,
            rg,
            nsName,
            input.location,
            input.eventHubNamespaceSettings ?? DEFAULT_LAB_EVENTHUB_NAMESPACE,
          ),
        ),
      context: `Event Hub namespace '${nsName}'`,
    });
    if (ensuredNs.status === "failed") {
      ehError = ensuredNs.error ?? "";
    } else if (ensuredNs.status === "created") {
      analytics.namespaceCreated = true;
      const state = await pollProvisioningState({
        read: () => azure.request(buildEventHubNamespaceGetRequest(sub, rg, nsName)),
        parse: armProvisioningState,
        seed: armProvisioningState(ensuredNs.body),
        attempts: ctx.maxAttempts,
        sleep: ctx.sleep,
        delayMs: ctx.delayMs,
      });
      if (state !== "Succeeded") {
        ehError =
          `Event Hub namespace '${nsName}' did not reach Succeeded ` +
          `within ${ctx.maxAttempts} attempt(s)`;
      }
    } else {
      analytics.namespaceCreated = false;
    }

    if (ehError === "") {
      for (const hub of input.labEventHubs ?? DEFAULT_LAB_EVENT_HUBS) {
        const ensuredHub = await ensureResource({
          get: () => azure.request(buildEventHubGetRequest(sub, rg, nsName, hub.name)),
          put: () =>
            azure.request(
              buildEventHubPutRequest(
                sub,
                rg,
                nsName,
                hub.name,
                hub.partitionCount,
                hub.messageRetentionInDays,
              ),
            ),
          context: `Event Hub '${hub.name}'`,
        });
        if (ensuredHub.status === "failed") {
          ehError = ensuredHub.error ?? "";
          break;
        }
        analytics.hubs.push({
          name: hub.name,
          created: ensuredHub.status === "created",
        });
        // The legacy per-hub consumer groups (["cribl"] in the shipped config).
        for (const group of DEFAULT_LAB_CONSUMER_GROUPS) {
          const ensuredGroup = await ensureResource({
            get: () =>
              azure.request(
                buildConsumerGroupGetRequest(sub, rg, nsName, hub.name, group),
              ),
            put: () =>
              azure.request(
                buildConsumerGroupPutRequest(sub, rg, nsName, hub.name, group),
              ),
            context: `consumer group '${group}' on '${hub.name}'`,
          });
          if (ensuredGroup.status === "failed") {
            ehError = ensuredGroup.error ?? "";
            break;
          }
        }
        if (ehError !== "") {
          break;
        }
      }
    }

    if (ehError !== "") {
      errors.push(ehError);
      await ctx.setStep("event-hub", "failed", ehError);
    } else {
      await ctx.setStep(
        "event-hub",
        "succeeded",
        `${nsName}: ${analytics.hubs.map((h) => h.name).join(", ")}`,
      );
    }
  }

  if (!input.flags.analytics.deployADX) {
    await ctx.skipSteps(["adx"], NOT_REQUESTED);
    return;
  }
  await ctx.setStep("adx", "running");
  const clusterName = input.names.adxCluster;
  const database = input.adxDatabase ?? DEFAULT_LAB_ADX_DATABASE;
  analytics.adxClusterName = clusterName;
  analytics.adxDatabase = database.name;
  let adxError = "";

  const ensuredCluster = await ensureResource({
    get: () => azure.request(buildAdxClusterGetRequest(sub, rg, clusterName)),
    put: () =>
      azure.request(
        buildAdxClusterPutRequest(
          sub,
          rg,
          clusterName,
          input.location,
          input.adxCluster ?? DEFAULT_LAB_ADX_CLUSTER,
        ),
      ),
    context: `ADX cluster '${clusterName}'`,
  });
  if (ensuredCluster.status === "failed") {
    adxError = ensuredCluster.error ?? "";
  } else if (ensuredCluster.status === "reused") {
    analytics.adxClusterCreated = false;
    analytics.adxClusterUri = parseAdxClusterUri(ensuredCluster.body);
  } else {
    analytics.adxClusterCreated = true;
    // A 10-15 minute provisioning operation: the LONG poll bound.
    let uri = parseAdxClusterUri(ensuredCluster.body);
    const state = await pollProvisioningState({
      read: () => azure.request(buildAdxClusterGetRequest(sub, rg, clusterName)),
      parse: armProvisioningState,
      seed: armProvisioningState(ensuredCluster.body),
      attempts: ctx.longPollAttempts,
      sleep: ctx.sleep,
      delayMs: ctx.delayMs,
      keepStateOnFailedRead: true,
      onBody: (body) => {
        uri = parseAdxClusterUri(body);
      },
    });
    analytics.adxClusterUri = uri;
    if (state !== "Succeeded") {
      adxError =
        `ADX cluster '${clusterName}' is still provisioning after ` +
        `${ctx.longPollAttempts} poll attempt(s) - Azure continues server-side; ` +
        "re-run the deploy later to resume from the finished cluster";
    }
  }

  if (adxError === "") {
    const ensuredDb = await ensureResource({
      get: () => azure.request(buildAdxDatabaseGetRequest(sub, rg, clusterName, database.name)),
      put: () =>
        azure.request(
          buildAdxDatabasePutRequest(sub, rg, clusterName, input.location, database),
        ),
      context: `ADX database '${database.name}'`,
    });
    if (ensuredDb.status === "failed") {
      adxError = ensuredDb.error ?? "";
    }
  }

  if (adxError === "") {
    // The CommonSecurityLog table via the ARM script resource (GET-first;
    // the script runs async inside the database after the PUT accepts).
    const ensuredScript = await ensureResource({
      get: () =>
        azure.request(
          buildAdxScriptGetRequest(sub, rg, clusterName, database.name, "CommonSecurityLog"),
        ),
      put: () =>
        azure.request(
          buildAdxScriptPutRequest(
            sub,
            rg,
            clusterName,
            database.name,
            "CommonSecurityLog",
            LAB_ADX_COMMONSECURITYLOG_SCHEMA,
          ),
        ),
      context: "ADX table script 'create-table-CommonSecurityLog'",
    });
    if (ensuredScript.status === "failed") {
      adxError = ensuredScript.error ?? "";
    }
  }

  if (adxError !== "") {
    errors.push(adxError);
    await ctx.setStep("adx", "failed", adxError);
  } else {
    await ctx.setStep(
      "adx",
      "succeeded",
      `${clusterName} / ${database.name} (CommonSecurityLog table script submitted)`,
    );
  }
}
