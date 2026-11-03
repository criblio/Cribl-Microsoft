/**
 * AllowanceCards (MIG-15) - one card per Microsoft data grant present in the
 * inventoried workspace (E5, Defender for Servers P2): granted, eligible, used,
 * a meter and either the overage or the headroom, each opening a drill-down
 * with the counts, arithmetic, chart, eligible tables, cross-check and the
 * exact queries behind it (spec: docs/features/inventory-data-allowances.md).
 *
 * Honesty (docs/inventory-standard.md): every unknown renders as "not read" or
 * "not known" with its reason, never as 0, and every gap the read reported is
 * shown. In a tenant comparison (MIG-16) every workspace that was not read is
 * listed by name as "not read", and the sums read "at least". Also exports
 * the table's Allowance cell and the allowance queries for the panel's
 * "Queries that produced these numbers".
 */

import type { ReactNode } from "react";
import { allowanceFor } from "@soc/core";
import type { DataAllowances, GrantView } from "@soc/core";
import { InfoTip } from "../../components/info-tip";
import { EligibleAppliedChart } from "./allowance-chart";
import {
  ALLOWANCE_TIPS,
  arithmeticLine,
  basisFigures,
  criblWritableNote,
  crossCheckLine,
  mbPerDay,
  grantCardText,
  grantedUnknownReason,
  licenceNote,
  countText,
  meterOf,
  noGrantsText,
  otherBasisNote,
  planLabel,
  planNote,
  rerouteWarning,
  tagLabel,
  tagRule,
} from "./allowance-state";
import { formatMB } from "./format-mb";
import { workspaceNameOf } from "./workspace-inventory-state";

export interface AllowanceCardsProps {
  allowances: DataAllowances;
  /** ISO time the allowances were read. */
  readAt: string;
  /** Room for an action beside the cards: the tenant comparison, or the way back from it. */
  actions?: ReactNode;
}

/** Only the E5 grant is tenant-wide; Servers P2 is granted per workspace (MIG-19). */
function sharedLabel(view: GrantView, a: DataAllowances): string | null {
  if (view.grant !== "e5" || a.scope.kind !== "workspace") return null;
  const n = a.scope.sentinelWorkspaces;
  if (n === null) return "Tenant-wide; how many Sentinel workspaces share it is not known.";
  // Incomplete discovery: the count is what was seen, and there may be more.
  if (a.scope.sentinelWorkspacesAtLeast) return `Tenant-wide, shared across at least ${n} Sentinel workspaces.`;
  return n > 1 ? `Tenant-wide, shared across ${n} Sentinel workspaces.` : null;
}

export function AllowanceCards({ allowances: a, readAt, actions }: AllowanceCardsProps) {
  const tenant = a.scope.kind === "tenant" ? a.scope : null;
  return (
    <div className="allowance-cards">
      {tenant !== null && (
        <p className="panel-desc">
          Compared across {tenant.workspaces.length} Sentinel workspaces,{" "}
          {tenant.workspaces.length - tenant.notRead.length} read.
        </p>
      )}
      {a.attribution === "pooled" ? (
        <PooledSummary a={a} />
      ) : a.grants.length === 0 ? (
        <p className="panel-desc">{noGrantsText(a)}</p>
      ) : (
        <div className="allowance-card-grid">
          {a.grants.map((g) => (
            <GrantCard key={g.grant} view={g} a={a} readAt={readAt} />
          ))}
        </div>
      )}
      {tenant !== null && tenant.notRead.length > 0 && (
        <div className="match-warning">
          {tenant.notRead.length} workspace(s) not read, so every sum is a floor:
          {tenant.notRead.map((w) => (
            <div key={w.id} className="allowance-not-read" title={w.id}>
              {workspaceNameOf(w.id)}: not read - {w.error}
            </div>
          ))}
        </div>
      )}
      {a.gaps.map((gap, i) => (
        <p key={`${i}-${gap}`} className="match-warning">
          {gap}
        </p>
      ))}
      {actions !== undefined && <div className="panel-controls">{actions}</div>}
    </div>
  );
}

