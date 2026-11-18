/**
 * input-pause (AZR-105): PAUSE (or resume) the Cribl source the onboarding
 * screen created, by setting its `disabled` through the kit's
 * read-modify-write, then committing and deploying. What Pause means per
 * object type is decided in domain/onboarding-teardown: only the input has a
 * switch; nothing downstream of it carries data while it is stopped.
 *
 * PATCH /system/inputs/{id} REPLACES the source whole (the bundled spec: "This
 * endpoint does not support partial updates. Cribl removes any omitted fields
 * when updating the Source"), so the kit sends the whole object read back,
 * with `disabled` changed and every other key round-tripped.
 *
 * PLAN (GETs only): GET /system/inputs (prove the input ours), the kit's
 * planChange on /system/inputs/<id> (the diff the confirm shows), GET
 * /version/status (the commit scope over local/cribl/inputs.yml).
 *
 * APPLY: GET /version/status (grew -> void), GET /system/inputs (still
 * provably ours, not already in the asked state), the kit's writeApproved
 * (re-read, diff compare, a synchronous check that the stamp is still there,
 * PATCH), verifyStored, then commitAndDeploy. Anything but stored is never
 * committed. Never throws for an HTTP answer.
 *
 * What a paused Event Hubs source does to the hub's data is NOT MEASURED:
 * Cribl's consumer stops reading; Event Hubs keeps events for the hub's
 * retention period, and resuming in the same consumer group is expected to
 * continue from the last committed offset (inferred from Kafka consumer-group
 * semantics, not measured here). A pause longer than the retention loses the
 * events in between.
 */

import { classifyInputForPause, type PauseVerdict } from "../../domain/onboarding-teardown/teardown-plan";
import type { CriblSourceRecord } from "../../domain/onboarding-howto/progress-document";
import { APP_ID } from "../../domain/cribl-secrets/secret-body";
import { stampFor } from "../../kit/config-writes/ownership";
import {
  commitAndDeploy,
  commitScope,
  commitScopeGrew,
  observeCommitDeploy,
  pendingFiles,
  type CommitScope,
} from "../../kit/config-writes/commitDeploy";
import { planChange, verifyStored, writeApproved, type DiffRow, type WriteTarget } from "../../kit/config-writes/readModifyWrite";
import { isOk, type ApiResponse, type Request } from "../../kit/config-writes/transport";
import { commitDeployTimeouts, criblRequestFor } from "../../kit/cribl-request";
import type { CriblClient } from "../../ports/cribl-client";
import { TEARDOWN_COMMIT_TIMEOUT_MS, TEARDOWN_LOG_PREFIX, teardownCommitDetail, type TeardownPorts } from "./onboarding-teardown";

/** The one file a pause dirties, relative to the group (as the create path's marker; not measured). */
export const PAUSE_COMMIT_MARKERS: readonly string[] = ["local/cribl/inputs.yml"];

function groupRequest(cribl: CriblClient, groupId: string): Request {
  return criblRequestFor(cribl, groupId, { timeoutMsFor: commitDeployTimeouts(TEARDOWN_COMMIT_TIMEOUT_MS) });
}

/** The kit target for one input. The change names no array, so none is declared. */
function inputTarget(inputId: string): WriteTarget {
  return { path: `/system/inputs/${encodeURIComponent(inputId)}`, method: "PATCH" };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}

