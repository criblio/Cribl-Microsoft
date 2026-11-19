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
 * credential lease (read only when the operator confirms) holds the slot.
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
import type { AzureOnboardingScreenProps } from "../azure-onboarding-screen";
import { FocusSummary } from "./focus-summary";
import {
  SWITCH_CONSEQUENCE,
  SWITCH_REFUSED_READ_ALL,
  SWITCH_UNAVAILABLE,
  switchConfirmText,
  switchRefusedLease,
  switchRefusedSlot,
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
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  const activeProfile = profiles.find((p) => p.id === activeProfileId) ?? null;
  const activeEntry = activeProfile === null ? null : cache.get(activeProfile);

  const requestJump = useCallback((profileId: string, sourceId: OnboardingSourceId) => {
    jumpSeq.current += 1;
    setJump({ profileId, sourceId, seq: jumpSeq.current });
  }, []);

  const onOpen = useCallback(
    (profile: PageProfile, sourceId: OnboardingSourceId) => {
      setSwitchMessage(null);
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
      setConfirming({ profile, sourceId });
    },
    [activeProfileId, onSwitchConnection, requestJump],
  );

  /** Why the slot cannot change hands right now, or null. Checked again after every await. */
  const slotRefusal = useCallback((): string | null => {
    if (cache.inFlight() !== null) return SWITCH_REFUSED_READ_ALL;
    const busy = slotBusyReason?.() ?? null;
    return busy === null ? null : switchRefusedSlot(busy);
  }, [cache, slotBusyReason]);

  const confirmSwitch = async (pending: PendingSwitch): Promise<void> => {
    if (onSwitchConnection === undefined) return;
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
      setConfirming(null);
      ports.logger?.info("azure-onboarding: active connection switched from All tenants", {});
      onSwitchConnection(pending.profile.id);
      requestJump(pending.profile.id, pending.sourceId);
    } finally {
      setChecking(false);
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
          <div className="azure-onboarding-confirm" role="group" aria-label="Confirm switching the active tenant">
            <p className="panel-desc">{switchConfirmText(confirming.profile.name, sourceTitle(confirming.sourceId))}</p>
            <p className="field-hint">{SWITCH_CONSEQUENCE}</p>
            <div className="panel-controls">
              <button
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
                  setConfirming(null);
                  setSwitchMessage(null);
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
        now={now()}
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

      <AzureOnboardingScreen
        key={`azure-onboarding-${activeProfileId ?? "none"}`}
        {...screenProps}
        gapSources={gapSourceIds(activeEntry?.row ?? null)}
        jumpTo={screenJump}
      />
    </>
  );
}
