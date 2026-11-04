/**
 * TenantCriblMappingSection - which Cribl Stream worker group receives each
 * Azure tenant's sources (AZR-64, ADR 0009 decision 5). Lives on the Setup
 * page beside the connection sections, because a tenant IS a connection
 * profile there.
 *
 * The operator chooses one of two shapes: one worker group for every tenant,
 * or a worker group per tenant. Nothing is chosen by default and nothing is
 * guessed: until a mode and a group are saved, the onboarding screen falls
 * back to its own picker and says it did.
 *
 *   - MOUNT makes exactly ONE kvDocuments load (the mapping) and no Cribl
 *     call. Worker groups are listed only on "Load worker groups".
 *   - SAVE IS EXPLICIT, and only after an absent or readable load of OUR
 *     document. A failed read and a foreign or newer document disable every
 *     control: a failed read is not a first run.
 *   - ONE ROW PER TENANT, not per connection: two connections for one tenant
 *     share a group, like every other tenant-scoped fact (ADR 0009 decision 3).
 *   - Both modes' choices are kept, so switching mode and back loses nothing.
 *
 * The whole document is written on Save; another tab's save in between is
 * replaced (the KV store has no compare-and-swap).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  TENANT_CRIBL_MAPPING_KEY,
  encodeTenantCriblMapping,
  mappingTenants,
  readTenantCriblMapping,
  withMappingMode,
  withSharedGroup,
  withTenantGroup,
} from "@soc/core";
import type { CriblGroupSummary, TenantCriblMapping, TenantCriblMappingRead, TenantCriblMode } from "@soc/core";
import { usePorts } from "../../ports-context";
import { InfoTip } from "../../components/info-tip";
import { SearchableSelect } from "../../components/searchable-select";
import type { SelectOption } from "../../components/searchable-select";
import { WorkerGroupField } from "../../components/worker-group-field";
import { useStreamWorkerGroups } from "../../components/worker-group-listing";

export interface TenantCriblMappingSectionProps {
  /** The connection profiles; each distinct tenant id among them is one row. */
  readonly profiles: readonly { readonly name: string; readonly config: { readonly tenantId: string } }[];
}

const SECTION_TIP =
  "Choose where each Azure tenant's sources land in Cribl Stream: one worker group that receives every tenant, " +
  "or a worker group per tenant. The Azure onboarding screen creates each tenant's Cribl source in, and watches " +
  "its data flow from, the group chosen here. Until a group is chosen for a tenant, that screen uses the group " +
  "picked on it and says so. Nothing is chosen for you.";

const MODE_OPTIONS: readonly SelectOption[] = [
  { value: "shared", label: "One worker group for every tenant" },
  { value: "per-tenant", label: "A worker group per tenant" },
];

const LOADING_TEXT = "Reading the tenant to Cribl mapping...";
const SHELL_GAP_REASON = "this build of the app has no storage for it";

type LoadState = "loading" | TenantCriblMappingRead;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The listed groups, plus a saved one the listing does not contain (named as such). */
function groupOptions(groups: readonly CriblGroupSummary[], saved: string | null): SelectOption[] {
  const options = groups.map((g) => ({ value: g.id, label: g.id }));
  if (saved !== null && !groups.some((g) => g.id === saved)) {
    options.push({ value: saved, label: `${saved} (not in the listing)` });
  }
  return options;
}

/**
 * A toned line, styled like the onboarding screen's own lines for the same
 * mapping, so a failure here looks like one there: error tone, announced.
 */
function Banner({ tone, children }: { tone: "info" | "error"; children: string }) {
  return (
    <p
      className={`azure-onboarding-banner azure-onboarding-banner-${tone}`}
      role={tone === "error" ? "alert" : undefined}
    >
      {children}
    </p>
  );
}

