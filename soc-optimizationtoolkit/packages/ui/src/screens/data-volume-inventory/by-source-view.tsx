/**
 * BySourceView (MIG-30) - the inventory folded by source instead of by table:
 * which products and machines send data, which tables they land in, and how
 * much of it is billed. The fold is core's `bySource`; this only renders it.
 *
 * Every figure's lens is named in a header InfoTip (the rows' _BilledSize, or
 * the Usage table for a table whose sources were not read). Unknowns follow
 * docs/inventory-standard.md: a verified empty listing and an unverified one
 * say different things and neither is counted, and a not-read table keeps its
 * Usage volume with its split reading "not read", never zero.
 */

import { useMemo } from "react";
import { allowanceFor, bySource } from "@soc/core";
import type { InventoryTable, Listing, SourceViewRow } from "@soc/core";
import { InfoTip } from "../../components/info-tip";
import { tagLabel } from "./allowance-state";
import { formatMB } from "./format-mb";
import {
  BILLED_EXCEEDS_TIP,
  BY_SOURCE_ALLOWANCE_TIP,
  BY_SOURCE_COLLECTORS_TIP,
  BY_SOURCE_DAILY_TIP,
  BY_SOURCE_PARTIAL_TIP,
  BY_SOURCE_RECONCILE_TIP,
  BY_SOURCE_SOURCE_TIP,
  BY_SOURCE_SPLIT_TIP,
  bySourceFreeText,
  bySourceReconciliationText,
  catalogBillableFlagText,
  catalogFlagText,
  collectorDisplay,
} from "./workspace-inventory-state";

export interface BySourceViewProps {
  inventory: { tables: Listing<InventoryTable> };
}

export function BySourceView({ inventory }: BySourceViewProps) {
  const { rows, reconciliation } = useMemo(() => bySource(inventory), [inventory]);

  if (rows.kind === "none") {
    return (
      <p className="panel-desc">
        Usage billed nothing in the last 30 complete days, so no table has sources to list.
      </p>
    );
  }
  if (rows.kind === "empty") {
    return (
      <p className="panel-desc">
        The Usage answer was incomplete or unreadable, so which sources send data could not
        be confirmed. This is not a measured zero.
      </p>
    );
  }

  return (
    <>
      <div className="siem-inventory-table-wrap">
        <table className="siem-inventory-table">
          <thead>
            <tr>
              <th>
                Source <InfoTip text={BY_SOURCE_SOURCE_TIP} />
              </th>
              <th>Lands in</th>
              <th>
                Daily avg <InfoTip text={BY_SOURCE_DAILY_TIP} />
              </th>
              <th>
                Billed / Free <InfoTip text={BY_SOURCE_SPLIT_TIP} />
              </th>
              <th>
                Collectors <InfoTip text={BY_SOURCE_COLLECTORS_TIP} />
              </th>
              <th>
                Allowance <InfoTip text={BY_SOURCE_ALLOWANCE_TIP} />
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.rows.map((row) => (
              <SourceRow key={row.key} row={row} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="field-hint">
        {bySourceReconciliationText(reconciliation)} <InfoTip text={BY_SOURCE_RECONCILE_TIP} />
      </p>
    </>
  );
}

function SourceRow({ row }: { row: SourceViewRow }) {
  const flag = catalogFlagText(row.freeTaggedTablesBilled);
  const billableFlag = catalogBillableFlagText(row.billableTaggedTablesFree);
  return (
    <tr>
      <td>
        {row.label}
        {row.kind === "computer" && <div className="field-hint">Computer</div>}
        {row.partialTables.length > 0 && (
          <div className="field-hint">
            partial breakdown, a floor <InfoTip text={BY_SOURCE_PARTIAL_TIP} />
          </div>
        )}
      </td>
      <td>
        {row.tables.map((t) => (
          <div key={t}>
            <code className="code-chip">{t}</code>
          </div>
        ))}
      </td>
      <td>{formatMB(row.dailyMB)}</td>
      <td>
        <SplitCell row={row} />
      </td>
      <td>
        <CollectorsCell row={row} />
      </td>
      <td>
        {row.tables.map((t) => (
          <div key={t}>
            {row.tables.length > 1 ? `${t}: ` : ""}
            {tagLabel(allowanceFor(t))}
          </div>
        ))}
        {flag !== null && <div className="match-warning">{flag}</div>}
        {billableFlag !== null && <div className="match-warning">{billableFlag}</div>}
      </td>
    </tr>
  );
}

/** Billed and free in words, with a two-segment bar when both are known. */
function SplitCell({ row }: { row: SourceViewRow }) {
  if (row.billedDailyMB === null) return <span className="field-hint">not read</span>;
  const billed = row.billedDailyMB;
  const free = row.freeDailyMB ?? 0;
  const words = `billed ${formatMB(billed)}, free ${bySourceFreeText(row)}`;
  return (
    <>
      {/* No bar when the free figure is not known, or when there is nothing to divide. */}
      {!row.billedExceedsTotal && billed + free > 0 && (
        <div className="by-source-split-bar" aria-hidden="true">
          {billed > 0 && <span className="by-source-split-billed" style={{ flexGrow: billed }} />}
          {free > 0 && <span className="by-source-split-free" style={{ flexGrow: free }} />}
        </div>
      )}
      <div>{words}</div>
      {row.billedExceedsTotal && (
        <div className="field-hint">
          billed figure exceeds total - see tip <InfoTip text={BILLED_EXCEEDS_TIP} />
        </div>
      )}
    </>
  );
}

function CollectorsCell({ row }: { row: SourceViewRow }) {
  if (row.kind !== "product") return <span>-</span>;
  if (row.collectors.length === 0) return <span className="field-hint">none named</span>;
  const n = row.collectors.length;
  return (
    <details className="gap-handles">
      <summary>{`${n} ${n === 1 ? "collector" : "collectors"}`}</summary>
      <div className="gap-handles-body">
        {row.collectors.map((c) => (
          <div key={c.name}>{`${collectorDisplay(c.name)} - ${formatMB(c.dailyMB)}/day`}</div>
        ))}
      </div>
    </details>
  );
}
