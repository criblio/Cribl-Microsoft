/**
 * Phase 2 - Storage (LAB-04 + LAB-05, when the profile deploys storage):
 * the storage account (GET-first; global-name collisions retried with a
 * SHELL-minted suffix, the legacy random-suffix behavior), the pattern
 * containers with the verbatim skip rules, the notification queue, and the
 * Event Grid system topic + BlobCreated-to-queue subscriptions (provider
 * registered on demand). Containers/queues ride the ARM MANAGEMENT plane -
 * no storage keys ever touch the app.
 *
 * A storage-account failure skips the dependent storage sub-steps but the
 * independent networking phase still runs (legacy phases were isolated).
 */

import {
  DEFAULT_LAB_CONTAINERS,
  DEFAULT_LAB_EVENT_GRID_SUBSCRIPTIONS,
  DEFAULT_LAB_QUEUES,
  DEFAULT_LAB_STORAGE_SETTINGS,
  buildBlobContainerGetRequest,
  buildBlobContainerPutRequest,
  buildEventGridProviderGetRequest,
  buildEventGridProviderRegisterRequest,
  buildEventSubscriptionGetRequest,
  buildEventSubscriptionPutRequest,
  buildStorageAccountGetRequest,
  buildStorageAccountPutRequest,
  buildStorageQueueGetRequest,
  buildStorageQueuePutRequest,
  buildSystemTopicGetRequest,
  buildSystemTopicPutRequest,
  collisionStorageAccountName,
  containersToDeploy,
  eventGridSystemTopicName,
  parseProviderRegistrationState,
  parseStorageProvisioningState,
} from "../../domain/labs/lab-storage";
import { httpErrorText, is2xx, isErrorCode } from "../arm-http";
import { ensureResource, pollProvisioningState } from "./arm-resource";
import type { LabPhaseContext } from "./lab-phase-context";
import {
  NOT_REQUESTED,
  PREREQUISITE_FAILED,
  type LabStorageOutcome,
} from "./provision-lab-types";

/** ARM error code when a storage account name is globally taken. */
const STORAGE_NAME_TAKEN = "StorageAccountAlreadyTaken";

