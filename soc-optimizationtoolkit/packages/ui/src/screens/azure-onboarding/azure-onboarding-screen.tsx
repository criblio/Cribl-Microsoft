/**
 * AzureOnboardingScreen - Azure Native Source Onboarding (AZR-18). Every
 * Azure-native source the coverage catalog knows, grouped by how it is
 * collected, with the one that can be deployed today - the Defender for Cloud
 * alert export - working end to end, and every other row visible with its
 * control disabled and the reason beside it.
 *
 * A THIN COMPOSER. Every decision lives in azure-onboarding-state.ts (pure,
 * unit-tested) and in @soc/core; this file wires them to the ports:
 *
 *   - MOUNT makes exactly ONE kvDocuments.load of the saved selection, guarded
 *     by a cancelled flag, and ZERO Azure calls. Nothing is read from Azure
 *     until the operator asks (Find namespaces, Read Defender state, Load
 *     resource groups), because each read spends the shared proxy budget.
 *   - SAVE IS EXPLICIT. Only after an `absent` load or a readable document of
 *     ours, and only when the operator changed something (canSave). A read
 *     that FAILED, a foreign document and one this release cannot read all
 *     block it - overwriting would replace a selection this screen never saw.
 *     A shell that wires no kvDocuments is a visible gap with Save disabled,
 *     never a silent first run. A toggle made while a save is in flight
 *     keeps the screen dirty: Save clears "Unsaved changes." only when the
 *     selection it wrote is still the one on screen.
 *   - ROWS come from buildSections over the loaded selection and the last
 *     Defender read. A row whose deployment state could not be read says so
 *     rather than "Not selected".
 *   - Unbuilt sections render as coming-soon with their rows in
 *     NumberedSection's notBuiltBody, every checkbox disabled; the sources
 *     that cannot stream render as an informational reference section.
 *
 * Logging goes through ports.logger with the `azure-onboarding:` prefix and
 * never carries a secret (no key ever reaches this screen).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { COVERAGE_SELECTION_KEY, encodeSelection } from "@soc/core";
import type {
  CoverageSelection,
  DefenderState,
  OnboardingItemId,
  SectionStatus,
} from "@soc/core";
import { usePorts } from "../../ports-context";
import { NumberedSection } from "../../components/numbered-section";
import {
  DEFENDER_ITEM_ID,
  buildSections,
  canSave,
  loadBanners,
  loadStateFrom,
  loadedSelection,
  withItem,
} from "./azure-onboarding-state";
import type {
  OnboardingLoadState,
  OnboardingRowView,
  OnboardingSectionView,
  PickerMessage,
} from "./azure-onboarding-state";
import { EventHubPrerequisiteSection, PickerLine } from "./eventhub-prerequisite-section";
import type { EventHubTarget } from "./eventhub-prerequisite-section";
import { DefenderExportSection } from "./defender-export-section";

/** Shown when the shell wires no document store: a wiring gap, not a first run. */
export const SHELL_GAP_MESSAGE =
  "This build of the app has no storage for the onboarding selection, so it cannot be loaded or saved. Saving is turned off.";

const SECTION_TIPS: Readonly<Record<OnboardingSectionView["key"], string>> = {
  "built-in-policy":
    "Azure Policy assigns diagnostic settings across many resource types at once. Deploying these initiatives from here is not available yet.",
  "custom-initiative":
    "A community-maintained policy initiative that covers resource types the built-in one does not. Deploying it from here is not available yet.",
  script:
    "Sources configured directly, without a policy. The Defender for Cloud alert export can be deployed from here; the others are shown for completeness.",
  "guided-portal":
    "The Defender XDR streaming export is finished in the Microsoft Defender portal. Guidance for it is not available here yet.",
  none: "Sources that cannot stream to an Event Hub at all, with what to use instead. Nothing here is deployed.",
};

