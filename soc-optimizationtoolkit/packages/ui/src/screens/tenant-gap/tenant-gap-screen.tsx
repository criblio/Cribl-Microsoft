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
 *     wait for room at once and sends nothing more. The run is ONE
 *     tenant-session batch (AZR-90): the slot swaps tenant to tenant and the
 *     active credential is restored once at the end, not after every tenant.
 *     Without a session or the shell's pacing the reads are disabled with the
 *     reason - nothing goes out unpaced.
 *   - ANSWERS ARE CACHED per tenant with their time, in a cache the shell
 *     owns, so coming back to the screen does not read again. A cancelled
 *     read never replaces an earlier complete answer. The read in flight is
 *     tracked there too, so a screen remounted mid-read waits for it instead
 *     of starting a second run that would collide with the first's lease.
 *   - The colours and words come from @soc/core (domain/tenant-gap); this file
 *     only lays them out.
 *
 * WHERE IT LIVES (AZR-147, ADR 0009 decision 6 amendment 2026-11-19). The
 * grid is no longer a page of its own: it is the "All tenants" section at the
 * top of Azure Native Source Onboarding (azure-onboarding/tenants/), moved
 * as it was. The page adds three things through props, none of which changes
 * the rules above: the ACTIVE connection's row is highlighted (`activeProfileId`);
 * with `onOpen`, each cell gains an Open link, a third stop in the roving
 * tabindex, that asks the page to show that source (switching the active
 * connection first, after a confirm, when the row is another tenant's); and
 * with `onRead`, every complete answer this grid reads is handed to the page,
 * which saves it per tenant in the app KV store. Saved answers come back
 * through the cache (TenantGapCache.seed), so this file still loads nothing.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FocusEvent, KeyboardEvent } from "react";
import { GAP_SOURCES, NOT_READ_REASON, createRequestPacer, scanTenantGap } from "@soc/core";
import type {
  BatchPacing,
  ExistingRead,
  GapIndicator,
  OnboardingSourceId,
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
  moveGridFocus,
  progressLine,
  readAgeText,
  type GridPos,
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
  /** The active connection's id: its row is highlighted and named as active (AZR-147). */
  readonly activeProfileId?: string | null;
  /**
   * Show `sourceId` on the page for this connection (AZR-147). Present, every
   * cell gains an Open link; the page decides whether a confirm comes first.
   */
  readonly onOpen?: (profile: TenantGapProfile & { readonly name: string }, sourceId: OnboardingSourceId) => void;
  /** Told of every COMPLETE answer this grid reads, so the page can save it (AZR-147). */
  readonly onRead?: (entry: TenantGapEntry) => void;
}

const PANEL_TIP =
  "One row per Azure connection, one column per Azure native logging source. In each cell, Azure says whether " +
  "that tenant's Azure side is set up as its onboarding plan says (read through that tenant's own connection), " +
  "and Cribl says whether this app created a Cribl source for it that Cribl still has. Green and red are " +
  "measured; unknown means a read was refused, not run, or not proven to be that tenant's. Hover or tap the (i) " +
  "beside each indicator for its reason.";

const READ_ALL_TIP =
  `Reads every tenant in turn, never two at once: each one's credential is put in the app's single Azure slot, ` +
  `proven to be that tenant's before and after it is used, and the active connection's credential is put back ` +
  `once, when the run ends - also when it is cancelled or a tenant fails. Azure reads go at most ` +
  `${VALIDATE_REQUESTS_PER_MINUTE} a minute for the whole run, counting each tenant's proof reads and sign-ins, ` +
  `inside the budget every screen shares. While it runs the slot is this run's: Azure reads from other ` +
  `screens of this tab wait until the run ends, and a notice above every screen says so. Nothing in Azure ` +
  "or Cribl is changed. Each tenant needs its client secret entered in this session.";

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

/** The run's one restore failed: the operator's own connection is not back. */
export const RESTORE_FAILED =
  "The active connection's credential could not be put back after reading. Save and connect on Setup before using other screens.";

