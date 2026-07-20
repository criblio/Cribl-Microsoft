/**
 * deploy-flowlog-pack - the Cribl-side finish of the AzureFlowLogs pack
 * install (roadmap Phase 4/5 convergence).
 *
 * The SHELL uploads the assembled .crbl through its PackInstallClient (the
 * binary two-step upload lives shell-side, like every pack install); this
 * usecase performs the Cribl API steps around it:
 *
 * 1. OPTIONAL secret provisioning: create the Azure_vNet_Flowlogs_Secret
 *    text secret in the worker group from a TRANSIENT client-secret input
 *    (create-or-update: POST, PATCH on conflict - the guided-deploy secret
 *    convention). Skipped when no secret value is supplied (the operator may
 *    have created it already).
 * 2. Commit + deploy, mirroring onboard-table's REPORTED-BUT-NONFATAL
 *    semantics: single-instance leaders reject group commits, so an HTTP
 *    error is recorded on the outcome without throwing; transport failures
 *    still reject.
 */

import type { CriblClient } from "../../ports/cribl-client";
import type { Logger } from "../../ports/logger";
import { FLOWLOG_SECRET_NAME } from "../../domain/labs/lab-flowlog-pack";

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

function prop(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

/** Input for {@link finalizeFlowLogPack}. */
export interface FinalizeFlowLogPackInput {
  /** The worker group the pack was installed into. */
  groupId: string;
  /**
   * TRANSIENT Azure client secret to store as the collector's text secret;
   * empty/absent skips secret provisioning entirely.
   */
  clientSecret?: string;
}

/** The finish outcome (honest per-step reporting). */
export interface FinalizeFlowLogPackOutcome {
  /** "created" | "updated" | "skipped" - how the text secret was handled. */
  secret: "created" | "updated" | "skipped";
  /** The commit hash when commit+deploy succeeded, else null. */
  commitVersion: string | null;
  /** True when the group deploy PATCH succeeded. */
  deployed: boolean;
  /** Commit/deploy failure text (nonfatal - single-instance leaders reject). */
  commitError?: string;
}

/**
 * Provision the collector's text secret (optional) and commit+deploy the
 * group. Rejects only on transport failure or a hard secret-provisioning
 * error; commit/deploy HTTP errors are reported on the outcome.
 */
export async function finalizeFlowLogPack(
  cribl: CriblClient,
  input: FinalizeFlowLogPackInput,
  logger?: Logger,
): Promise<FinalizeFlowLogPackOutcome> {
  const outcome: FinalizeFlowLogPackOutcome = {
    secret: "skipped",
    commitVersion: null,
    deployed: false,
  };

  // --- 1. Secret (create-or-update; the guided-deploy convention) ---------
  const secretValue = input.clientSecret ?? "";
  if (secretValue !== "") {
    const create = await cribl.request({
      method: "POST",
      path: "/system/secrets",
      groupId: input.groupId,
      body: { id: FLOWLOG_SECRET_NAME, type: "text", value: secretValue },
    });
    if (is2xx(create.status)) {
      outcome.secret = "created";
    } else if (create.status === 409 || create.status === 400) {
      // Conflict shapes vary by version; PATCH is the documented fallback.
      const update = await cribl.request({
        method: "PATCH",
        path: `/system/secrets/${FLOWLOG_SECRET_NAME}`,
        groupId: input.groupId,
        body: { id: FLOWLOG_SECRET_NAME, type: "text", value: secretValue },
      });
      if (!is2xx(update.status)) {
        throw new Error(
          `store Cribl secret '${FLOWLOG_SECRET_NAME}': HTTP ${update.status} ` +
            JSON.stringify(update.body),
        );
      }
      outcome.secret = "updated";
    } else {
      throw new Error(
        `store Cribl secret '${FLOWLOG_SECRET_NAME}': HTTP ${create.status} ` +
          JSON.stringify(create.body),
      );
    }
  }

  // --- 2. Commit + deploy (reported-but-nonfatal, onboard-table semantics) -
  const commit = await cribl.request({
    method: "POST",
    path: "/version/commit",
    groupId: input.groupId,
    body: { message: "Install AzureFlowLogs pack", effective: true },
  });
  if (!is2xx(commit.status)) {
    outcome.commitError = `commit: HTTP ${commit.status} ${JSON.stringify(commit.body)}`;
  } else {
    const items = prop(commit.body, "items");
    const hash =
      Array.isArray(items) && items.length > 0 ? prop(items[0], "commit") : undefined;
    if (typeof hash !== "string" || hash === "") {
      outcome.commitError =
        "commit succeeded but no commit hash was returned; deploy manually in Cribl";
    } else {
      outcome.commitVersion = hash;
      const deploy = await cribl.request({
        method: "PATCH",
        path: `/master/groups/${input.groupId}/deploy`,
        body: { version: hash },
      });
      if (is2xx(deploy.status)) {
        outcome.deployed = true;
      } else {
        outcome.commitError = `deploy: HTTP ${deploy.status} ${JSON.stringify(deploy.body)}`;
      }
    }
  }

  logger?.info("deploy-flowlog-pack: finalized", {
    groupId: input.groupId,
    secret: outcome.secret,
    deployed: outcome.deployed,
  });
  return outcome;
}