function PooledSummary({ a }: { a: DataAllowances }) {
  const p = a.pooled;
  const floors = a.sumsAreFloors ? "at least " : "";
  const usedFloors = a.sumsAreFloors || a.usedIsFloor ? "at least " : "";
  // Core's own flag, not a fold over grants: a failed eligible read can leave
  // grants empty, and every() over [] would claim the eligible sum is known.
  const eligibleKnown = a.eligibleKnown;
  const reason = a.grants.find((g) => g.crossCheck.kind === "skipped")?.crossCheck;
  return (
    <div className="allowance-card">
      <div className="allowance-card-title">Benefit applied, all grants together</div>
      {p === null ? (
        <div className="allowance-card-line">The combined benefit is not known.</div>
      ) : (
        <>
          <div className="allowance-card-line">
            eligible{" "}
            {eligibleKnown ? `${floors}${mbPerDay(p.eligibleDailyMB)}` : "not read"},
            applied {usedFloors}
            {mbPerDay(p.usedDailyMB)} <InfoTip text={ALLOWANCE_TIPS.eligibleUsed} />
          </div>
          <div className="allowance-card-status">
            {!eligibleKnown
              ? "over: not read (eligible volume not read)"
              : a.usedIsFloor
                ? "over: not known (partial benefit read)"
                : `${floors}${mbPerDay(p.overDailyMB)} over, all grants together`}
          </div>
        </>
      )}
      <p className="field-hint">
        Microsoft's benefit record could not be split by grant, so no per-grant meter or overage is
        drawn.
      </p>
      {reason !== undefined && <p className="field-hint">{crossCheckLine(reason)}</p>}
      {p !== null && (
        <EligibleAppliedChart eligibleByDay={p.eligibleByDay} usedByDay={p.usedByDay} eligibleKnown={eligibleKnown} />
      )}
      {a.grants.map((g) => (
        <details key={g.grant} className="gap-handles">
          <summary>{tagLabel({ kind: "grant", grant: g.grant, condition: null })}: eligible tables</summary>
          <div className="gap-handles-body">
            <EligibleTables view={g} />
          </div>
        </details>
      ))}
    </div>
  );
}