/** Run the storage phase (the sequencer guards on hasStep). */
export async function runStoragePhase(ctx: LabPhaseContext): Promise<void> {
  const { azure, input, result, errors, sub, rg } = ctx;
  const storage: LabStorageOutcome = {
    accountName: input.names.storageAccount,
    accountCreated: false,
    containers: [],
    queues: [],
  };
  result.storage = storage;
  const settings = input.storageSettings ?? DEFAULT_LAB_STORAGE_SETTINGS;
  let accountReady = false;

  await ctx.setStep("storage-account", "running");
  const getAccount = await azure.request(
    buildStorageAccountGetRequest(sub, rg, storage.accountName),
  );
  if (is2xx(getAccount.status)) {
    accountReady = true;
    await ctx.setStep("storage-account", "succeeded", "already existed");
  } else if (getAccount.status === 404) {
    // PUT with the legacy collision retry: a globally-taken name gets a
    // SHELL-minted suffix (base truncated to 20 + 4 chars, capped 24).
    let name = storage.accountName;
    let created = false;
    let putAttempt = 0;
    let lastError = "";
    while (!created && putAttempt < ctx.maxAttempts) {
      putAttempt++;
      const put = await azure.request(
        buildStorageAccountPutRequest(sub, rg, name, input.location, settings),
      );
      if (is2xx(put.status)) {
        created = true;
        break;
      }
      if (
        put.status === 409 &&
        isErrorCode(put.body, STORAGE_NAME_TAKEN) &&
        input.mintStorageSuffix !== undefined
      ) {
        name = collisionStorageAccountName(
          input.names.storageAccount,
          input.mintStorageSuffix(),
        );
        continue;
      }
      lastError = httpErrorText(
        `create storage account '${name}'`,
        put.status,
        put.body,
      );
      break;
    }
    if (created) {
      // Attempt-bounded provisioning poll (PUT is async on new accounts).
      const state = await pollProvisioningState({
        read: () => azure.request(buildStorageAccountGetRequest(sub, rg, name)),
        parse: parseStorageProvisioningState,
        attempts: ctx.maxAttempts,
        sleep: ctx.sleep,
        delayMs: ctx.delayMs,
      });
      if (state === "Succeeded") {
        storage.accountName = name;
        storage.accountCreated = true;
        accountReady = true;
        await ctx.setStep(
          "storage-account",
          "succeeded",
          name === input.names.storageAccount
            ? "created"
            : `created as '${name}' (name collision suffix applied)`,
        );
      } else {
        const error =
          `storage account '${name}' did not reach provisioningState Succeeded ` +
          `within ${ctx.maxAttempts} attempt(s)`;
        errors.push(error);
        await ctx.setStep("storage-account", "failed", error);
      }
    } else {
      const error =
        lastError !== ""
          ? lastError
          : `create storage account '${name}': name is taken and no suffix ` +
            `minter was provided after ${ctx.maxAttempts} attempt(s)`;
      errors.push(error);
      await ctx.setStep("storage-account", "failed", error);
    }
  } else {
    const error = httpErrorText(
      `read storage account '${storage.accountName}'`,
      getAccount.status,
      getAccount.body,
    );
    errors.push(error);
    await ctx.setStep("storage-account", "failed", error);
  }

  const storageAccountId =
    `/subscriptions/${sub}/resourceGroups/${rg}` +
    `/providers/Microsoft.Storage/storageAccounts/${storage.accountName}`;

  if (!accountReady) {
    // Dependent sub-steps cannot run; networking is independent and still does.
    await ctx.skipSteps(
      ["blob-containers", "storage-queues", "event-grid"],
      PREREQUISITE_FAILED,
    );
    return;
  }

  // --- blob-containers --------------------------------------------------
  if (!input.flags.storage.deployContainers) {
    await ctx.skipSteps(["blob-containers"], NOT_REQUESTED);
  } else {
    await ctx.setStep("blob-containers", "running");
    const toDeploy = containersToDeploy(
      input.containers ?? DEFAULT_LAB_CONTAINERS,
      input.flags,
    );
    const failures: string[] = [];
    for (const container of toDeploy) {
      const ensured = await ensureResource({
        get: () =>
          azure.request(
            buildBlobContainerGetRequest(sub, rg, storage.accountName, container.name),
          ),
        put: () =>
          azure.request(
            buildBlobContainerPutRequest(sub, rg, storage.accountName, container.name),
          ),
        context: `container '${container.name}'`,
        missOn: "any-non-2xx",
      });
      if (ensured.status === "failed") {
        failures.push(ensured.error ?? "");
      } else {
        storage.containers.push({
          name: container.name,
          created: ensured.status === "created",
        });
      }
    }
    if (failures.length > 0) {
      errors.push(...failures);
      await ctx.setStep("blob-containers", "failed", failures.join("; "));
    } else {
      await ctx.setStep(
        "blob-containers",
        "succeeded",
        toDeploy.length === 0
          ? "no containers apply to this profile"
          : storage.containers.map((c) => c.name).join(", "),
      );
    }
  }

  // --- storage-queues ---------------------------------------------------
  if (!input.flags.storage.deployQueues) {
    await ctx.skipSteps(["storage-queues"], NOT_REQUESTED);
  } else {
    await ctx.setStep("storage-queues", "running");
    const failures: string[] = [];
    for (const queue of input.queues ?? DEFAULT_LAB_QUEUES) {
      const ensured = await ensureResource({
        get: () =>
          azure.request(
            buildStorageQueueGetRequest(sub, rg, storage.accountName, queue.name),
          ),
        put: () =>
          azure.request(
            buildStorageQueuePutRequest(sub, rg, storage.accountName, queue.name),
          ),
        context: `queue '${queue.name}'`,
        missOn: "any-non-2xx",
      });
      if (ensured.status === "failed") {
        failures.push(ensured.error ?? "");
      } else {
        storage.queues.push({ name: queue.name, created: ensured.status === "created" });
      }
    }
    if (failures.length > 0) {
      errors.push(...failures);
      await ctx.setStep("storage-queues", "failed", failures.join("; "));
    } else {
      await ctx.setStep(
        "storage-queues",
        "succeeded",
        storage.queues.map((q) => q.name).join(", "),
      );
    }
  }

  // --- event-grid (LAB-05) ----------------------------------------------
  if (!input.flags.storage.deployEventGrid) {
    await ctx.skipSteps(["event-grid"], NOT_REQUESTED);
    return;
  }
  await ctx.setStep("event-grid", "running");
  let egFailed = "";

  // Provider registration (legacy Register-AzResourceProvider path).
  const provider = await azure.request(buildEventGridProviderGetRequest(sub));
  let registration = is2xx(provider.status)
    ? parseProviderRegistrationState(provider.body)
    : "";
  if (registration !== "Registered") {
    const register = await azure.request(buildEventGridProviderRegisterRequest(sub));
    if (!is2xx(register.status)) {
      egFailed = httpErrorText(
        "register the Microsoft.EventGrid provider",
        register.status,
        register.body,
      );
    } else {
      registration = await pollProvisioningState({
        read: () => azure.request(buildEventGridProviderGetRequest(sub)),
        parse: parseProviderRegistrationState,
        target: "Registered",
        attempts: ctx.maxAttempts,
        sleep: ctx.sleep,
        delayMs: ctx.delayMs,
      });
      if (registration !== "Registered") {
        egFailed =
          "Microsoft.EventGrid provider did not reach Registered within " +
          `${ctx.maxAttempts} attempt(s)`;
      }
    }
  }

  // System topic (GET-first) + subscriptions.
  const topicName = eventGridSystemTopicName(storage.accountName);
  if (egFailed === "") {
    const ensured = await ensureResource({
      get: () => azure.request(buildSystemTopicGetRequest(sub, rg, topicName)),
      put: () =>
        azure.request(
          buildSystemTopicPutRequest(sub, rg, topicName, input.location, storageAccountId),
        ),
      context: `Event Grid system topic '${topicName}'`,
    });
    if (ensured.status === "failed") {
      egFailed = ensured.error ?? "";
    }
  }
  if (egFailed === "") {
    storage.eventGridTopic = topicName;
    storage.eventGridSubscriptions = [];
    for (const subscription of input.eventGridSubscriptions ??
      DEFAULT_LAB_EVENT_GRID_SUBSCRIPTIONS) {
      const ensured = await ensureResource({
        get: () =>
          azure.request(
            buildEventSubscriptionGetRequest(sub, rg, topicName, subscription.key),
          ),
        put: () =>
          azure.request(
            buildEventSubscriptionPutRequest(
              sub,
              rg,
              topicName,
              storageAccountId,
              subscription,
            ),
          ),
        context: `Event Grid subscription '${subscription.key}'`,
        missOn: "any-non-2xx",
      });
      if (ensured.status === "failed") {
        egFailed = ensured.error ?? "";
        break;
      }
      storage.eventGridSubscriptions.push(subscription.key);
    }
  }

  if (egFailed !== "") {
    errors.push(egFailed);
    await ctx.setStep("event-grid", "failed", egFailed);
  } else {
    await ctx.setStep(
      "event-grid",
      "succeeded",
      `topic ${topicName}, subscription(s): ` +
        (storage.eventGridSubscriptions ?? []).join(", "),
    );
  }
}
