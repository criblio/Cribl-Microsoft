/**
 * Renders the monospace outcome summary for an onboard-table run. Shared by
 * the live screen and the persisted-run history so both surfaces answer the
 * "what was created, and where" questions identically.
 */

import type { OnboardTableOutcome } from "@soc/core";

/** Build the monospace summary block for a successful run. */
export function summaryText(outcome: OnboardTableOutcome): string {
  const commitLine =
    outcome.commitVersion !== null
      ? `${outcome.commitVersion} (deployed)`
      : "not deployed - commit and deploy manually in Cribl (see the commit-and-deploy step above)";
  return [
    `DCR name:            ${outcome.dcrName}`,
    `DCR immutable id:    ${outcome.dcrImmutableId}`,
    `Resource group:      ${outcome.resourceGroup} (subscription ${outcome.subscriptionId})`,
    `Workspace:           ${outcome.workspaceName}`,
    `Ingestion endpoint:  ${outcome.logsIngestionEndpoint}`,
    `Stream name:         ${outcome.streamName}`,
    `Destination id:      ${outcome.destinationId}`,
    `Worker group:        ${outcome.groupId}`,
    `Cribl commit:        ${commitLine}`,
  ].join("\n");
}
