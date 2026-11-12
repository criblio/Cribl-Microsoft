/**
 * StrandedSourcesNotice - the read-only report of Cribl source records an
 * earlier app version saved where this version no longer reads them (AZR-96).
 *
 * Before multi-tenant support the How-to progress lived under one unscoped KV
 * key. Once a tenant's own document exists, loadTenantDocument never reads that
 * key again, so a record a pre-upgrade bundle wrote there afterwards was
 * invisible: the screen said no Cribl source existed while the input did.
 *
 * REPORT, NEVER ADOPT. The records are named (input id and worker group) and
 * left where they are: nothing here merges them into the tenant's progress or
 * writes anything. A record with no claim is shown as "tenant unknown", never
 * as this tenant's. A legacy read that failed says "could not check" with the
 * reason - never silence, which would read as "nothing stranded".
 *
 * Pure view: strandedNoticeOf (stranded-sources-state.ts) decides, this renders.
 */

import { InfoTip } from "../../../components/info-tip";
import type { StrandedNotice } from "./stranded-sources-state";

const STRANDED_UNKNOWN_PREFIX =
  "Could not check for Cribl sources recorded by an earlier app version";

const STRANDED_TIP =
  "An earlier version of this app saved these Cribl source records in its old single-tenant store, after this " +
  "tenant's own progress already existed, so this version does not read them. They are shown here only: the app " +
  "has not adopted them, does not count them as created, and changes nothing. Check the input in Cribl Stream; if " +
  "it is yours, create the source again from this section or remove the old input in Cribl.";

const UNATTRIBUTED_TIP =
  "An earlier version of this app saved these Cribl source records in its old single-tenant store, and no tenant " +
  "ever claimed that store, so which Azure tenant they belong to is unknown - they may belong to another " +
  "connection. They are shown here only: the app has not adopted them and changes nothing.";

const UNKNOWN_TIP =
  "The old single-tenant store, or the record of which tenant owns it, could not be read. Cribl sources an earlier " +
  "app version recorded there may exist; this is not a statement that there are none.";

export function StrandedSourcesNotice({ notice }: { readonly notice: StrandedNotice | null }) {
  if (notice === null) return null;
  if (notice.kind === "unknown") {
    return (
      <p className="azure-onboarding-banner azure-onboarding-banner-warning" data-testid="azo-stranded-sources">
        {`${STRANDED_UNKNOWN_PREFIX}: ${notice.reason}.`} <InfoTip text={UNKNOWN_TIP} />
      </p>
    );
  }
  const unattributed = notice.attribution === "unattributed";
  return (
    <div className="azure-onboarding-banner azure-onboarding-banner-warning" data-testid="azo-stranded-sources">
      <p>
        {unattributed
          ? "Recorded by an earlier app version, tenant unknown, and not adopted:"
          : "Recorded by an earlier app version and not adopted:"}{" "}
        <InfoTip text={unattributed ? UNATTRIBUTED_TIP : STRANDED_TIP} />
      </p>
      <ul>
        {notice.records.map((r) => (
          <li key={`${r.sourceId}:${r.record.inputId}`}>
            {`${r.record.inputId} in worker group ${r.record.groupId}`}
          </li>
        ))}
      </ul>
    </div>
  );
}