/** No Event Hub chosen yet. The choice is React state only; it is not persisted. */
const EMPTY_EVENTHUB_TARGET: EventHubTarget = { namespace: null, hubName: "", rule: null };

const NOT_BUILT_NOTE = "These sources are shown so you can see the full picture. They cannot be deployed from here yet.";

const PAGE_TIP =
  "Choose which Azure-native sources should send to Cribl Stream through an Event Hub, then deploy the ones that are available. Your selection is saved only when you choose Save.";

function sectionStatus(view: OnboardingSectionView): SectionStatus {
  if (view.availability === "available") return "available";
  if (view.availability === "reference") return "informational";
  return "coming-soon";
}

export function AzureOnboardingScreen() {
  const { ports } = usePorts();
  const store = ports.kvDocuments;
  const logger = ports.logger;

  const [load, setLoad] = useState<OnboardingLoadState>({ status: "loading" });
  const [selection, setSelection] = useState<CoverageSelection | null>(null);
  // The selection on screen right now, read by save() after its await: the
  // `selection` it captured at the start is stale if a row was toggled since.
  const latestSelection = useRef<CoverageSelection | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<PickerMessage | null>(null);
  const [target, setTarget] = useState<EventHubTarget>(EMPTY_EVENTHUB_TARGET);
  const [defenderState, setDefenderState] = useState<DefenderState | null>(null);

  useEffect(() => {
    if (store === undefined) return;
    let cancelled = false;
    void store
      .load(COVERAGE_SELECTION_KEY)
      .then(loadStateFrom, (error: unknown): OnboardingLoadState => ({
        // The port promises never to reject; if one does, it is a failed read,
        // and a failed read must block Save, never pass as a first run.
        status: "read-unknown",
        reason: error instanceof Error ? error.message : String(error),
      }))
      .then((next) => {
        if (cancelled) return;
        setLoad(next);
        const loadedSel = loadedSelection(next);
        latestSelection.current = loadedSel;
        setSelection(loadedSel);
        setDirty(false);
        logger?.info("azure-onboarding: selection loaded", { load: next.status });
      });
    return () => {
      cancelled = true;
    };
  }, [store, logger]);

  const unknown = useMemo(() => {
    const map = new Map<OnboardingItemId, string>();
    if (defenderState?.unknownReason !== undefined) {
      map.set(DEFENDER_ITEM_ID, defenderState.unknownReason);
    }
    return map;
  }, [defenderState]);
  const sections = useMemo(
    () => buildSections(selection, defenderState?.deployed ?? null, unknown),
    [selection, defenderState, unknown],
  );

  const saveAllowed = store !== undefined && selection !== null && canSave(load, { dirty, saving });

  function toggle(id: OnboardingItemId, ticked: boolean): void {
    if (selection === null) return;
    const next = withItem(selection, id, ticked);
    if (next === selection) return;
    latestSelection.current = next;
    setSelection(next);
    setDirty(true);
    setSaveMessage(null);
    // Unticking changes the selection only; nothing is removed from Azure.
    logger?.info("azure-onboarding: item toggled", { item: id, ticked });
  }

  async function save(): Promise<void> {
    if (!saveAllowed || store === undefined || selection === null) return;
    const written = selection;
    setSaving(true);
    try {
      await store.save(COVERAGE_SELECTION_KEY, JSON.parse(encodeSelection(written)) as unknown);
      setLoad({ status: "ready", decoded: { selection: written, dropped: [], usedDefaults: false } });
      // A row toggled while the save was in flight is NOT in the stored
      // document, so the screen stays dirty and Save stays enabled for it.
      // withItem returns a new object on every change, so reference equality
      // is exactly "nothing was toggled since".
      const unchanged = latestSelection.current === written;
      if (unchanged) setDirty(false);
      setSaveMessage({
        tone: "info",
        text: unchanged
          ? "Selection saved."
          : "The earlier selection was saved; the changes made since are not saved yet.",
      });
      logger?.info("azure-onboarding: selection saved", {
        enabled: written.enabled.length,
        changedSince: !unchanged,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSaveMessage({ tone: "error", text: `The selection was not saved - ${message}` });
      logger?.warn("azure-onboarding: selection save failed", { error: message });
    } finally {
      setSaving(false);
    }
  }

  const banners = store === undefined ? [] : loadBanners(load);

  return (
    <div className="panel azure-onboarding">
      <h2 className="panel-title">Azure Native Source Onboarding</h2>
      <p className="panel-desc">
        Send Azure-native security sources to Cribl Stream through an Event Hub. Choose the Event
        Hub first, then tick and deploy the sources that are available. Sources that cannot be
        deployed from here yet are listed with their checkboxes turned off.
      </p>

      {store === undefined && <PickerLine message={{ tone: "error", text: SHELL_GAP_MESSAGE }} />}
      {store !== undefined && load.status === "loading" && (
        <p className="field-hint">Loading the saved selection...</p>
      )}
      {banners.map((b) => (
        <PickerLine key={b.text} message={b} />
      ))}

      <div className="panel-controls">
        <button
          type="button"
          className="next-action-button"
          disabled={!saveAllowed}
          onClick={() => void save()}
        >
          {saving ? "Saving..." : "Save selection"}
        </button>
        {dirty && !saving && <span className="field-hint">Unsaved changes.</span>}
      </div>
      {saveMessage !== null && <PickerLine message={saveMessage} />}
      <p className="field-hint">{PAGE_TIP}</p>

      <EventHubPrerequisiteSection number={1} value={target} onChange={setTarget} />

      {sections.map((view, index) => {
        const status = sectionStatus(view);
        const rows = <OnboardingRows rows={view.rows} onToggle={toggle} />;
        return (
          <NumberedSection
            key={view.key}
            number={index + 2}
            title={view.title}
            status={status}
            infoTip={SECTION_TIPS[view.key]}
            reason={status === "coming-soon" ? NOT_BUILT_NOTE : undefined}
            notBuiltBody={status === "coming-soon" ? rows : undefined}
          >
            {rows}
            {view.rows.some((r) => r.kind === "item" && r.id === DEFENDER_ITEM_ID) && (
              <DefenderExportSection
                selection={selection}
                target={target}
                state={defenderState}
                onState={setDefenderState}
              />
            )}
          </NumberedSection>
        );
      })}
    </div>
  );
}

function OnboardingRows({
  rows,
  onToggle,
}: {
  rows: readonly OnboardingRowView[];
  onToggle: (id: OnboardingItemId, ticked: boolean) => void;
}) {
  return (
    <ul className="azure-onboarding-rows">
      {rows.map((row) => {
        if (row.kind === "unsupported") {
          return (
            <li key={row.id} className="azure-onboarding-row">
              <span className="field-label">{row.title}</span>
              <span className="field-hint">{row.description}</span>
              <span className="field-hint">{`Instead: ${row.alternative}`}</span>
            </li>
          );
        }
        if (row.kind === "xdr-tables") {
          return (
            <li key={row.id} className="azure-onboarding-row">
              <span className="field-label">{row.title}</span>
              <span className="field-hint">{row.tables.join(", ")}</span>
              <span className="field-hint">{row.reason}</span>
            </li>
          );
        }
        return (
          <li key={row.id} className="azure-onboarding-row">
            <label className="integrate-check">
              <input
                type="checkbox"
                aria-label={row.title}
                checked={row.selected}
                disabled={!row.tickable}
                onChange={(e) => onToggle(row.id, e.target.checked)}
              />
              <span className="integrate-check-text">{row.title}</span>
            </label>
            <span className="field-hint">{row.description}</span>
            <span className={`azure-onboarding-state azure-onboarding-state-${row.state}`}>
              {row.label}
            </span>
            {row.availability.status === "not-built" && (
              <span className="field-hint">{row.availability.reason}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