/**
 * The shell-wide notice while a Read all holds the Azure slot (AZR-90). The
 * grid lives in the All tenants section of Azure Native Source Onboarding
 * (AZR-147), and the app keeps a visited screen MOUNTED when the operator
 * moves to another, so leaving does NOT cancel the read: it runs until it ends
 * or is cancelled there (AZR-148 - the earlier wording said leaving cancels it,
 * which the keep-alive frame made untrue).
 */
export const TENANT_READ_IN_FLIGHT =
  "A tenant gap read is running or finishing. From the first tenant it reads through Azure until it ends, it holds " +
  "the app's Azure credential slot, and Azure reads on every screen of this tab wait. It keeps running when you " +
  "move to another screen; Cancel in the All tenants section of Azure Native Source Onboarding stops it. The slot " +
  "frees once its current request returns and the active connection's credential is back.";

/**
 * The shell's notice while a Read all is in flight, on whatever screen is
 * showing: the run holds the slot's exclusive section for every tenant, so
 * another screen's Azure reads would otherwise spin with no reason given.
 */
export function TenantReadInFlightNotice({ cache }: { readonly cache: TenantGapCache }) {
  const running = useSyncExternalStore(cache.subscribe, () => cache.inFlight() !== null);
  return running ? (
    <p className="connection-notice" role="status">
      {TENANT_READ_IN_FLIGHT}
    </p>
  ) : null;
}

// Shown only after the grid was UNMOUNTED mid-read - the unmount abort did
// cancel that run, so this sentence holds (AZR-148 is about the shell notice,
// which shows while the grid is merely hidden).
const EARLIER_RUN =
  "An earlier read is still finishing: leaving this screen cancelled it, and it stops once its current request " +
  "returns and the active connection's credential is back. Reads can start again once it has.";

/** Id of the hidden line that tells a keyboard user how to move between the grid's tips. */
const GRID_HINT_ID = "tgap-grid-keys";
const GRID_HINT =
  "Arrow keys move between indicators, Home and End to the first and last in the row, Control with Home or End to " +
  "the first and last in the grid. Enter or Space shows or hides the reason.";
/** The same hint when each cell also has an Open link (AZR-147). */
const GRID_HINT_WITH_OPEN =
  "Arrow keys move between indicators and Open links, Home and End to the first and last in the row, Control with " +
  "Home or End to the first and last in the grid. Enter or Space shows or hides a reason, or follows an Open link.";

/** Per source: the Azure tip, the Cribl tip, and (with onOpen) the Open link. */
function stopsPerSource(withOpen: boolean): number {
  return withOpen ? 3 : 2;
}

/** The roving element at a grid position: a tip, or an Open link. */
function rovingAt(body: HTMLElement | null, pos: GridPos): HTMLElement | null {
  const cell = body?.querySelector<HTMLElement>(`[data-row="${pos.row}"][data-col="${pos.col}"]`) ?? null;
  return cell?.querySelector<HTMLElement>('[role="button"], button') ?? null;
}

/** Whether an element is one of the grid's roving stops. */
function isRovingStop(el: HTMLElement): boolean {
  return el.getAttribute("role") === "button" || el.tagName === "BUTTON";
}

function Indicator(props: {
  side: "azure" | "cribl";
  indicator: GapIndicator;
  sourceId: string;
  where: string;
  pos: GridPos;
  /** True for the one indicator holding the grid's tab stop. */
  stop: boolean;
}) {
  const { side, indicator, sourceId, where, pos, stop } = props;
  const word = side === "azure" ? AZURE_WORD[indicator.state] : CRIBL_WORD[indicator.state];
  const label = side === "azure" ? "Azure" : "Cribl";
  return (
    <span
      className={`tgap-ind tgap-${indicator.state}`}
      data-side={side}
      data-state={indicator.state}
      data-source={sourceId}
      data-row={pos.row}
      data-col={pos.col}
    >
      <span className="tgap-dot" aria-hidden="true" />
      <span className="tgap-word">{`${label}: ${word}`}</span>
      {/* The tip is the cell's only focusable part, so its name carries the
        * state word: arrowing onto it must say what the cell shows. */}
      <InfoTip
        text={indicator.reason}
        label={`${where}, ${label}: ${word}, why`}
        tabIndex={stop ? 0 : -1}
        describedBy={GRID_HINT_ID}
      />
    </span>
  );
}