async function readInputs(request: Request): Promise<{ state: "read"; items: readonly unknown[] } | { state: "refused"; status: number; detail: string }> {
  let r: ApiResponse;
  try {
    r = await request("GET", "/system/inputs");
  } catch (error) {
    return { state: "refused", status: 0, detail: `the sources list: no response (${errorText(error)})` };
  }
  if (!isOk(r.status)) return { state: "refused", status: r.status, detail: `the sources list: HTTP ${r.status}` };
  const items = (r.body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return { state: "refused", status: r.status, detail: "the sources list answered without an items array" };
  return { state: "read", items };
}

async function readScope(request: Request, groupId: string): Promise<CommitScope | string> {
  let pending: string[] | null;
  try {
    pending = await pendingFiles(request);
  } catch {
    pending = null;
  }
  if (pending === null) return "Cribl's pending-change status could not be read, so what the commit would carry is unknown. Nothing was changed.";
  const scope = commitScope(pending, groupId, PAUSE_COMMIT_MARKERS);
  if (scope.unplaced.length > 0) {
    return `Pending changes could not be placed in a worker group (${scope.unplaced.join(", ")}). Nothing was changed; commit or discard them in Cribl first.`;
  }
  return scope;
}

export interface PlanPauseInput {
  readonly record: CriblSourceRecord;
  /** true = pause (disabled), false = resume. */
  readonly pause: boolean;
}

export interface ReadyPause {
  readonly record: CriblSourceRecord;
  readonly pause: boolean;
  readonly diff: readonly DiffRow[];
  readonly scope: CommitScope;
  readonly commitFiles: readonly string[];
}

export type PlanPauseResult =
  | { readonly kind: "ready"; readonly ready: ReadyPause }
  | { readonly kind: "already"; readonly detail: string }
  | { readonly kind: "refused"; readonly detail: string; readonly denied?: true };

function verdictRefusal(v: Exclude<PauseVerdict, { kind: "ready" } | { kind: "already" }>, inputId: string): PlanPauseResult {
  switch (v.kind) {
    case "absent":
      return { kind: "refused", detail: `Cribl source ${inputId} is not in the worker group's sources. Nothing was changed.` };
    case "not-proven":
      return { kind: "refused", detail: v.detail };
    case "unreadable":
      return { kind: "refused", detail: v.detail, ...(v.denied === true ? { denied: true as const } : {}) };
  }
}

function stateWord(pause: boolean): string {
  return pause ? "paused" : "running";
}

/** PLAN: read-only. Never writes, never throws for an HTTP answer. */
export async function planInputPause(ports: TeardownPorts, input: PlanPauseInput): Promise<PlanPauseResult> {
  const { record, pause } = input;
  const request = groupRequest(ports.cribl, record.groupId);
  const verdict = classifyInputForPause(await readInputs(request), record, pause);
  if (verdict.kind === "already") return { kind: "already", detail: `Cribl source ${record.inputId} is already ${stateWord(pause)}. Nothing to change.` };
  if (verdict.kind !== "ready") return verdictRefusal(verdict, record.inputId);
  let plan;
  try {
    plan = await planChange(request, inputTarget(record.inputId), { disabled: pause });
  } catch (error) {
    return { kind: "refused", detail: `Cribl source ${record.inputId} could not be read (${errorText(error)}). Nothing was changed.` };
  }
  if (plan.kind === "unreadable") {
    const denied = plan.response.status === 401 || plan.response.status === 403;
    return { kind: "refused", detail: `Cribl source ${record.inputId} could not be read (HTTP ${plan.response.status}). Nothing was changed.`, ...(denied ? { denied: true as const } : {}) };
  }
  if (plan.kind === "nothing-to-do") return { kind: "already", detail: `Cribl source ${record.inputId} is already ${stateWord(pause)}. Nothing to change.` };
  const scope = await readScope(request, record.groupId);
  if (typeof scope === "string") return { kind: "refused", detail: scope };
  return {
    kind: "ready",
    ready: {
      record,
      pause,
      diff: plan.diff,
      scope,
      commitFiles: PAUSE_COMMIT_MARKERS.map((m) => `groups/${record.groupId}/${m}`),
    },
  };
}

export type ApplyPauseOutcome =
  | { readonly kind: "deployed"; readonly detail: string }
  | { readonly kind: "void"; readonly detail: string }
  | { readonly kind: "refused"; readonly detail: string; readonly denied?: true }
  /** The PATCH went through; the commit or deploy did not (or the read-back did not confirm it). */
  | { readonly kind: "written-not-deployed"; readonly detail: string };

/** APPLY: only after the operator confirmed `ready`. Never throws for an HTTP answer. */
export async function applyInputPause(ports: TeardownPorts, ready: ReadyPause): Promise<ApplyPauseOutcome> {
  const { record, pause } = ready;
  const grouped = groupRequest(ports.cribl, record.groupId);
  const request = ports.onCommitStep ? observeCommitDeploy(grouped, ports.onCommitStep) : grouped;
  const log = { groupId: record.groupId, inputId: record.inputId, pause };
  const end = (o: ApplyPauseOutcome): ApplyPauseOutcome => {
    if (o.kind === "deployed") ports.logger?.info(`${TEARDOWN_LOG_PREFIX} pause deployed`, log);
    else ports.logger?.warn(`${TEARDOWN_LOG_PREFIX} pause ${o.kind}`, log);
    return o;
  };

  // The commit scope the confirm named must not have grown.
  const scope = await readScope(request, record.groupId);
  if (typeof scope === "string") return end({ kind: "refused", detail: scope });
  if (commitScopeGrew(ready.scope, scope)) {
    return end({ kind: "void", detail: `Since the confirm, more uncommitted work appeared in ${scope.alreadyDirty.join(", ") || "the sources file"}. Nothing was changed; check again.` });
  }

  // Still provably ours, and not already in the asked state.
  const verdict = classifyInputForPause(await readInputs(request), record, pause);
  if (verdict.kind === "already") return end({ kind: "void", detail: `Cribl source ${record.inputId} is already ${stateWord(pause)}. Nothing was changed.` });
  if (verdict.kind !== "ready") {
    const r = verdictRefusal(verdict, record.inputId);
    return end(r.kind === "refused" ? { kind: "refused", detail: r.detail, ...(r.denied === true ? { denied: true as const } : {}) } : { kind: "refused", detail: "Nothing was changed." });
  }

  const target = inputTarget(record.inputId);
  const stamp = stampFor(APP_ID);
  let written;
  try {
    written = await writeApproved(request, target, { disabled: pause }, ready.diff, undefined, (fresh) =>
      typeof fresh["description"] === "string" && fresh["description"].includes(stamp)
        ? null
        : `Cribl source ${record.inputId} no longer carries this app's stamp, so it was not changed.`,
    );
  } catch (error) {
    return end({ kind: "refused", detail: `The change to Cribl source ${record.inputId} got no answer (${errorText(error)}); whether it applied is unknown. Check it in Cribl.` });
  }
  switch (written.kind) {
    case "void":
      return end({ kind: "void", detail: `Cribl source ${record.inputId} changed since the confirm. Nothing was changed; check again.` });
    case "already-applied":
      return end({ kind: "void", detail: `Cribl source ${record.inputId} is already ${stateWord(pause)}. Nothing was changed.` });
    case "refused-before-write":
      return end({ kind: "refused", detail: written.reason });
    case "unreadable":
    case "refused": {
      const status = written.response.status;
      const denied = status === 401 || status === 403;
      return end({
        kind: "refused",
        detail: denied
          ? `Cribl refused the change to source ${record.inputId} (HTTP ${status}): this account may lack the permission. Nothing was changed.`
          : `The change to Cribl source ${record.inputId} did not go through (HTTP ${status}). Nothing was changed.`,
        ...(denied ? { denied: true as const } : {}),
      });
    }
    case "written":
      break;
  }

  const stored = await verifyStored(request, target, { disabled: pause });
  if (stored.kind !== "stored") {
    return end({
      kind: "written-not-deployed",
      detail: `Cribl source ${record.inputId} was changed, but the read-back did not confirm it (${stored.kind}). Nothing was committed; check it in Cribl.`,
    });
  }
  try {
    const outcome = await commitAndDeploy(request, {
      group: record.groupId,
      markers: PAUSE_COMMIT_MARKERS,
      message: `${TEARDOWN_LOG_PREFIX}: ${pause ? "pause" : "resume"} Cribl source ${record.inputId}`,
    });
    const detail = teardownCommitDetail(outcome, record.groupId, "The change was");
    if (outcome.kind === "deployed") {
      return end({ kind: "deployed", detail: `Cribl source ${record.inputId} is ${stateWord(pause)}. ${detail}` });
    }
    return end({ kind: "written-not-deployed", detail: `Cribl source ${record.inputId} was set ${stateWord(pause)}, but it is not deployed: ${detail}` });
  } catch (error) {
    return end({
      kind: "written-not-deployed",
      detail: `Cribl source ${record.inputId} was changed, but a call in the commit and deploy sequence got no answer (${errorText(error)}); check the group's pending changes in Cribl.`,
    });
  }
}
