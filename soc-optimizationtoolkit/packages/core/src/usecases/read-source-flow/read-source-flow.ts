/**
 * read-source-flow (AZR-33, ADR 0007 D15): the ONE Cribl metrics read a
 * live-flow poll run makes for the onboarding diagram.
 *
 * It calls the adopted kit's queryMetrics through criblRequestFor, so the
 * request is exactly one POST to '/m/<g>/system/metrics/query', which the
 * adapter maps to {groupId: g, path: '/system/metrics/query'}. The body is
 * domain/onboarding-flow's flowQuery(kind): total.in_events split by input.
 *
 * NEVER THROWS. Every outcome is a FlowAnswer the lane classifier can tell
 * apart (claude-kit standards/cribl-metrics.md, inventory-honesty.md):
 *  - rows / empty            - the kit's parse of a {results: [...]} answer;
 *  - refused {status}        - a 401 or 403, so the lane reads "no permission",
 *                              never zero;
 *  - error unexpected-shape  - a 2xx that is not {results: [...]}, e.g. the
 *                              {items: [...]} envelope other collections use;
 *  - error http              - any other non-2xx;
 *  - failed                  - a transport rejection, an abort, or no worker
 *                              group (nothing is sent then).
 *
 * Provenance: the request and response shapes are Documented (kit
 * metricsQuery.ts header), NOT measured live; ADR 0007's live-verification
 * list carries the first real answer.
 *
 * Pure orchestration over the CriblClient port: no clock, no timers.
 */

import type { CriblClient } from "../../ports/cribl-client";
import { criblRequestFor } from "../../kit/cribl-request";
import { queryMetrics } from "../../kit/metrics/metricsQuery";
import { flowQuery, type FlowQueryKind } from "../../domain/onboarding-flow/flow-query";
import type { FlowAnswer } from "../../domain/onboarding-flow/flow-state";

/** The detail a failed answer carries when there is no worker group to ask. */
export const NO_GROUP_DETAIL = "no worker group selected; nothing was sent";

function errorDetail(err: unknown): string {
  if (err instanceof Error) {
    return err.name === "AbortError" ? "cancelled" : err.message || err.name;
  }
  return String(err);
}

/** Read one live-flow metrics query. One request; never throws. */
export async function readSourceFlow(
  cribl: CriblClient,
  groupId: string,
  kind: FlowQueryKind,
  signal?: AbortSignal,
): Promise<FlowAnswer> {
  if (!groupId) return { kind: "failed", detail: NO_GROUP_DETAIL };
  try {
    const answer = await queryMetrics(criblRequestFor(cribl, groupId), groupId, flowQuery(kind), signal);
    if (answer.kind === "error" && answer.reason === "http" && (answer.status === 401 || answer.status === 403)) {
      return { kind: "refused", status: answer.status, detail: answer.detail };
    }
    if (answer.kind === "error" && answer.status === 0) {
      // criblRequestFor's own refusal (no-group / bad-path): nothing reached Cribl.
      return { kind: "failed", detail: answer.detail };
    }
    return answer;
  } catch (err) {
    return { kind: "failed", detail: errorDetail(err) };
  }
}