const NOT_READ: GapIndicator = { state: "unknown", reason: NOT_READ_REASON };

export function TenantGapScreen({
  profiles,
  cache,
  session,
  pacing,
  now = () => Date.now(),
  activeProfileId = null,
  onOpen,
  onRead,
}: TenantGapScreenProps) {
  const { ports } = usePorts();
  const store = ports.kvDocuments;
  const logger = ports.logger;
  // Read from the cache on every change of it: no read on mount, and a saved
  // answer the page seeds after its one KV load shows up without a copy here.
  useSyncExternalStore(cache.subscribe, cache.version);
  const entries: Readonly<Record<string, TenantGapEntry>> = {};
  for (const p of profiles) {
    const e = cache.get(p);
    if (e !== null) (entries as Record<string, TenantGapEntry>)[p.id] = e;
  }
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // A read started on an earlier visit and still running (seeded on mount).
  const [earlierRun, setEarlierRun] = useState<boolean>(() => cache.inFlight() !== null);
  const abort = useRef<AbortController | null>(null);
  // The grid's ONE tab stop (AZR-91): a roving tabindex over the indicator
  // tips, so a keyboard user does not pass two stops per cell to reach the
  // next tenant's Read button.
  const [stop, setStop] = useState<GridPos>({ row: 0, col: 0 });
  const gridBody = useRef<HTMLTableSectionElement>(null);
  const perSource = stopsPerSource(onOpen !== undefined);
  const gridCols = GAP_SOURCES.length * perSource;
  const stopAt: GridPos = {
    row: Math.min(stop.row, Math.max(0, profiles.length - 1)),
    col: Math.min(stop.col, gridCols - 1),
  };
  const tipAt = (pos: GridPos): HTMLElement | null => rovingAt(gridBody.current, pos);
  const posOf = (target: EventTarget): GridPos | null => {
    if (!(target instanceof HTMLElement) || !isRovingStop(target)) return null;
    const ind = target.closest<HTMLElement>("[data-col]");
    if (ind === null) return null;
    return { row: Number(ind.dataset.row), col: Number(ind.dataset.col) };
  };
  const onGridKeyDown = (event: KeyboardEvent<HTMLTableSectionElement>) => {
    const from = posOf(event.target);
    if (from === null) return;
    const to = moveGridFocus(from, event.key, event.ctrlKey || event.metaKey, profiles.length, gridCols);
    if (to === null) return;
    event.preventDefault();
    setStop(to);
    tipAt(to)?.focus();
  };
  // A click or a programmatic focus on any tip moves the stop there too.
  const onGridFocus = (event: FocusEvent<HTMLTableSectionElement>) => {
    const at = posOf(event.target);
    if (at !== null && (at.row !== stop.row || at.col !== stop.col)) setStop(at);
  };

  useEffect(() => () => abort.current?.abort(), []);

  // Wait out an earlier visit's read, then show what it cached. Mount only:
  // a later run is this screen's own.
  useEffect(() => {
    const pending = cache.inFlight();
    if (pending === null) return;
    let live = true;
    // What it cached shows through the cache subscription above.
    void pending.then(() => {
      if (!live) return;
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
      // Every tenant of the run inside ONE batch (AZR-90): the slot swaps
      // tenant to tenant and the active credential goes back once, at the end
      // - also when a tenant fails half-way or the run is cancelled.
      const scanAll = async (batch: Pick<TenantSession, "runForTenant">): Promise<void> => {
        for (let index = 0; index < targets.length; index++) {
          if (controller.signal.aborted) break;
          const profile = targets[index]!;
          setProgress({ index, total: targets.length, name: profile.name, done: 0, reads: 0 });
          let row: TenantGapRow;
          try {
            row = await scanTenantGap(
              { session: batch, documents: store, cribl: ports.cribl, pacer, ...(logger !== undefined ? { logger } : {}) },
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
          // AZR-147: a COMPLETE answer goes to the page to be saved per tenant;
          // a cancelled one is never saved.
          const kept = cache.get(profile);
          if (kept !== null && kept.row === row && !row.cancelled) onRead?.(kept);
          logger?.info("tenant-gap: tenant read", { status: row.status.state, cancelled: row.cancelled });
        }
      };
      const run = async (): Promise<void> => {
      try {
        let restoreFailed: string | null = null;
        try {
          const batch = await session.runBatch(scanAll, { pacer });
          if (batch.restore.kind === "failed") restoreFailed = batch.restore.reason;
        } catch (error) {
          // scanAll catches each tenant's failure, so this is unexpected; the
          // batch has already put the active credential back by now.
          setMessage(`Reading stopped: ${errorText(error)}`);
        }
        const notes: string[] = [];
        if (controller.signal.aborted) {
          notes.push(
            interrupted === null
              ? "Reading was cancelled; tenants not reached keep their earlier answer."
              : `Reading was cancelled while reading ${interrupted}; ${interrupted} and the tenants not reached keep their earlier answer, if they had one.`,
          );
        }
        if (restoreFailed !== null) notes.push(`${RESTORE_FAILED} (${restoreFailed})`);
        if (notes.length > 0) setMessage(notes.join(" "));
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
    [session, pacing, store, ports.cribl, logger, cache, now, onRead],
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
      <p id={GRID_HINT_ID} hidden>
        {onOpen === undefined ? GRID_HINT : GRID_HINT_WITH_OPEN}
      </p>
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
          <tbody ref={gridBody} onKeyDown={onGridKeyDown} onFocus={onGridFocus}>
            {profiles.map((p, rowIndex) => {
              const entry = entries[p.id];
              const row = entry?.row;
              const active = activeProfileId !== null && p.id === activeProfileId;
              return (
                <tr
                  key={p.id}
                  data-profile={p.id}
                  data-active={active ? "true" : undefined}
                  className={active ? "tgap-row-active" : undefined}
                >
                  <th scope="row" className="tgap-tenant">
                    <span className="tgap-tenant-name">{p.name}</span>
                    {/* A word, not the highlight alone, says which row is active. */}
                    {active && <span className="tgap-active-tag">Active connection</span>}
                    <span className="tgap-tenant-id">{p.config.tenantId.trim() === "" ? "no tenant id" : p.config.tenantId}</span>
                    <span className="tgap-tenant-status">
                      {entry === undefined ? "Not read yet" : `Read at ${stamp(entry.readAt)}, ${readAgeText(entry.readAt, now())}`}
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
                  {GAP_SOURCES.map((s, sourceIndex) => {
                    const cell = row?.cells.find((c) => c.sourceId === s.id);
                    const where = `${p.name}, ${s.title}`;
                    const pos = (side: 0 | 1 | 2): GridPos => ({ row: rowIndex, col: sourceIndex * perSource + side });
                    const isStop = (side: 0 | 1 | 2) =>
                      stopAt.row === rowIndex && stopAt.col === sourceIndex * perSource + side;
                    return (
                      <td
                        key={s.id}
                        className={onOpen === undefined ? "tgap-cell" : "tgap-cell tgap-cell-open"}
                        // A click anywhere in the cell but a tip or the link
                        // follows the link (AZR-147: "click a gap cell").
                        onClick={
                          onOpen === undefined
                            ? undefined
                            : (event) => {
                                const t = event.target;
                                if (t instanceof HTMLElement && t.closest('[role="button"], button') !== null) return;
                                onOpen(p, s.id);
                              }
                        }
                      >
                        <Indicator side="azure" sourceId={s.id} where={where} indicator={cell?.azure ?? NOT_READ} pos={pos(0)} stop={isStop(0)} />
                        <Indicator side="cribl" sourceId={s.id} where={where} indicator={cell?.cribl ?? NOT_READ} pos={pos(1)} stop={isStop(1)} />
                        {onOpen !== undefined && (
                          <span className="tgap-open" data-row={pos(2).row} data-col={pos(2).col} data-source={s.id}>
                            <button
                              type="button"
                              className="link-button"
                              tabIndex={isStop(2) ? 0 : -1}
                              aria-describedby={GRID_HINT_ID}
                              aria-label={
                                active ? `Open ${s.title} on this page` : `Switch to ${p.name} and open ${s.title}`
                              }
                              onClick={() => onOpen(p, s.id)}
                            >
                              Open
                            </button>
                          </span>
                        )}
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