export function TenantCriblMappingSection({ profiles }: TenantCriblMappingSectionProps) {
  const { ports } = usePorts();
  const store = ports.kvDocuments;
  const logger = ports.logger;
  const workerGroups = useStreamWorkerGroups(ports.cribl, { auto: false, ...(logger === undefined ? {} : { logger }) });

  const [load, setLoad] = useState<LoadState>(
    store === undefined ? { kind: "unknown", reason: SHELL_GAP_REASON } : "loading",
  );
  const [mapping, setMapping] = useState<TenantCriblMapping | null>(null);
  // The mapping on screen right now, read by save() after its await.
  const latest = useRef<TenantCriblMapping | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (store === undefined) return;
    let cancelled = false;
    void store
      .load(TENANT_CRIBL_MAPPING_KEY)
      .then(readTenantCriblMapping, (error: unknown): TenantCriblMappingRead => ({
        kind: "unknown",
        reason: errorText(error),
      }))
      .then((next) => {
        if (cancelled) return;
        setLoad(next);
        const m = next.kind === "read" ? next.mapping : null;
        latest.current = m;
        setMapping(m);
        setDirty(false);
        logger?.info("tenant-cribl-mapping: loaded", { load: next.kind });
      });
    return () => {
      cancelled = true;
    };
  }, [store, logger]);

  const { tenants, withoutTenant } = useMemo(() => mappingTenants(profiles), [profiles]);
  const editable = load !== "loading" && load.kind === "read" && mapping !== null;
  const canSave = editable && dirty && !saving;

  function edit(next: TenantCriblMapping): void {
    latest.current = next;
    setMapping(next);
    setDirty(true);
    setMessage(null);
  }

  async function save(): Promise<void> {
    if (!canSave || store === undefined || mapping === null) return;
    const written = mapping;
    setSaving(true);
    try {
      await store.save(TENANT_CRIBL_MAPPING_KEY, encodeTenantCriblMapping(written));
      const unchanged = latest.current === written;
      if (unchanged) setDirty(false);
      setMessage({
        tone: "info",
        text: unchanged ? "Mapping saved." : "The earlier mapping was saved; the changes made since are not saved yet.",
      });
      logger?.info("tenant-cribl-mapping: saved", { mode: written.mode ?? "unset" });
    } catch (error) {
      const text = errorText(error);
      setMessage({ tone: "error", text: `The mapping was not saved - ${text}` });
      logger?.warn("tenant-cribl-mapping: save failed", { error: text });
    } finally {
      setSaving(false);
    }
  }

  const mode = mapping?.mode ?? null;

  // True once at least one Stream worker group is listed, so a picker can show.
  const groupsListed =
    workerGroups.state.kind === "loaded" && workerGroups.state.groups.stream.kind === "rows";

  /**
   * One group picker once groups are listed; until then - idle, loading, a
   * refused or empty listing - the SAVED value as text beside the listing's
   * own state. An unread or permission-filtered listing never hides a mapping
   * that was read: the onboarding screen still routes the tenant to it.
   */
  function groupPicker(label: string, saved: string | null, onChange: (g: string | null) => void) {
    const savedText = saved === null ? "No group chosen." : `Saved: ${saved}.`;
    return (
      <label className="field">
        <span className="field-label">{label}</span>
        {!groupsListed && (
          <span className="field-hint">
            {workerGroups.state.kind === "idle" ? `${savedText} Load worker groups to change it.` : savedText}
          </span>
        )}
        <WorkerGroupField state={workerGroups.state} onRetry={workerGroups.reload}>
          {(groups) => (
            <SearchableSelect
              label={label}
              placeholder="Choose a worker group"
              clearLabel="None"
              value={saved ?? ""}
              disabled={!editable}
              options={groupOptions(groups, saved)}
              onChange={(g) => onChange(g === "" ? null : g)}
            />
          )}
        </WorkerGroupField>
      </label>
    );
  }

  return (
    <section className="panel">
      <h2 className="panel-title">
        Tenant to Cribl mapping <InfoTip text={SECTION_TIP} />
      </h2>
      <p className="panel-desc">
        Which Cribl Stream worker group receives each Azure tenant: one group for every tenant, or a group per
        tenant. Each tenant is a connection above.
      </p>
      {load === "loading" && <p className="field-hint">{LOADING_TEXT}</p>}
      {load !== "loading" && load.kind === "unknown" && (
        <Banner tone="error">
          {`The tenant to Cribl mapping could not be read - ${load.reason}. Nothing here can be changed until it can be read, so a mapping that may exist is never overwritten.`}
        </Banner>
      )}
      <div className="panel-controls">
        <label className="field">
          <span className="field-label">Mapping mode</span>
          <SearchableSelect
            label="Mapping mode"
            placeholder="Not chosen"
            clearLabel="Not chosen"
            value={mode ?? ""}
            disabled={!editable}
            options={MODE_OPTIONS}
            onChange={(v) => {
              if (mapping === null) return;
              edit(withMappingMode(mapping, v === "" ? null : (v as TenantCriblMode)));
            }}
          />
        </label>
        {mode !== null && (
          <button type="button" className="run-button" disabled={!editable} onClick={workerGroups.reload}>
            {workerGroups.state.kind === "idle" ? "Load worker groups" : "Reload worker groups"}
          </button>
        )}
      </div>
      {mode === null && editable && (
        <p className="field-hint">
          No mode is chosen, so the Azure onboarding screen uses the worker group picked on it for every tenant.
        </p>
      )}
      {mode === "shared" &&
        mapping !== null &&
        groupPicker("Worker group for every tenant", mapping.sharedGroup, (g) => edit(withSharedGroup(mapping, g)))}
      {mode === "per-tenant" && mapping !== null && (
        <>
          {tenants.length === 0 && <p className="field-hint">No connection has a tenant id yet.</p>}
          {tenants.map((t) =>
            <div key={t.tenantId}>
              {groupPicker(
                `Worker group for ${t.names.join(", ")} (${t.tenantId})`,
                mapping.groups[t.tenantId] ?? null,
                (g) => edit(withTenantGroup(mapping, t.tenantId, g)),
              )}
            </div>,
          )}
        </>
      )}
      {withoutTenant.length > 0 && (
        <p className="field-hint">{`Connections with no tenant id cannot be mapped yet: ${withoutTenant.join(", ")}.`}</p>
      )}
      <div className="panel-controls">
        <button type="button" className="next-action-button" disabled={!canSave} onClick={() => void save()}>
          {saving ? "Saving..." : "Save mapping"}
        </button>
        {dirty && !saving && <span className="field-hint">Unsaved changes.</span>}
      </div>
      {message !== null && <Banner tone={message.tone}>{message.text}</Banner>}
    </section>
  );
}
