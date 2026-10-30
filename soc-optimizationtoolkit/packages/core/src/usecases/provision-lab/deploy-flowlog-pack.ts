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
 *    (create-or-update through ensureTextSecret: POST, and on a 409 PATCH
 *    only a secret carrying this app's ownership stamp - DBT-152; a foreign
 *    or unreadable one, or a 400, rejects with nothing written). Skipped
 *    when no secret value is supplied (the operator may
 *    have created it already).
 * 2. Commit + deploy, mirroring onboard-table's REPORTED-BUT-NONFATAL
 *    semantics: single-instance leaders reject group commits, so an HTTP
 *    error is recorded on the outcome without throwing; transport failures
 *    still reject.
 */

import type { CriblClient } from "../../ports/cribl-client";
import type { Logger } from "../../ports/logger";
import { FLOWLOG_SECRET_NAME } from "../../domain/labs/lab-flowlog-pack";
import { ensureTextSecret } from "../ensure-secret";
import { is2xx, prop } from "../arm-http";

/**
 * The description the collector's text secret is written with; buildSecretBody
 * (inside ensureTextSecret) appends the app's ownership stamp to it (DBT-163).
 */
export const FLOWLOG_SECRET_DESCRIPTION = "Client secret for the AzureFlowLogs pack collector";

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

  // --- 1. Secret (create-or-update, ours only; ensureTextSecret, DBT-152) --
  // The body is the app-wide stamped one (DBT-163). A 409 updates only a
  // secret this app provably owns; a foreign or unreadable one is refused and
  // left unchanged, and a 400 is an error, never an overwrite. Either throws:
  // a secret the collector cannot use is a hard failure, so nothing commits.
  const secretValue = input.clientSecret ?? "";
  if (secretValue !== "") {
    const ensured = await ensureTextSecret(cribl, {
      groupId: input.groupId,
      id: FLOWLOG_SECRET_NAME,
      value: secretValue,
      description: FLOWLOG_SECRET_DESCRIPTION,
    });
    if (ensured.kind === "refused" || ensured.kind === "failed") {
      throw new Error(ensured.message);
    }
    outcome.secret = ensured.kind;
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
