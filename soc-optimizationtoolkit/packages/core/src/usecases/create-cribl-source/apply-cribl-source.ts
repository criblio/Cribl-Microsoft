/**
 * create-cribl-source, APPLY half (AZR-34, ADR 0007 D10).
 *
 * Runs only after the operator confirmed the ReadyCriblSource the plan
 * returned. The order is fixed, and pinned call by call in the test:
 *
 *   1. GET /version/status         - the kit's commitScopeGrew: if the commit
 *                                    would now carry work the confirm did not
 *                                    name, the confirm is void ('scope-grew')
 *   2. GET /system/secrets/:id,    - re-check: both still absent
 *      GET /system/inputs
 *   3. listKeys (Azure POST), or   - the credential, read only now, after the
 *      parse the paste closure       re-checks; a paste whose descriptor moved
 *                                    since the plan refuses ('pasted-changed')
 *   4. POST /system/secrets        - {id, secretType:'text', value}. A 409
 *                                    refuses; never PATCH
 *   5. GET /system/inputs,         - re-listed right before the create; an id
 *      POST /system/inputs           that appeared refuses
 *   6. GET /system/inputs/:id      - the kit's verifyStored
 *   7. the kit's commitAndDeploy   - status, commit {message, files}, status,
 *                                    HEAD, PATCH products deploy (master on 404)
 *   8. the kit's deployedVersion   - configVersion compared by sameCommit
 *
 * THE CREDENTIAL VALUE GOES IN ONE PLACE: the POST /system/secrets body. It is
 * never in the input body, the outcome, the KV record or a log line.
 *
 * Every non-deployed kit outcome is kept BY NAME; the literal 'committed' is
 * never produced (contrast wire-source.ts, a filed bug card). No input PATCH
 * or DELETE exists here.
 */

import {
  buildNamespaceListKeysRequest,
  parseListKeys,
} from "../../domain/eventhub-arm";
import {
  COMMIT_MARKERS,
  buildSecretBody,
  classifyExistingInput,
  classifyExistingSecret,
  isInvalidConnection,
  parseEventHubConnectionString,
  sameDescriptor,
} from "../../domain/cribl-onboarding-source";
import type { CriblSourceRecord } from "../../domain/onboarding-howto/progress-document";
import {
  commitAndDeploy,
  commitScopeGrew,
  deployedVersion,
  sameCommit,
  type CommitDeployOutcome,
  type DeployRoute,
} from "../../kit/config-writes/commitDeploy";
import { verifyStored, type WriteTarget } from "../../kit/config-writes/readModifyWrite";
import { isOk } from "../../kit/config-writes/transport";
import {
  CRIBL_SOURCE_LOG_PREFIX,
  groupRequest,
  readInputs,
  readScope,
  readSecret,
  responseDetail,
  safeCall,
  type CriblSourcePorts,
  type ReadyCriblSource,
} from "./plan-cribl-source";

/** The credential at APPLY time. A paste is a closure, read once, here. */
export type ApplyCredential =
  | { readonly kind: "listKeys" }
  | { readonly kind: "paste"; readonly value: () => string };

/** The kit's commitAndDeploy outcomes that do not deploy, by their own names. */
export type NotDeployedKitReason = Exclude<CommitDeployOutcome["kind"], "deployed">;

/** Why a created input was not deployed. */
export type NotDeployedReason =
  | NotDeployedKitReason
  /** The read-back after the create differs from what was sent: written, not verified. */
  | "stored-mismatch"
  /** The read-back could not be read: written, not verified. */
  | "stored-unreadable"
  /** A call in the commit sequence rejected; what Cribl did is unknown. */
  | "commit-sequence-failed";

export type ApplyRefusalReason =
  | "credential-changed"
  | "status-unknown"
  | "scope-unplaced"
  | "scope-grew"
  | "secret-appeared"
  | "input-appeared"
  | "inputs-unreadable"
  | "secret-unreadable"
  | "paste-invalid"
  | "pasted-changed"
  | "secret-exists";

