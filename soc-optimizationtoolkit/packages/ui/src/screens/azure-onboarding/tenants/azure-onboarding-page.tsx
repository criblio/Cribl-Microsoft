/**
 * AzureOnboardingPage - Azure Native Source Onboarding with the tenant gap
 * grid folded in (AZR-147, ADR 0009 decision 6 amendment 2026-11-19).
 *
 *   1. ALL TENANTS (collapsible, collapsed by default; opened by the old
 *      `tenant-gaps` route): the tenant gap grid, moved unchanged
 *      (screens/tenant-gap). Its read, cancel, lease and slot (AZR-90),
 *      keyboard (AZR-91) and honesty rules are its own. Collapsing HIDES it
 *      rather than unmounting it, so a running Read all is not cancelled by a
 *      click on the section header.
 *   2. FOCUS HERE: the ACTIVE tenant's red sources, from its latest read.
 *   3. The onboarding screen itself, keyed on the active connection as before,
 *      given the active tenant's gap sources for the chooser's badges and a
 *      jump request when the operator follows a gap.
 *
 * FOLLOWING A GAP. An Open link (or a click in a cell) for the ACTIVE tenant
 * scrolls to and focuses that source's row in Choose what to onboard. For
 * another tenant a confirm naming the tenant and the source comes first; then
 * Setup's own switch (`onSwitchConnection`, the shell's handleSelectProfile)
 * moves the app to that connection and the jump happens once the screen has
 * loaded for it. Never without the confirm, and refused with the reason while
 * a Read all, the shell's credential slot (`slotBusyReason`) or another tab's
 * credential lease (read only when the operator confirms) holds the slot, or
 * while a change on this page is running (operation-busy.ts: the screen's
 * write flows report themselves for their whole run). A Cancel or a new Open
 * while the lease is read drops the earlier confirm's switch, and the switch
 * calls the shell's CURRENT handler, so it never runs on a stale profile store.
 * A confirm whose connection is deleted or re-pointed, or whose active
 * connection changed, is dropped with the reason as soon as the page sees it
 * (review round 3). The confirm is scrolled into view and its Switch and open
 * focused when it appears; Cancel returns focus to the Open that raised it.
 *
 * MOUNT READS: the onboarding screen's own KV loads, plus ONE load of the
 * saved gap reads (use-saved-gap-reads). No Azure, Graph or Cribl call.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CREDENTIAL_LEASE_KEY, GAP_SOURCES, gapSourceIds, leaseHeldByOther } from "@soc/core";
import type { LeaseVerdict, OnboardingSourceId, TenantGapProfile, TenantSession } from "@soc/core";
import { usePorts } from "../../../ports-context";
import { InfoTip } from "../../../components/info-tip";
import { TenantGapScreen } from "../../tenant-gap/tenant-gap-screen";
import type { TenantGapCache } from "../../tenant-gap/tenant-gap-state";
import { AzureOnboardingScreen } from "../azure-onboarding-screen";
import { OperationBusyContext, createOperationBusyRegistry } from "../operation-busy";
import type { AzureOnboardingScreenProps } from "../azure-onboarding-screen";
import { FocusSummary } from "./focus-summary";
import {
  SWITCH_CONSEQUENCE,
  SWITCH_REFUSED_ACTIVE_CHANGED,
  SWITCH_REFUSED_READ_ALL,
  SWITCH_UNAVAILABLE,
  switchConfirmText,
  switchRefusedLease,
  switchRefusedOperation,
  switchRefusedSlot,
  switchRefusedTarget,
} from "./tenant-switch";
import { useSavedGapReads } from "./use-saved-gap-reads";

type PageProfile = TenantGapProfile & { readonly name: string };

export interface AzureOnboardingPageProps extends AzureOnboardingScreenProps {
  /** Every connection profile; one grid row each. */
  readonly profiles: readonly PageProfile[];
  /** The active connection's id. */
  readonly activeProfileId: string | null;
  /** The shell's app-lifetime tenant gap cache. */
  readonly tenantGapCache: TenantGapCache;
  /** Reads one tenant at a time through the shared credential. Without it, reads are disabled. */
  readonly tenantSession?: TenantSession;
  /** Setup's own connection switch. Absent: an Open on another tenant says to switch on Setup. */
  readonly onSwitchConnection?: (profileId: string) => void;
  /** Why the shell's Azure credential slot cannot change hands now, or null. */
  readonly slotBusyReason?: () => string | null;
  /** This tab's credential-lease holder id; without it the lease is not read before a switch. */
  readonly leaseHolderId?: string;
  /** Changes whenever the shell is asked to open All tenants (the old tenant-gaps route). */
  readonly openAllTenantsSignal?: number;
  /** Epoch ms now; Date.now by default. */
  readonly now?: () => number;
}

