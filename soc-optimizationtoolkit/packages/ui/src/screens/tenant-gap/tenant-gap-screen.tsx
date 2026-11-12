/**
 * TenantGapScreen - the multi-tenant native logging gap dashboard (ADR 0009
 * decision 6): tenants (connection profiles) down, the Azure native logging
 * sources across, and two indicators per cell - configured in Azure, and
 * onboarded to Cribl - each green, red or unknown with its reason in its (i).
 *
 *   - MOUNT READS NOTHING. No Azure request, no tenant session, no KV load and
 *     no Cribl call: the grid shows the cached answers with their time, and
 *     "not read yet" everywhere else (pinned).
 *   - READS ONLY ON REQUEST, per tenant or every tenant in order, one at a
 *     time through the tenant session (the proxy has one credential slot), and
 *     every Azure request - the work's reads and the session's proof reads and
 *     token mints - inside ONE pacer per run: Validate's rate for the whole
 *     run, not per tenant, and the budget every screen shares. Cancel ends a
 *     wait for room at once and sends nothing more.
 *     Without a session or the shell's pacing the reads are disabled with the
 *     reason - nothing goes out unpaced.
 *   - ANSWERS ARE CACHED per tenant with their time, in a cache the shell
 *     owns, so coming back to the screen does not read again. A cancelled
 *     read never replaces an earlier complete answer. The read in flight is
 *     tracked there too, so a screen remounted mid-read waits for it instead
 *     of starting a second run that would collide with the first's lease.
 *   - The colours and words come from @soc/core (domain/tenant-gap); this file
 *     only lays them out.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { GAP_SOURCES, NOT_READ_REASON, createRequestPacer, scanTenantGap } from "@soc/core";
import type {
  BatchPacing,
  ExistingRead,
  GapIndicator,
  TenantGapProfile,
  TenantGapRow,
  TenantSession,
} from "@soc/core";
import { usePorts } from "../../ports-context";
import { InfoTip } from "../../components/info-tip";
import { VALIDATE_REQUESTS_PER_MINUTE } from "../azure-onboarding/validate/validate-state";
import {
  AZURE_WORD,
  CRIBL_WORD,
  progressLine,
  stateCounts,
  type ScanProgress,
  type TenantGapCache,
  type TenantGapEntry,
} from "./tenant-gap-state";

export interface TenantGapScreenProps {
  /** The connection profiles; one row each. */
  readonly profiles: readonly (TenantGapProfile & { readonly name: string })[];
  /** The shell's app-lifetime answer cache. */
  readonly cache: TenantGapCache;
  /** Reads one tenant at a time through the shared credential. Without it, reads are disabled. */
  readonly session?: TenantSession;
  /** The shell's clock, delay and shared budget. Without it, reads are disabled. */
  readonly pacing?: BatchPacing;
  /** Epoch ms for the "read at" stamp; Date.now by default. */
  readonly now?: () => number;
}

const PANEL_TIP =
  "One row per Azure connection, one column per Azure native logging source. In each cell, Azure says whether " +
  "that tenant's Azure side is set up as its onboarding plan says (read through that tenant's own connection), " +
  "and Cribl says whether this app created a Cribl source for it that Cribl still has. Green and red are " +
  "measured; unknown means a read was refused, not run, or not proven to be that tenant's. Hover or tap the (i) " +
  "beside each indicator for its reason.";

const READ_ALL_TIP =
  `Reads every tenant in turn, never two at once: each one's credential is put in the app's single Azure slot, ` +
  `proven to be that tenant's, used, and the active connection's put back. Azure reads go at most ` +
  `${VALIDATE_REQUESTS_PER_MINUTE} a minute for the whole run, counting each tenant's proof reads and sign-ins, ` +
  `inside the budget every screen shares. Nothing in Azure or Cribl ` +
  "is changed. Each tenant needs its client secret entered in this session.";

const AZURE_TILE_TIP =
  "How many cells of the tenants read so far are configured in Azure (green), measured not configured or " +
  "configured differently from the plan (red), or could not be told (unknown). Tenants not read yet are not counted.";

const CRIBL_TILE_TIP =
  "How many cells of the tenants read so far have a Cribl source this app created and Cribl still lists (green), " +
  "have none or one Cribl no longer has (red), or could not be told (unknown). A source created in Cribl by hand " +
  "is not counted, and neither is one an earlier app version recorded but this one has not adopted: where this app " +
  "holds no record of its own for that source the cell is unknown, and where it does the cell keeps the colour of " +
  "its own record. Tenants not read yet are not counted.";

const NO_SESSION =
  "This build cannot read tenants: it has no tenant session to put each tenant's credential in the Azure slot.";
