/**
 * Entra ID tenant diagnostic setting - THE ARM REQUEST, and the precondition
 * this app cannot check.
 *
 * LOG-07 / backlog.md#6b. The legacy script already spoke raw ARM REST
 * (`Invoke-AzRestMethod`), so this ports close to one-to-one. Shapes mined from
 * `deprecated/Azure/Azure-LogCollection/core/Deploy-EntraIDDiagnostics.ps1`:
 *
 *   line 222  PUT https://management.azure.com/providers/microsoft.aadiam
 *             /diagnosticSettings/{name}?api-version=2017-04-01
 *   line 214  body is { properties: { eventHubAuthorizationRuleId,
 *             eventHubName, logs: [{ category, enabled }] } }
 *   line 50   the default setting name is `CriblEntraIDLogs`
 *   line 179  the same path without a name, GET, lists what exists
 *
 * IT IS TENANT-LEVEL, WHICH IS WHY THE PATH HAS NO SUBSCRIPTION IN IT. One
 * setting for the whole directory. That is also the root of the precondition
 * problem below.
 *
 * THE PRECONDITION THIS APP PROVABLY CANNOT MEASURE. Writing this setting needs
 * an ENTRA DIRECTORY ROLE - Security Administrator or Global Administrator.
 * The app's permission preflight evaluates AZURE RBAC, by asking
 * `GET {scope}/providers/Microsoft.Authorization/permissions` and reading the
 * effective actions (see `domain/azure-permissions`). Entra directory roles are
 * a different system: they are not role assignments at any ARM scope, they
 * never appear in that response, and no scope exists that would make them
 * appear. This is not a gap in the evaluator's coverage that a new capability
 * entry would close - it is outside what the endpoint can express.
 *
 * So {@link ENTRA_DIRECTORY_PRECONDITION} is modelled as UNMEASURABLE rather
 * than as unmeasured, and the two must not be conflated. "Unmeasured" invites
 * someone to add a probe; "unmeasurable by this evaluator" tells them where to
 * look instead - Microsoft Graph, via the `GraphDirectory` port, which today
 * only lists service principals. Reporting this as a normal unchecked
 * capability would be the confident-wrong-answer shape backlog item 4 is about:
 * a preflight that returns green for a thing it never examined.
 *
 * The honest UI consequence, and the reason this is a finding worth surfacing
 * early rather than at integration time: the deploy cannot be gated on a
 * measured capability here. It states the requirement, attempts the PUT, and
 * reports the authorization failure faithfully if it comes.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto. The caller
 * performs the request.
 */

import type { EntraCategoryName } from "./entra-categories";
import { ENTRA_CATEGORIES } from "./entra-categories";

/** api-version the legacy script pinned. The provider offers no newer stable one. */
export const AADIAM_API_VERSION = "2017-04-01";

/** Default diagnostic-setting name, verbatim from the script's parameter default. */
export const DEFAULT_SETTING_NAME = "CriblEntraIDLogs";

/** One entry of the ARM `logs` array. */
export interface DiagnosticLogEntry {
  readonly category: EntraCategoryName;
  readonly enabled: boolean;
}

/** The ARM request this module builds. The caller performs it. */
export interface EntraDiagnosticRequest {
  readonly method: "PUT";
  readonly url: string;
  readonly body: {
    readonly properties: {
      readonly eventHubAuthorizationRuleId: string;
      readonly eventHubName: string;
      readonly logs: readonly DiagnosticLogEntry[];
    };
  };
}

export interface EntraDiagnosticInput {
  /** Full resource id of the namespace authorization rule. */
  readonly eventHubAuthorizationRuleId: string;
  readonly eventHubName: string;
  /** The ticked categories. */
  readonly categories: readonly EntraCategoryName[];
  /** Defaults to {@link DEFAULT_SETTING_NAME}. */
  readonly settingName?: string;
}

/**
 * A precondition the app states but cannot verify.
 *
 * `measurable: false` is the load-bearing field. See the module docblock: this
 * is outside what the ARM permissions endpoint can express, not merely
 * something nobody has probed yet.
 */
export interface UnmeasurablePrecondition {
  readonly requirement: string;
  readonly measurable: false;
  /** Why it cannot be measured, in terms a reader can check. */
  readonly reason: string;
  /** Where it COULD be measured from, so this reads as a pointer not a shrug. */
  readonly wouldNeed: string;
}

export const ENTRA_DIRECTORY_PRECONDITION: UnmeasurablePrecondition = {
  requirement:
    "An Entra directory role - Security Administrator or Global Administrator - on the signed-in identity.",
  measurable: false,
  reason:
    "The permission preflight reads Azure RBAC effective actions from Microsoft.Authorization/permissions at an ARM scope. Entra directory roles are not ARM role assignments, appear in no scope's response, and cannot be derived from one.",
  wouldNeed:
    "Microsoft Graph (the GraphDirectory port), which today lists service principals only.",
};

/** The tenant-level path. No subscription: the setting is directory-wide. */
function settingUrl(name: string): string {
  return (
    "https://management.azure.com/providers/microsoft.aadiam/diagnosticSettings/" +
    `${encodeURIComponent(name)}?api-version=${AADIAM_API_VERSION}`
  );
}

/** The GET that lists what already exists, from script line 179. */
export function listSettingsUrl(): string {
  return `https://management.azure.com/providers/microsoft.aadiam/diagnosticSettings?api-version=${AADIAM_API_VERSION}`;
}

/**
 * Build the PUT.
 *
 * EVERY category is sent, with `enabled` reflecting the selection, rather than
 * sending only the ticked ones. The setting is a full replacement: a category
 * omitted from `logs` keeps whatever it had, so a PUT carrying only the ticked
 * categories cannot turn anything OFF, and a category the operator unticked
 * would silently keep flowing while the UI showed it as off.
 *
 * That is a genuine tension with AZR-1's additive-only contract and it resolves
 * cleanly, because the two are about different things. The contract governs
 * what a CHECKBOX may destroy - it must never tear down a deployed resource.
 * Sending `enabled: false` for an unticked category does not tear anything
 * down; it writes the operator's stated intent into the one setting that
 * already exists. What the contract forbids is the diagnostic setting itself
 * being deleted by a selection change, and nothing here deletes it.
 *
 * @throws never - an unknown category name is dropped, since it cannot be
 *         expressed to ARM anyway and throwing would take the whole PUT down
 *         over one stale entry.
 */
export function buildEntraDiagnosticRequest(
  input: EntraDiagnosticInput,
): EntraDiagnosticRequest {
  const ticked = new Set(input.categories);
  const logs: DiagnosticLogEntry[] = ENTRA_CATEGORIES.map((c) => ({
    category: c.name,
    enabled: ticked.has(c.name),
  }));

  return {
    method: "PUT",
    url: settingUrl(input.settingName ?? DEFAULT_SETTING_NAME),
    body: {
      properties: {
        eventHubAuthorizationRuleId: input.eventHubAuthorizationRuleId,
        eventHubName: input.eventHubName,
        logs,
      },
    },
  };
}