/** Failure stages, in order. */
export type ApplyFailureStage = "list-keys" | "secret-create" | "input-create";

export type ApplyCriblSourceOutcome =
  | {
      readonly kind: "created-running";
      readonly record: CriblSourceRecord;
      readonly hash: string;
      readonly configVersion: string;
    }
  | {
      readonly kind: "created-deployed-unconfirmed";
      readonly record: CriblSourceRecord;
      readonly hash: string;
      /** null when unreadable; otherwise a version that is not this commit. */
      readonly configVersion: string | null;
    }
  | {
      readonly kind: "created-not-deployed";
      readonly record: CriblSourceRecord;
      readonly reason: NotDeployedReason;
      readonly detail: string;
      /** The commit, when one was made. */
      readonly hash?: string;
      /** deploy-failed only: which deploy path refused. */
      readonly route?: DeployRoute;
    }
  | {
      readonly kind: "refused";
      readonly reason: ApplyRefusalReason;
      readonly detail: string;
      /** Set when a write already landed before the refusal (the secret). */
      readonly leftBehind?: { readonly secretId: string };
    }
  | {
      readonly kind: "failed";
      readonly stage: ApplyFailureStage;
      readonly detail: string;
      readonly leftBehind?: { readonly secretId: string };
    };

/** The verifyStored target for one input: every array the body sets is ours whole. */
function inputTarget(inputId: string): WriteTarget {
  return {
    path: `/system/inputs/${encodeURIComponent(inputId)}`,
    method: "PATCH",
    arrays: {
      brokers: { kind: "replace" },
      topics: { kind: "replace" },
      streamtags: { kind: "replace" },
    },
  };
}

function kitDetail(outcome: CommitDeployOutcome): string {
  switch (outcome.kind) {
    case "deployed":
      return `deployed ${outcome.hash}`;
    case "nothing-to-commit":
      return "Cribl reported none of this source's files as pending, so nothing was committed.";
    case "status-unknown":
      return `The pending-change status could not be read (HTTP ${outcome.response.status}); nothing was committed.`;
    case "scope-unknown":
      return `Pending changes could not be placed in a group (${outcome.unplaced.join(", ")}); nothing was committed.`;
    case "newer-commit":
      return `Committed ${outcome.hash}, but ${outcome.head} is newer; deploying would roll it back, so nothing was deployed.`;
    case "head-unknown":
      return `Committed ${outcome.hash}, but the newest commit could not be read (HTTP ${outcome.response.status}); nothing was deployed.`;
    case "committed-unknown-hash":
      return "The commit call succeeded but named no commit; nothing was deployed.";
    case "commit-failed":
      return `The commit was refused (HTTP ${outcome.response.status}).`;
    case "incomplete":
      return `Committed ${outcome.hash}, but ${outcome.leftBehind.join(", ")} is still pending; nothing was deployed.`;
    case "unverified":
      return `Committed ${outcome.hash}, but the status re-read failed (HTTP ${outcome.response.status}); nothing was deployed.`;
    case "deploy-failed":
      return `Committed ${outcome.hash}; the deploy via the ${outcome.route} path was refused (HTTP ${outcome.response.status}).`;
  }
}

/**
 * Create the confirmed source. Never throws for a Cribl or Azure answer;
 * every path ends in a named outcome.
 */