export const ALL_TENANTS_TIP =
  "Every Azure connection against every Azure native logging source: whether each is set up in Azure as its plan " +
  "says, and whether this app created a Cribl source for it that Cribl still has. Each tenant's latest read is saved, " +
  "with its time, so it is here after a reload. Open on a cell goes to that source on this page; for another tenant " +
  "it asks before switching the active connection.";

const ALL_TENANTS_BODY_ID = "azo-all-tenants-body";

interface PendingSwitch {
  readonly profile: PageProfile;
  readonly sourceId: OnboardingSourceId;
  /** The connection active when the confirm opened: the switch is dropped if it changed meanwhile. */
  readonly fromProfileId: string | null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Why the confirm no longer names a connection it can switch to, or null (review round 3). */
function targetChange(pending: PendingSwitch, profiles: readonly PageProfile[]): "gone" | "repointed" | null {
  const now = profiles.find((p) => p.id === pending.profile.id);
  if (now === undefined) return "gone";
  return now.config.tenantId === pending.profile.config.tenantId ? null : "repointed";
}

export function AzureOnboardingPage({
  profiles,
  activeProfileId,
  tenantGapCache: cache,
  tenantSession,
  onSwitchConnection,
  slotBusyReason,
  leaseHolderId,
  openAllTenantsSignal = 0,
  now = () => Date.now(),
  ...screenProps
}: AzureOnboardingPageProps) {
  const { ports } = usePorts();
  const store = ports.kvDocuments;
  const saved = useSavedGapReads(store, cache, profiles, ports.logger);
  useSyncExternalStore(cache.subscribe, cache.version);

  const [open, setOpen] = useState(openAllTenantsSignal > 0);
  const disclosure = useRef<HTMLButtonElement>(null);
  // The old route asked for All tenants: open it, each time it asks.
  const seenSignal = useRef(openAllTenantsSignal);
  useEffect(() => {
    if (openAllTenantsSignal === seenSignal.current) return;
    seenSignal.current = openAllTenantsSignal;
    setOpen(true);
  }, [openAllTenantsSignal]);

  const [confirming, setConfirming] = useState<PendingSwitch | null>(null);
  const [switchMessage, setSwitchMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // The jump the screen performs once it has loaded for the right connection.
  const [jump, setJump] = useState<{ readonly profileId: string; readonly sourceId: OnboardingSourceId; readonly seq: number } | null>(null);
  const jumpSeq = useRef(0);
  // Bumped by every new confirm, Cancel and switch check: a check that awaited
  // the lease acts only if it is still the latest (review round 1).
  const confirmSeq = useRef(0);
  // The write flows of the screen below report here for their whole run.
  const [busy] = useState(createOperationBusyRegistry);
  // The latest props, for code that runs after an await: a render closure
  // would hold the shell's switch (and its profile store) from the click.
  const latest = useRef({ onSwitchConnection, slotBusyReason, activeProfileId, profiles });
  latest.current = { onSwitchConnection, slotBusyReason, activeProfileId, profiles };
  // The confirm's controls, and what raised it, for focus (review round 3).
  const confirmGroupRef = useRef<HTMLDivElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  const activeProfile = profiles.find((p) => p.id === activeProfileId) ?? null;
  const activeEntry = activeProfile === null ? null : cache.get(activeProfile);

  const requestJump = useCallback((profileId: string, sourceId: OnboardingSourceId) => {
    jumpSeq.current += 1;
    setJump({ profileId, sourceId, seq: jumpSeq.current });
  }, []);

  const onJumped = useCallback((seq: number) => {
    setJump((j) => (j !== null && j.seq === seq ? null : j));
  }, []);

  const dropConfirm = () => {
    confirmSeq.current += 1;
    setChecking(false);
  };

  /** Give focus back to the Open that raised the confirm, when it is still on the page. */
  const returnFocus = () => {
    const el = opener.current;
    opener.current = null;
    if (el !== null && el.isConnected) el.focus({ preventScroll: true });
  };

  // A confirm on screen must still name a connection it can switch to: drop it,
  // with the reason, the moment the active connection changes or its own is
  // deleted or re-pointed - an A-to-B-to-A round trip included (review round 3).
  useEffect(() => {
    if (confirming === null) return;
    let message: string | null = null;
    if (activeProfileId !== confirming.fromProfileId) message = SWITCH_REFUSED_ACTIVE_CHANGED;
    else {
      const change = targetChange(confirming, profiles);
      if (change !== null) message = switchRefusedTarget(confirming.profile.name, change);
    }
    if (message === null) return;
    confirmSeq.current += 1;
    setChecking(false);
    setConfirming(null);
    setSwitchMessage(message);
    returnFocus();
  }, [confirming, profiles, activeProfileId]);

  // Bring a new confirm to the operator: it renders above the grid, so a click
  // low in the grid would otherwise seem to do nothing (review round 3).
  useEffect(() => {
    if (confirming === null) return;
    const group = confirmGroupRef.current;
    if (group !== null && typeof group.scrollIntoView === "function") group.scrollIntoView({ block: "nearest", behavior: "smooth" });
    confirmButtonRef.current?.focus({ preventScroll: true });
  }, [confirming]);

  const onOpen = useCallback(
    (profile: PageProfile, sourceId: OnboardingSourceId) => {
      setSwitchMessage(null);
      confirmSeq.current += 1;
      setChecking(false);
      if (profile.id === activeProfileId) {
        setConfirming(null);
        requestJump(profile.id, sourceId);
        return;
      }
      if (onSwitchConnection === undefined) {
        setConfirming(null);
        setSwitchMessage(SWITCH_UNAVAILABLE);
        return;
      }
      // Keep the first opener when a new Open replaces a confirm on screen.
      if (opener.current === null || !opener.current.isConnected) {
        const active = document.activeElement;
        opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
      }
      setConfirming({ profile, sourceId, fromProfileId: activeProfileId });
    },
    [activeProfileId, onSwitchConnection, requestJump],
  );

  /** Why the slot cannot change hands right now, or null. Checked again after every await. */
  const slotRefusal = useCallback((): string | null => {
    const running = busy.current();
    if (running !== null) return switchRefusedOperation(running);
    if (cache.inFlight() !== null) return SWITCH_REFUSED_READ_ALL;
    const slot = latest.current.slotBusyReason?.() ?? null;
    return slot === null ? null : switchRefusedSlot(slot);
  }, [busy, cache]);

  const confirmSwitch = async (pending: PendingSwitch): Promise<void> => {
    if (onSwitchConnection === undefined) return;
    confirmSeq.current += 1;
    const mine = confirmSeq.current;
    /** False once a Cancel, a new Open or a later check has replaced this one. */
    const current = () => confirmSeq.current === mine;
    setChecking(true);
    try {
      const before = slotRefusal();
      if (before !== null) {
        setSwitchMessage(before);
        return;
      }
      if (store !== undefined && leaseHolderId !== undefined) {
        let verdict: LeaseVerdict;
        try {
          verdict = leaseHeldByOther(await store.load(CREDENTIAL_LEASE_KEY), leaseHolderId, now());
        } catch (error) {
          verdict = { held: "unknown", reason: errorText(error) };
        }
        if (!current()) return;
        const leased = switchRefusedLease(verdict);
        if (leased !== null) {
          setSwitchMessage(leased);
          return;
        }
      }
      // A read or write may have started while the lease was read.
      const after = slotRefusal();
      if (after !== null) {
        setSwitchMessage(after);
        return;
      }
      // The connection bar may have switched meanwhile.
      if (latest.current.activeProfileId !== pending.fromProfileId) {
        setConfirming(null);
        setSwitchMessage(SWITCH_REFUSED_ACTIVE_CHANGED);
        return;
      }
      // Its connection may have been deleted or re-pointed meanwhile.
      const change = targetChange(pending, latest.current.profiles);
      if (change !== null) {
        setConfirming(null);
        setSwitchMessage(switchRefusedTarget(pending.profile.name, change));
        return;
      }
      const doSwitch = latest.current.onSwitchConnection;
      if (doSwitch === undefined) {
        setConfirming(null);
        setSwitchMessage(SWITCH_UNAVAILABLE);
        return;
      }
      setConfirming(null);
      opener.current = null;
      ports.logger?.info("azure-onboarding: active connection switched from All tenants", {});
      doSwitch(pending.profile.id);
      requestJump(pending.profile.id, pending.sourceId);
    } finally {
      if (current()) setChecking(false);
    }
  };

  const sourceTitle = (id: OnboardingSourceId) => GAP_SOURCES.find((s) => s.id === id)?.title ?? id;
  // The jump goes to the screen only once it is the target connection's.
  const screenJump = jump !== null && jump.profileId === activeProfileId ? { sourceId: jump.sourceId, seq: jump.seq } : null;

  return (
    <>
      <section className="panel azo-all-tenants" aria-labelledby="azo-all-tenants-title">
        <h3 className="panel-title azo-all-tenants-head" id="azo-all-tenants-title">
          <button
            ref={disclosure}
            type="button"
            className="azo-disclosure"
            aria-expanded={open}
            aria-controls={ALL_TENANTS_BODY_ID}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "Hide all tenants" : "Show all tenants"}
          </button>
          <span>All tenants</span>
          <InfoTip text={ALL_TENANTS_TIP} label="All tenants: what it shows" />
        </h3>
        {saved.note !== null && <p className="field-hint">{saved.note}</p>}
        {confirming !== null && (
          <div
            ref={confirmGroupRef}
            className="azure-onboarding-confirm"
            role="group"
            aria-label="Confirm switching the active tenant"
          >
            <p className="panel-desc">{switchConfirmText(confirming.profile.name, sourceTitle(confirming.sourceId))}</p>
            <p className="field-hint">{SWITCH_CONSEQUENCE}</p>
            <div className="panel-controls">
              <button
                ref={confirmButtonRef}
                type="button"
                className="next-action-button"
                disabled={checking}
                onClick={() => void confirmSwitch(confirming)}
              >
                {checking ? "Checking..." : "Switch and open"}
              </button>
              <button
                type="button"
                className="run-button"
                onClick={() => {
                  dropConfirm();
                  setConfirming(null);
                  setSwitchMessage(null);
                  returnFocus();
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {switchMessage !== null && (
          <p className="field-hint" role="alert">
            {switchMessage}
          </p>
        )}
        <div id={ALL_TENANTS_BODY_ID} hidden={!open}>
          <TenantGapScreen
            profiles={profiles}
            cache={cache}
            {...(tenantSession !== undefined ? { session: tenantSession } : {})}
            {...(screenProps.pacing !== undefined ? { pacing: screenProps.pacing } : {})}
            now={now}
            activeProfileId={activeProfileId}
            onOpen={onOpen}
            onRead={saved.save}
          />
        </div>
      </section>

      <FocusSummary
        tenantName={activeProfile?.name ?? null}
        entry={activeEntry}
        savedReads={saved.state}
        now={now}
        onJump={(sourceId) => {
          if (activeProfileId !== null) requestJump(activeProfileId, sourceId);
        }}
        onOpenAllTenants={() => {
          setOpen(true);
          // Bring the section into view, focus on its header control.
          const head = disclosure.current;
          if (head !== null) {
            if (typeof head.scrollIntoView === "function") head.scrollIntoView({ block: "start", behavior: "smooth" });
            head.focus({ preventScroll: true });
          }
        }}
      />

      <OperationBusyContext.Provider value={busy}>
        <AzureOnboardingScreen
          key={`azure-onboarding-${activeProfileId ?? "none"}`}
          {...screenProps}
          gapSources={gapSourceIds(activeEntry?.row ?? null)}
          jumpTo={screenJump}
          onJumped={onJumped}
        />
      </OperationBusyContext.Provider>
    </>
  );
}