const NO_PACING = "This build cannot read tenants: it has no shared request budget to pace Azure reads with.";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stamp(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

const EARLIER_RUN = "An earlier read is still finishing. Reads can start again once it has.";

function Indicator(props: { side: "azure" | "cribl"; indicator: GapIndicator; sourceId: string; where: string }) {
  const { side, indicator, sourceId, where } = props;
  const word = side === "azure" ? AZURE_WORD[indicator.state] : CRIBL_WORD[indicator.state];
  const label = side === "azure" ? "Azure" : "Cribl";
  return (
    <span className={`tgap-ind tgap-${indicator.state}`} data-side={side} data-state={indicator.state} data-source={sourceId}>
      <span className="tgap-dot" aria-hidden="true" />
      <span className="tgap-word">{`${label}: ${word}`}</span>
      <InfoTip text={indicator.reason} label={`${where}, ${label}: why`} />
    </span>
  );
}

const NOT_READ: GapIndicator = { state: "unknown", reason: NOT_READ_REASON };

export function TenantGapScreen({ profiles, cache, session, pacing, now = () => Date.now() }: TenantGapScreenProps) {
  const { ports } = usePorts();
  const store = ports.kvDocuments;
  const logger = ports.logger;
  // Seeded from the cache only: no read on mount.
  const [entries, setEntries] = useState<Readonly<Record<string, TenantGapEntry>>>(() => {
    const out: Record<string, TenantGapEntry> = {};
    for (const p of profiles) {
      const e = cache.get(p);
      if (e !== null) out[p.id] = e;
    }
    return out;
  });
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // A read started on an earlier visit and still running (seeded on mount).
  const [earlierRun, setEarlierRun] = useState<boolean>(() => cache.inFlight() !== null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  // Wait out an earlier visit's read, then show what it cached. Mount only:
  // a later run is this screen's own.
  const mountProfiles = useRef(profiles);
  useEffect(() => {
    const pending = cache.inFlight();
    if (pending === null) return;
    let live = true;
    void pending.then(() => {
      if (!live) return;
      const out: Record<string, TenantGapEntry> = {};
      for (const p of mountProfiles.current) {
        const e = cache.get(p);
        if (e !== null) out[p.id] = e;
      }
      setEntries(out);
      setEarlierRun(false);
    });
    return () => {
      live = false;
    };
  }, [cache]);

  const blocked = session === undefined ? NO_SESSION : pacing === undefined ? NO_PACING : store === undefined ? "This build cannot read tenants: it has no app storage to read their plans from." : null;
  const running = progress !== null || earlierRun;

  const read = useCallback(
    async (targets: readonly (TenantGapProfile & { readonly name: string })[]) => {
      if (session === undefined || pacing === undefined || store === undefined || targets.length === 0) return;
      if (cache.inFlight() !== null) return;
      const controller = new AbortController();
      abort.current = controller;
      setMessage(null);
      // One Cribl listing per worker group for the whole run.
      const criblInputs = new Map<string, Promise<ExistingRead>>();
      // ONE pacer for the whole run: its cap spans every tenant, and it also
      // spends the app-wide shared budget.
      const pacer = createRequestPacer({ ...pacing, maxRequestsPerMinute: VALIDATE_REQUESTS_PER_MINUTE });
      let interrupted: string | null = null;
      const run = async (): Promise<void> => {
      try {
        for (let index = 0; index < targets.length; index++) {
          if (controller.signal.aborted) break;
          const profile = targets[index]!;
          setProgress({ index, total: targets.length, name: profile.name, done: 0, reads: 0 });
          let row: TenantGapRow;
          try {
            row = await scanTenantGap(
              { session, documents: store, cribl: ports.cribl, pacer, ...(logger !== undefined ? { logger } : {}) },
              profile,
              {
                signal: controller.signal,
                criblInputs,
                onProgress: (done, reads) =>
                  setProgress({ index, total: targets.length, name: profile.name, done, reads }),
              },
            );
          } catch (error) {
            // The usecase never rejects; if it does, the row is unknown, not dropped.
            setMessage(`${profile.name} could not be read: ${errorText(error)}`);
            continue;
          }
          if (row.cancelled) interrupted = profile.name;
          // The cache keeps an earlier complete answer over a cancelled one.
          cache.set({ row, readAt: now() });
          const kept = cache.get(profile);
          if (kept !== null) setEntries((prev) => ({ ...prev, [profile.id]: kept }));
          logger?.info("tenant-gap: tenant read", { status: row.status.state, cancelled: row.cancelled });
        }
        if (controller.signal.aborted) {
          setMessage(
            interrupted === null
              ? "Reading was cancelled; tenants not reached keep their earlier answer."
              : `Reading was cancelled while reading ${interrupted}; ${interrupted} and the tenants not reached keep their earlier answer, if they had one.`,
          );
        }
      } finally {
        if (abort.current === controller) abort.current = null;
        setProgress(null);
        setCancelling(false);
      }
      };
      const inFlight = run();
      cache.track(inFlight);
      await inFlight;
    },
    [session, pacing, store, ports.cribl, logger, cache, now],
  );

  const readRows = profiles.map((p) => entries[p.id]?.row).filter((r): r is TenantGapRow => r !== undefined);
  const azureCounts = stateCounts(readRows, "azure");
  const criblCounts = stateCounts(readRows, "cribl");
  const tile = (counts: Readonly<Record<"green" | "red" | "unknown", number>>) =>
    `${counts.green} green, ${counts.red} red, ${counts.unknown} unknown`;

  return (
    <section className="panel tgap-screen">
      <h2 className="panel-title">
        Native logging gaps by tenant <InfoTip text={PANEL_TIP} />
      </h2>
      <p className="panel-desc">
        Read each tenant to see which Azure native logging sources are set up in Azure and onboarded to Cribl.
      </p>
      <div className="panel-controls">
        <button
          type="button"
          className="next-action-button"
          disabled={blocked !== null || running || profiles.length === 0}
          onClick={() => void read(profiles)}
        >
          Read all tenants
        </button>
        <InfoTip text={READ_ALL_TIP} />
        {progress !== null && (
          <button
            type="button"
            className="run-button"
            disabled={cancelling}
            onClick={() => {
              setCancelling(true);
              abort.current?.abort();
            }}
          >
            {cancelling ? "Cancelling..." : "Cancel"}
          </button>
        )}
      </div>
      {blocked !== null && <p className="field-hint" role="alert">{blocked}</p>}
      {earlierRun && <p className="field-hint">{EARLIER_RUN}</p>}
      {progress !== null && (
        <p className="field-hint" aria-live="polite">
          {progressLine(progress)}
        </p>
      )}
      {message !== null && <p className="field-hint">{message}</p>}
      {profiles.length === 0 && (
        <p className="field-hint">No Azure connections yet. Add one per tenant on Setup.</p>
      )}
      <div className="tgap-tiles">
        <div className="tgap-tile">
          <span className="tgap-tile-label">
            Configured in Azure <InfoTip text={AZURE_TILE_TIP} />
          </span>
          <span className="tgap-tile-value">{readRows.length === 0 ? "No tenant read yet" : tile(azureCounts)}</span>
        </div>
        <div className="tgap-tile">
          <span className="tgap-tile-label">
            Onboarded to Cribl <InfoTip text={CRIBL_TILE_TIP} />
          </span>
          <span className="tgap-tile-value">{readRows.length === 0 ? "No tenant read yet" : tile(criblCounts)}</span>
        </div>
      </div>
      <div className="tgap-scroll">
        <table className="tgap-grid">
          <thead>
            <tr>
              <th scope="col">Tenant</th>
              {GAP_SOURCES.map((s) => (
                <th key={s.id} scope="col">
                  {s.title}{" "}
                  <InfoTip
                    label={`${s.title}: how it reaches Cribl`}
                    text={
                      s.transport === "eventhub"
                        ? `Leaves Azure through an Event Hub; Cribl receives it with an Event Hub source.`
                        : `Written to a storage account; Cribl reads it with an Azure Blob source.`
                    }
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => {
              const entry = entries[p.id];
              const row = entry?.row;
              return (
                <tr key={p.id} data-profile={p.id}>
                  <th scope="row" className="tgap-tenant">
                    <span className="tgap-tenant-name">{p.name}</span>
                    <span className="tgap-tenant-id">{p.config.tenantId.trim() === "" ? "no tenant id" : p.config.tenantId}</span>
                    <span className="tgap-tenant-status">
                      {entry === undefined ? "Not read yet" : `Read at ${stamp(entry.readAt)}`}
                      {row !== undefined && <InfoTip text={row.status.reason} label={`${p.name}: how it was read`} />}
                    </span>
                    {row?.warnings.map((w) => (
                      <span key={w} className="tgap-warning">
                        {w}
                      </span>
                    ))}
                    <button
                      type="button"
                      className="run-button"
                      aria-label={`Read ${p.name}`}
                      disabled={blocked !== null || running}
                      onClick={() => void read([p])}
                    >
                      Read
                    </button>
                  </th>
                  {GAP_SOURCES.map((s) => {
                    const cell = row?.cells.find((c) => c.sourceId === s.id);
                    return (
                      <td key={s.id} className="tgap-cell">
                        <Indicator side="azure" sourceId={s.id} where={`${p.name}, ${s.title}`} indicator={cell?.azure ?? NOT_READ} />
                        <Indicator side="cribl" sourceId={s.id} where={`${p.name}, ${s.title}`} indicator={cell?.cribl ?? NOT_READ} />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