export async function applyCriblSource(
  ports: CriblSourcePorts,
  ready: ReadyCriblSource,
  credential: ApplyCredential,
): Promise<ApplyCriblSourceOutcome> {
  const { groupId, inputId, secretId } = ready;
  const log = { groupId, inputId, secretId };
  const refuse = (reason: ApplyRefusalReason, detail: string, leftBehind?: { secretId: string }): ApplyCriblSourceOutcome => {
    ports.logger?.warn(`${CRIBL_SOURCE_LOG_PREFIX} cribl source refused`, { ...log, reason });
    return leftBehind === undefined ? { kind: "refused", reason, detail } : { kind: "refused", reason, detail, leftBehind };
  };
  const fail = (stage: ApplyFailureStage, detail: string, leftBehind?: { secretId: string }): ApplyCriblSourceOutcome => {
    ports.logger?.error(`${CRIBL_SOURCE_LOG_PREFIX} cribl source failed`, { ...log, stage });
    return leftBehind === undefined ? { kind: "failed", stage, detail } : { kind: "failed", stage, detail, leftBehind };
  };

  // listKeys belongs to an Event Hub listKeys plan; a paste to a paste or blob plan.
  const expectsPaste = ready.credentialKind !== "listKeys";
  if (expectsPaste !== (credential.kind === "paste")) {
    return refuse("credential-changed", "The credential choice changed since the confirm; review and confirm again.");
  }

  const request = groupRequest(ports.cribl, groupId);

  // 1. The commit scope the confirm named must not have grown.
  const scope = await readScope(request, groupId);
  if (scope.kind === "refused") return refuse(scope.reason, scope.detail);
  if (commitScopeGrew(ready.scope, scope.scope)) {
    return refuse(
      "scope-grew",
      `Since the confirm, more uncommitted work appeared in the files this commit carries (${scope.scope.alreadyDirty.join(", ")}). Review and confirm again.`,
    );
  }

  // 2. Both objects must still be absent.
  const secretRead = await readSecret(request, secretId);
  const secretVerdict = classifyExistingSecret({ read: secretRead, secretId, recorded: ready.kvRecord });
  if (secretVerdict.kind === "unknown") return refuse("secret-unreadable", `Secret ${secretId} could not be re-read (${secretVerdict.detail}).`);
  if (secretVerdict.kind !== "absent") return refuse("secret-appeared", `Secret ${secretId} was created by someone else since the confirm.`);
  const inputsRead = await readInputs(request);
  const inputVerdict = classifyExistingInput({ read: inputsRead, expected: ready.inputBody, recorded: ready.kvRecord });
  if (inputVerdict.kind === "unknown") return refuse("inputs-unreadable", `Cribl's inputs could not be re-read (${inputVerdict.detail}).`);
  if (inputVerdict.kind !== "absent") return refuse("input-appeared", `Input ${inputId} appeared since the confirm.`);

  // 3. The credential, read only now.
  let value: string;
  if (credential.kind === "listKeys") {
    if (ready.namespace === null) return fail("list-keys", "The plan named no namespace to read the key from.");
    let response;
    try {
      response = await ports.azure.request(buildNamespaceListKeysRequest(ready.namespace, ready.keyNameOrPrincipal));
    } catch {
      return fail("list-keys", `listKeys on rule ${ready.keyNameOrPrincipal} got no response.`);
    }
    if (response.status < 200 || response.status >= 300) {
      return fail("list-keys", `listKeys on rule ${ready.keyNameOrPrincipal} was refused (HTTP ${response.status}).`);
    }
    try {
      value = parseListKeys(response.body);
    } catch (error) {
      return fail("list-keys", error instanceof Error ? error.message : "listKeys answered without a connection string.");
    }
  } else {
    let raw: string;
    try {
      raw = credential.value();
    } catch {
      return refuse("paste-invalid", "The pasted credential could not be read; paste it again.");
    }
    value = raw.trim();
    if (value === "") return refuse("paste-invalid", "The pasted credential is empty; paste it again.");
    if (ready.descriptor !== null) {
      const parsed = parseEventHubConnectionString(value);
      if (isInvalidConnection(parsed)) {
        return refuse("pasted-changed", "The pasted connection string no longer parses; paste it again and confirm.");
      }
      if (!sameDescriptor(parsed, ready.descriptor)) {
        return refuse("pasted-changed", "The pasted connection string changed since the confirm; review and confirm again.");
      }
    }
  }

  // 4. The secret. A 409 refuses; this never PATCHes.
  const secretBody = buildSecretBody({ id: secretId, value, description: ready.secretDescription });
  const secretPost = await safeCall(request, "POST", "/system/secrets", secretBody);
  if (secretPost.status === 409) {
    return refuse("secret-exists", `Secret ${secretId} already exists; this app does not overwrite a secret.`);
  }
  if (!isOk(secretPost.status)) return fail("secret-create", responseDetail(`creating secret ${secretId}`, secretPost));
  const left = { secretId };

  // 5. Re-list, then create the input.
  const relist = await readInputs(request);
  const relistVerdict = classifyExistingInput({ read: relist, expected: ready.inputBody, recorded: ready.kvRecord });
  if (relistVerdict.kind === "unknown") return refuse("inputs-unreadable", `Cribl's inputs could not be re-read (${relistVerdict.detail}).`, left);
  if (relistVerdict.kind !== "absent") return refuse("input-appeared", `Input ${inputId} appeared while the secret was being created.`, left);
  const inputPost = await safeCall(request, "POST", "/system/inputs", ready.inputBody);
  if (!isOk(inputPost.status)) return fail("input-create", responseDetail(`creating input ${inputId}`, inputPost), left);

  const record: CriblSourceRecord = { groupId, inputId, inputType: ready.inputType, secretId };
  const notDeployed = (reason: NotDeployedReason, detail: string, extra?: { hash?: string; route?: DeployRoute }): ApplyCriblSourceOutcome => {
    ports.logger?.warn(`${CRIBL_SOURCE_LOG_PREFIX} cribl source created, not deployed`, { ...log, reason });
    return { kind: "created-not-deployed", record, reason, detail, ...(extra ?? {}) };
  };

  // 6. Read it back. Anything but stored is written, not verified: never committed.
  const stored = await verifyStored(request, inputTarget(inputId), ready.inputBody);
  if (stored.kind === "mismatch") {
    return notDeployed("stored-mismatch", `Cribl stored input ${inputId} with different ${stored.mismatches.map((m) => m.path).join(", ")}; it was not committed.`);
  }
  if (stored.kind !== "stored") {
    return notDeployed("stored-unreadable", `Input ${inputId} was created but could not be read back; it was not committed.`);
  }

  // 7. Commit and deploy, the kit's sequence.
  let outcome: CommitDeployOutcome;
  try {
    outcome = await commitAndDeploy(request, {
      group: groupId,
      markers: COMMIT_MARKERS,
      message: `${CRIBL_SOURCE_LOG_PREFIX} create Cribl source ${inputId}`,
    });
  } catch (error) {
    return notDeployed(
      "commit-sequence-failed",
      `A call in the commit and deploy sequence got no response (${error instanceof Error ? error.message : String(error)}); check the group's pending changes in Cribl.`,
    );
  }
  if (outcome.kind !== "deployed") {
    const extra: { hash?: string; route?: DeployRoute } = {};
    if ("hash" in outcome) extra.hash = outcome.hash;
    if (outcome.kind === "deploy-failed") extra.route = outcome.route;
    return notDeployed(outcome.kind, kitDetail(outcome), extra);
  }

  // 8. What the workers run.
  let configVersion: string | null;
  try {
    configVersion = await deployedVersion(request, groupId);
  } catch {
    configVersion = null;
  }
  if (configVersion !== null && sameCommit(configVersion, outcome.hash)) {
    ports.logger?.info(`${CRIBL_SOURCE_LOG_PREFIX} cribl source created and running`, { ...log, hash: outcome.hash });
    return { kind: "created-running", record, hash: outcome.hash, configVersion };
  }
  ports.logger?.warn(`${CRIBL_SOURCE_LOG_PREFIX} cribl source deployed, unconfirmed`, { ...log, hash: outcome.hash });
  return { kind: "created-deployed-unconfirmed", record, hash: outcome.hash, configVersion };
}