function GrantCard({ view, a, readAt }: { view: GrantView; a: DataAllowances; readAt: string }) {
  const text = grantCardText(view, a);
  const meter = meterOf(view, a);
  const over = view.eligibleKnown && !a.usedIsFloor && view.usage.overDailyMB > 0;
  const shared = sharedLabel(view, a);
  return (
    <div className="allowance-card">
      <div className="allowance-card-title">{text.title}</div>
      <div className="allowance-card-line">
        granted {text.granted}{" "}
        <InfoTip text={view.grant === "e5" ? ALLOWANCE_TIPS.grantedE5 : ALLOWANCE_TIPS.grantedServers} />
      </div>
      <div className="allowance-card-line">
        {text.eligibleUsed} <InfoTip text={ALLOWANCE_TIPS.eligibleUsed} />
      </div>
      {meter !== null && (
        <div
          className="allowance-meter"
          role="img"
          aria-label={`Eligible ${mbPerDay(view.usage.eligibleDailyMB)} against granted ${text.granted}`}
        >
          <div
            className={over ? "allowance-meter-fill allowance-meter-fill-over" : "allowance-meter-fill"}
            style={{ width: `${meter.eligiblePct}%` }}
          />
          <div className="allowance-meter-marker" style={{ left: `${meter.grantedPct}%` }} />
        </div>
      )}
      <div className={over ? "allowance-card-status allowance-card-status-over" : "allowance-card-status"}>
        {text.status} <InfoTip text={ALLOWANCE_TIPS.status} />
      </div>
      {shared !== null && <div className="field-hint">{shared}</div>}
      <details className="gap-handles">
        <summary>How these numbers were obtained</summary>
        <div className="allowance-detail">
          <div className="field-hint">Read {readAt}.</div>
          <h4 className="allowance-detail-heading">Granted</h4>
          {view.grant === "e5" ? <E5Granted view={view} a={a} /> : <ServersGranted view={view} a={a} />}
          {basisFigures(view, a).map((f) => (
            <div key={f.basis} className="allowance-arithmetic">
              {arithmeticLine(f)}
            </div>
          ))}
          {otherBasisNote(view, a) !== null && <p className="field-hint">{otherBasisNote(view, a)}</p>}

          <h4 className="allowance-detail-heading">
            Used <InfoTip text={ALLOWANCE_TIPS.chart} />
          </h4>
          <EligibleAppliedChart
            eligibleByDay={view.usage.eligibleByDay}
            usedByDay={view.usage.usedByDay}
            eligibleKnown={view.eligibleKnown}
          />

          <h4 className="allowance-detail-heading">Eligible</h4>
          <EligibleTables view={view} />

          <h4 className="allowance-detail-heading">Cross-check</h4>
          <p className="field-hint">{crossCheckLine(view.crossCheck)}</p>
          {view.grant === "e5" && a.licences.kind === "read" && (
            <p className="field-hint">Seat counts as of {a.licences.readAt}, compared with the last 30 days.</p>
          )}

          <h4 className="allowance-detail-heading">Queries and calls</h4>
          <pre className="siem-inventory-query">{a.queries.benefit}</pre>
          <pre className="siem-inventory-query">{a.queries.eligible}</pre>
          {view.grant === "e5" ? (
            <pre className="siem-inventory-query">{a.queries.graph}</pre>
          ) : (
            <>
              <pre className="siem-inventory-query">{a.queries.heartbeat}</pre>
              <pre className="siem-inventory-query">{a.queries.pricings}</pre>
              <pre className="siem-inventory-query">{a.queries.machines}</pre>
            </>
          )}
          {a.queries.tables !== null && <pre className="siem-inventory-query">GET {a.queries.tables}</pre>}
        </div>
      </details>
    </div>
  );
}

function E5Granted({ view, a }: { view: GrantView; a: DataAllowances }) {
  const note = licenceNote(a);
  if (a.licences.kind !== "read") {
    return (
      <>
        <p className="match-warning">{note}</p>
        {view.grantedMB !== null && (
          <p className="field-hint">
            Granted is shown as at least {mbPerDay(view.grantedMB)}: the largest benefit Microsoft
            applied on any day in the window. Headroom is not shown. Used and Over are unaffected.
          </p>
        )}
      </>
    );
  }
  const e5 = a.licences.e5;
  return (
    <>
      <p className="field-hint">Entitled if purchased through EA, EAS or CSP.</p>
      <div className="siem-inventory-table-wrap">
        <table className="siem-inventory-table">
          <thead>
            <tr>
              <th>
                SKU <InfoTip text={ALLOWANCE_TIPS.licences} />
              </th>
              <th>Purchased</th>
              <th>Grace / suspended</th>
              <th>Assigned</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {e5.rows.map((r) => (
              <tr key={r.skuId} className={r.qualifies ? undefined : "allowance-row-dim"}>
                <td>
                  <code className="code-chip">{r.skuPartNumber || r.skuId}</code>
                </td>
                <td>{r.enabled.toLocaleString("en-US")}</td>
                <td>
                  {r.warning.toLocaleString("en-US")} / {r.suspended.toLocaleString("en-US")}
                </td>
                <td>{r.consumed.toLocaleString("en-US")}</td>
                <td>{r.reason}</td>
              </tr>
            ))}
            <tr className="allowance-total-row">
              <td>Qualifying total</td>
              <td>{e5.purchased.toLocaleString("en-US")}</td>
              <td>
                {e5.inGrace.toLocaleString("en-US")} / {e5.suspended.toLocaleString("en-US")}
              </td>
              <td>{e5.assigned.toLocaleString("en-US")}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      {e5.possiblyMissing > 0 && (
        <p className="match-warning">
          {e5.possiblyMissing.toLocaleString("en-US")} assigned seat(s) are on SKUs that may qualify but
          are not in the matched list, so the granted figure may be higher.
        </p>
      )}
    </>
  );
}

function ServersGranted({ view, a }: { view: GrantView; a: DataAllowances }) {
  const rows = a.servers.rows;
  return (
    <>
      {view.grantedMB === null && (
        <p className="field-hint">Granted is not known: {grantedUnknownReason(view, a)}.</p>
      )}
      {rows.length > 0 && (
        <div className="siem-inventory-table-wrap">
          <table className="siem-inventory-table">
            <thead>
              <tr>
                <th>
                  Subscription <InfoTip text={ALLOWANCE_TIPS.servers} />
                </th>
                <th>Plan</th>
                <th>Machines in subscription</th>
                <th>Machines reporting here (daily average)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.subscriptionId} className={r.plan === "P2" ? undefined : "allowance-row-dim"}>
                  <td>
                    <code className="code-chip">{r.subscriptionId}</code>
                  </td>
                  <td>{planLabel(r.plan)}</td>
                  <td>{r.machinesInSubscription === null ? "not known" : r.machinesInSubscription.toLocaleString("en-US")}</td>
                  <td>{countText(r.machinesReportingHere)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {a.servers.unattributedMachines > 0 && (
        <p className="field-hint">
          {a.servers.unattributedMachines} machine(s) reported without a subscription id and are not
          counted in the granted figure.
        </p>
      )}
    </>
  );
}

function EligibleTables({ view }: { view: GrantView }) {
  if (!view.eligibleKnown) return <p className="field-hint">Eligible volume was not read.</p>;
  if (view.eligibleTables.length === 0) {
    return <p className="field-hint">No eligible table had billable volume in the window.</p>;
  }
  return (
    <>
      {view.eligibleTables.map((t) => {
        const notes = [planNote(t.plan), criblWritableNote(t.criblWritable)].filter((n) => n !== null);
        return (
          <div key={t.table}>
            <code className="code-chip">{t.table}</code> {formatMB(t.eligibleDailyMB)}/day
            {notes.length > 0 && <span className="field-hint"> - {notes.join("; ")}</span>}
          </div>
        );
      })}
    </>
  );
}

/** The table's Allowance cell: the tag, and a drill-down with its rule and the reroute warning. */
export function AllowanceTagCell({ table, a }: { table: string; a: DataAllowances | null }) {
  const tag = allowanceFor(table);
  if (tag.kind === "billable") return <span>{tagLabel(tag)}</span>;
  const view = tag.kind === "grant" ? a?.grants.find((g) => g.grant === tag.grant) : undefined;
  const eligible =
    view === undefined || !view.eligibleKnown
      ? null
      : (view.eligibleTables.find((t) => t.table.toLowerCase() === table.toLowerCase())?.eligibleDailyMB ?? 0);
  return (
    <details className="gap-handles">
      <summary>{tagLabel(tag)}</summary>
      <div className="gap-handles-body">
        <div>{tagRule(tag)}</div>
        {tag.kind === "grant" && <div>{rerouteWarning(table, eligible)}</div>}
      </div>
    </details>
  );
}

/** The allowance queries and calls, for the panel's "Queries that produced these numbers". */
export function AllowanceQueries({ a }: { a: DataAllowances }) {
  const q = a.queries;
  return (
    <>
      <pre className="siem-inventory-query">{q.benefit}</pre>
      <pre className="siem-inventory-query">{q.eligible}</pre>
      <pre className="siem-inventory-query">{q.heartbeat}</pre>
      <pre className="siem-inventory-query">{q.machines}</pre>
      <pre className="siem-inventory-query">{q.graph}</pre>
      <pre className="siem-inventory-query">{q.pricings}</pre>
      {q.tables !== null && <pre className="siem-inventory-query">GET {q.tables}</pre>}
    </>
  );
}
